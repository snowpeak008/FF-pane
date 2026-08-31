/**
 * 知识库层装配（T6.5）：把索引库、向量后端、嵌入器、导入编排接成契约化的
 * `knowledge:*` handlers，并把导入进度推到窗口。
 *
 * 作用域是**全局**（§10.1：知识库与索引都在 `~/.aiworkbench` 下），故本层的
 * 请求一律不带 projectRoot——它与 habits 一样是跨项目共享的资产。
 *
 * 几处装配上的决定：
 *
 * 1. **索引库连接在装配期开一次、常驻**。better-sqlite3 是同步的，每次请求开关连接
 *    既慢又会把 sqlite-vec 的加载重做一遍；而知识库是单进程单写者，没有共享争用。
 *
 * 2. **向量索引句柄放在本层闭包里，不放进每轮导入**。它的规格（后端/维度/模型）是
 *    全库唯一的事实，两轮导入拿两个句柄就有机会各建各的。
 *
 * 3. **嵌入器每次用时现解析，不缓存**。用户随时可能在设置页改 Provider / 换嵌入模型 /
 *    换密钥；缓存住的嵌入器会让「改完之后还得重启」成为一个需要解释的行为。
 *    解析本身只是读两个 JSON 加一次解密，代价远小于它带来的困惑。
 *
 * 4. **导入的取消登记在 importId 上**。渲染层生成 importId 并贯穿进度事件与取消请求，
 *    与会话层的 turnId 同一套路数。
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Embedder } from "@ff-pane/rag";
import { SUPPORTED_EXTENSIONS } from "@ff-pane/rag";
import type {
  KnowledgeChunkId,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeFormat,
  KnowledgeOrigin,
} from "@ff-pane/shared";
import {
  createProviderStore,
  deleteKnowledgeEntry,
  dropVectorIndex,
  ensureVectorIndex,
  getKnowledgeEntry,
  getKnowledgeStats,
  initGlobalLayout,
  listEntryChunkRowids,
  listEntryChunks,
  listKnowledgeEntries,
  loadVectorExtension,
  openIndexDb,
  openVectorIndex,
  readVectorState,
  searchKnowledge,
  type VectorIndex,
} from "@ff-pane/storage";
import type Database from "better-sqlite3";
import { type BrowserWindow, dialog } from "electron";
import type {
  KnowledgeEmbeddingStatus,
  KnowledgeEntryView,
  KnowledgeHitView,
  KnowledgeImportProgressEvent,
  KnowledgeImportReport,
  KnowledgeVectorStatus,
} from "../../shared-ipc/contracts";
import { type InvokeHandlers, publishEvent } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import { resolveKnowledgeEmbedder } from "./embedder";
import { entriesToMarkdown, type KnowledgeExportItem } from "./export";
import {
  entrySourcePath,
  type IngestDeps,
  isRebuildable,
  joinNotePath,
  mergeReports,
  runIngest,
  runNoteIngest,
} from "./ingest";
import { collectImportFiles } from "./scan";

export * from "./embedder";
export * from "./export";
export * from "./ingest";
export * from "./scan";

/** 本层负责的 invoke 通道集合。 */
type KnowledgeChannel =
  | "knowledge:list"
  | "knowledge:pick-paths"
  | "knowledge:import"
  | "knowledge:rebuild"
  | "knowledge:cancel-import"
  | "knowledge:create-entry"
  | "knowledge:search"
  | "knowledge:remove-entry"
  | "knowledge:export";

/** 事件推送目标窗口取值器（窗口在装配后才创建，且可能已关闭，故惰性取用）。 */
export type KnowledgeWindowGetter = () => BrowserWindow | null;

/** 检索时上下文扩展的块数（前后各取一块，§8.3.4）。 */
const CONTEXT_RADIUS = 1;

/** 装配知识库 handlers。在 app.whenReady 之后、注册窗口之前调用一次。 */
export async function createKnowledgeHandlers(
  getWindow: KnowledgeWindowGetter,
): Promise<Pick<InvokeHandlers, KnowledgeChannel>> {
  const layout = await initGlobalLayout(resolveGlobalRoot());
  const db: Database.Database = openIndexDb({ filePath: layout.indexDbFile });
  const providers = createProviderStore(layout.providersFile);
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });

  // sqlite-vec 装不上不是失败：退路后端（普通表 + JS 余弦）跑同一套用例（T6.4 / R2）
  const extension = await loadVectorExtension(db);
  const extensionLoaded = extension.ok;
  if (!extensionLoaded) {
    console.log(`[knowledge] sqlite-vec unavailable, using fallback backend: ${extension.reason}`);
  }
  const desiredBackend = extensionLoaded ? "vec0" : "fallback";

  // 全库唯一的向量索引句柄；未建过索引时为 undefined（纯 FTS 模式）
  let vectorIndex: VectorIndex | undefined = (() => {
    const opened = openVectorIndex(db, extensionLoaded);
    return opened.ok ? opened.index : undefined;
  })();

  /** 在飞的导入 / 重建：importId → 取消器。 */
  const inFlight = new Map<string, AbortController>();

  function emitProgress(payload: KnowledgeImportProgressEvent): void {
    const window = getWindow();
    if (window !== null) {
      publishEvent(window.webContents, "knowledge:import-progress", payload);
    }
  }

  /** 当前向量规格（用于嵌入器解析时的守卫）。 */
  function currentVectorSpec(): ReturnType<typeof readVectorState> {
    return readVectorState(db);
  }

  /** 解析当前嵌入能力（每次现解析，见模块注释第 3 条）。 */
  async function resolveEmbedding(): Promise<{
    readonly embedder?: Embedder;
    readonly status: KnowledgeEmbeddingStatus;
  }> {
    const spec = currentVectorSpec();
    return resolveKnowledgeEmbedder({
      providers: await providers.listProviders(),
      revealSecret: (ref) => secrets.revealSecret(ref),
      ...(spec === undefined ? {} : { vectorSpec: spec }),
      desiredBackend,
    });
  }

  /** 惰性建立向量索引（首条向量到手时调用）；规格冲突即抛，中止整轮。 */
  function ensureIndex(dimensions: number, model: string): VectorIndex {
    const result = ensureVectorIndex(db, { dimensions, model, extensionLoaded });
    if (!result.ok) {
      throw new Error(`vector index unavailable: ${result.reason}`);
    }
    vectorIndex = result.index;
    return result.index;
  }

  /** 组装一轮导入的注入项。 */
  function ingestDeps(signal: AbortSignal, embedder: Embedder | undefined): IngestDeps {
    return {
      db,
      getVectorIndex: () => vectorIndex,
      ensureVectorIndex: ensureIndex,
      ...(embedder === undefined ? {} : { embedder }),
      newEntryId: () => `ke-${randomUUID()}` as KnowledgeEntryId,
      newChunkId: () => `kc-${randomUUID()}` as KnowledgeChunkId,
      now: () => Date.now(),
      onProgress: (event) => emitProgress(event),
      signal,
    };
  }

  /**
   * 跑一轮导入 / 重建：登记取消器 → 展开文件 → 编排 → 注销。
   *
   * `notes` 是重建时一并处理的笔记条目（手动新建 / 会话收录）：它们的原文件在
   * `notes/` 下，但**不能混进文件清单**走同一条路——那条路一律把条目写成
   * `file_import`，重建一次就会把笔记的来源改掉、还多出一个新条目。故两者各跑各的，
   * 共用一个取消器与一份合并后的报告（对用户是一次重建）。
   */
  async function ingest(input: {
    readonly importId: string;
    readonly paths: readonly string[];
    readonly tags?: readonly string[];
    readonly force: boolean;
    readonly preExpanded?: boolean;
    readonly notes?: readonly KnowledgeEntry[];
  }): Promise<KnowledgeImportReport> {
    const controller = new AbortController();
    inFlight.set(input.importId, controller);
    try {
      let files: readonly string[];
      if (input.preExpanded === true) {
        files = input.paths;
      } else {
        emitProgress({ importId: input.importId, phase: "scanning", done: 0, total: 0 });
        const scan = await collectImportFiles(input.paths, {
          signal: controller.signal,
          onFound: (count) => {
            emitProgress({ importId: input.importId, phase: "scanning", done: count, total: 0 });
          },
        });
        if (scan.truncated) {
          console.warn(`[knowledge] import scan truncated at ${scan.files.length} files`);
        }
        files = scan.files;
      }

      const { embedder } = await resolveEmbedding();
      const deps = ingestDeps(controller.signal, embedder);
      let report = await runIngest(deps, {
        importId: input.importId,
        files,
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        force: input.force,
      });

      for (const note of input.notes ?? []) {
        if (controller.signal.aborted) {
          report = { ...report, cancelled: true };
          break;
        }
        const notePath = joinNotePath(layout.knowledgeNotesDir, note.id);
        try {
          const bytes = new Uint8Array(await readFile(notePath));
          report = mergeReports(
            report,
            await runNoteIngest(deps, {
              importId: input.importId,
              entryId: note.id,
              filePath: notePath,
              bytes,
              title: note.title,
              origin: note.origin,
              existing: note,
            }),
          );
        } catch (thrown) {
          // 笔记文件不见了（用户手工删过 notes/ 下的东西）：如实记一条失败，
          // 不连坐其余条目——与文件导入「单文件失败不中断批量」同一条纪律
          report = mergeReports(report, {
            importId: input.importId,
            scanned: 1,
            indexed: 0,
            skipped: 0,
            chunks: 0,
            embedded: 0,
            embedSkipped: 0,
            embedFailed: 0,
            failures: [
              {
                filePath: notePath,
                message: thrown instanceof Error ? thrown.message : String(thrown),
              },
            ],
            cancelled: false,
          });
        }
      }
      return report;
    } finally {
      inFlight.delete(input.importId);
    }
  }

  /**
   * 条目视图：条目 + 块数 + 已嵌入块数（§8.3.6 来源管理三列）。
   * 逐条目两次瘦查询而不是一次全量 JOIN：全量拉回来要么把块正文一起读进内存，
   * 要么让 SQL 去 JOIN vec0 虚表（那是个不该赌的行为）。条目数是万级、查询是索引点查，
   * 而来源管理页本身是低频页面。
   */
  function listEntryViews(): readonly KnowledgeEntryView[] {
    return listKnowledgeEntries(db).map((row) => {
      const rowids = listEntryChunkRowids(db, row.entry.id);
      return {
        entry: row.entry,
        chunkCount: rowids.length,
        embeddedCount: vectorIndex?.existingRowids(rowids).size ?? 0,
      };
    });
  }

  return {
    "knowledge:list": async () => {
      const stats = getKnowledgeStats(db, vectorIndex);
      const { status } = await resolveEmbedding();
      const vector: KnowledgeVectorStatus | undefined =
        vectorIndex === undefined
          ? undefined
          : {
              backend: vectorIndex.backend,
              dimensions: vectorIndex.dimensions,
              model: vectorIndex.model,
              vectors: stats.vectors,
            };
      return {
        entries: listEntryViews(),
        totalChunks: stats.chunks,
        ...(vector === undefined ? {} : { vector }),
        embedding: status,
      };
    },

    "knowledge:pick-paths": async (request) => {
      const window = getWindow();
      const options =
        request.kind === "directory"
          ? { properties: ["openDirectory" as const] }
          : {
              properties: ["openFile" as const, "multiSelections" as const],
              filters: [
                {
                  // 扩展名过滤表与解析器注册表同源：能选的一定解析得了
                  name: "Documents",
                  extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.replace(/^\./, "")),
                },
                { name: "All Files", extensions: ["*"] },
              ],
            };
      const result =
        window !== null
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true } as const;
      }
      return { cancelled: false, paths: result.filePaths } as const;
    },

    "knowledge:import": (request) =>
      ingest({
        importId: request.importId,
        paths: request.paths,
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        force: request.force ?? false,
      }),

    "knowledge:rebuild": async (request) => {
      // 换嵌入模型时必须重建向量索引：维度/模型不同的向量混在一张表里检索结果毫无意义
      if (request.resetVectors === true) {
        dropVectorIndex(db);
        vectorIndex = undefined;
      }
      // 重建的输入是「已登记条目的原文件路径」，不重新扫盘——用户重建的是库里这些东西，
      // 不是「那个目录现在有什么」（那是再导入一次的语义）
      const targets = listKnowledgeEntries(db)
        .map((row) => row.entry)
        .filter(
          (entry) =>
            isRebuildable(entry) &&
            (request.entryIds === undefined || request.entryIds.includes(entry.id)),
        );
      const files = targets
        .filter((entry) => entry.origin.kind === "file_import")
        .map((entry) => entrySourcePath(entry, layout.knowledgeNotesDir));
      const notes = targets.filter((entry) => entry.origin.kind !== "file_import");
      return ingest({
        importId: request.importId,
        paths: files,
        force: true,
        preExpanded: true,
        notes,
      });
    },

    "knowledge:create-entry": async (request) => {
      const title = request.title.trim();
      const content = request.content.trim();
      // 空标题会让来源管理页出现一行没法指认的条目；空正文会产生零个块，
      // 即一条永远检索不到的记录。两者都当场拒绝，不落一个半成品进库
      if (title === "") {
        throw new Error("knowledge: entry title must not be empty");
      }
      if (content === "") {
        throw new Error("knowledge: entry content must not be empty");
      }

      const entryId = `ke-${randomUUID()}` as KnowledgeEntryId;
      const filePath = joinNotePath(layout.knowledgeNotesDir, entryId);
      // 标题写成正文的一级标题：笔记文件要能脱离本软件独立读懂（§8.4），
      // 而一级标题正是分块器认得的结构信号（T6.2 标题树），检索出处因此带得上
      const markdown = `# ${title}\n\n${content}\n`;
      await writeFile(filePath, markdown, "utf8");

      const origin: KnowledgeOrigin =
        request.source.kind === "manual"
          ? { kind: "manual" }
          : { kind: "session_capture", sessionId: request.source.sessionId };

      const controller = new AbortController();
      inFlight.set(request.importId, controller);
      try {
        const { embedder } = await resolveEmbedding();
        const report = await runNoteIngest(ingestDeps(controller.signal, embedder), {
          importId: request.importId,
          entryId,
          filePath,
          bytes: new TextEncoder().encode(markdown),
          title,
          origin,
          ...(request.tags === undefined ? {} : { tags: request.tags }),
        });
        return { entryId, path: filePath, report };
      } finally {
        inFlight.delete(request.importId);
      }
    },

    "knowledge:cancel-import": (request) => {
      const controller = inFlight.get(request.importId);
      controller?.abort();
      return { ok: controller !== undefined };
    },

    "knowledge:search": async (request) => {
      const { embedder, status } = await resolveEmbedding();
      // 查询向量：用与建索引同一个模型编码。取不到就整条向量路缺席（退化为纯 BM25），
      // 而不是拿一个别的模型的向量去比对——那比不搜还糟
      let queryVector: readonly number[] | undefined;
      if (embedder !== undefined && vectorIndex !== undefined && request.query.trim() !== "") {
        try {
          const [vector] = await embedder.embed([request.query.trim()]);
          queryVector = vector;
        } catch (thrown) {
          console.warn(
            `[knowledge] query embedding failed, falling back to keyword-only: ${String(thrown)}`,
          );
        }
      }

      const result = searchKnowledge(db, {
        query: request.query,
        ...(queryVector === undefined ? {} : { queryVector }),
        ...(vectorIndex === undefined ? {} : { vectorIndex }),
        ...(request.filters === undefined ? {} : { filters: request.filters }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        contextBefore: CONTEXT_RADIUS,
        contextAfter: CONTEXT_RADIUS,
      });

      // 条目标题与格式不在块上，逐条目查一次并缓存（一次检索通常只涉及十几个条目）
      const entryCache = new Map<KnowledgeEntryId, KnowledgeEntry | undefined>();
      const lookup = (id: KnowledgeEntryId): KnowledgeEntry | undefined => {
        if (!entryCache.has(id)) {
          entryCache.set(id, getKnowledgeEntry(db, id));
        }
        return entryCache.get(id);
      };
      const hits: KnowledgeHitView[] = result.hits.map((hit) => {
        const entry = lookup(hit.chunk.entryId);
        return {
          chunk: hit.chunk,
          score: hit.score,
          sources: [...hit.sources],
          before: hit.before,
          after: hit.after,
          entryTitle: entry?.title ?? hit.chunk.provenance.filePath,
          entryFormat: (entry?.format ?? "text") as KnowledgeFormat,
        };
      });

      // 向量路缺席时把「为什么」一起带上：界面要能说清「当前是纯全文检索」
      const blocker = result.usedVector || status.available ? undefined : status.blocker;
      return {
        hits,
        usedFts: result.usedFts,
        usedVector: result.usedVector,
        vectorPrefilterExact: result.vectorPrefilterExact,
        ...(blocker === undefined ? {} : { embeddingBlocker: blocker }),
      };
    },

    "knowledge:remove-entry": (request) => ({
      removed: deleteKnowledgeEntry(db, request.id, vectorIndex),
    }),

    "knowledge:export": async (request) => {
      const wanted = request.entryIds.length === 0 ? undefined : new Set<string>(request.entryIds);
      const items: KnowledgeExportItem[] = listKnowledgeEntries(db)
        .map((row) => row.entry)
        .filter((entry) => wanted === undefined || wanted.has(entry.id))
        .map((entry) => ({ entry, chunks: listEntryChunks(db, entry.id) }));
      if (items.length === 0) {
        return { cancelled: true } as const;
      }

      const window = getWindow();
      const defaultPath = `knowledge-export-${new Date().toISOString().slice(0, 10)}.md`;
      const options = {
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const picked =
        window !== null
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
      if (picked.canceled || picked.filePath === undefined) {
        return { cancelled: true } as const;
      }
      await writeFile(picked.filePath, entriesToMarkdown(items), "utf8");
      return { cancelled: false, path: picked.filePath, entries: items.length } as const;
    },
  };
}
