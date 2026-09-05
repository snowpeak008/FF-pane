/**
 * 记忆语义检索服务（T8.7）：把项目级索引库、记忆向量后端、嵌入器解析与混合检索
 * 装配成 `memory:search` 通道 + 写钩子，供 data.ts 接线。
 *
 * 与知识库层（main/knowledge）的三处结构性差异：
 *
 * 1. **索引库是项目级的**（`<项目>/.workbench/index.sqlite`，§10.2），不是全局单连接。
 *    连接按项目根惰性打开、进程内缓存——记忆页每次检索都开关连接的话，
 *    sqlite-vec 的加载会被重做一遍。
 *
 * 2. **首次打开先对账（reconcile），不是重建**。此前记忆索引没有常驻维护者
 *    （W1.3b 的钩子一直没接线），索引可能落后于 Markdown 真实源；对账逐条 upsert +
 *    出清幽灵行，rowid 稳定、未变条目的向量原样保留。重建（清空重灌）会让全部
 *    向量作废重算，留作索引损坏时的兜底。
 *
 * 3. **规格失配自动重建向量索引，不要求用户手动操作**。知识库换嵌入模型要用户点
 *    「重建」，因为十万块的重算要花真金白银的时间；记忆是百级短文本，重算代价几秒，
 *    而记忆页没有（也不该有）一个「重建向量索引」按钮——失配即自动 drop + 全量回填，
 *    对用户是「换了模型，搜索照常」。
 *
 * 存量回填在检索路径上按差额进行（listMemoryRowsForEmbedding 找差额 → embedChunks
 * 批量嵌入 → 逐条落库记账）：全程异步 HTTP + 批内落库，不做同步长活，主进程不卡；
 * 单飞（single-flight）防止并发检索重复发请求。回填失败不阻断检索——当轮退化为
 * 纯关键词，下轮再补（断点续传语义，已落库的不重算）。
 */

import type { Embedder } from "@ff-pane/rag";
import { embedChunks } from "@ff-pane/rag";
import type { ApiKeyRef, MemoryEntry, MemoryEntryId, Provider } from "@ff-pane/shared";
import {
  closeIndexDb,
  dropMemoryVectorIndex,
  ensureMemoryVectorIndex,
  listMemoryRowsForEmbedding,
  loadVectorExtension,
  type MemoryEmbeddingRow,
  openIndexDb,
  openMemoryVectorIndex,
  type ProjectLayout,
  readMemoryVectorState,
  reconcileIndexFromStore,
  resolveProjectLayout,
  searchMemoryHybrid,
  storeMemoryVector,
  syncEntryDeleted,
  syncEntrySaved,
  type VectorIndex,
} from "@ff-pane/storage";
import type Database from "better-sqlite3";
import type { MemorySearchRequest, MemorySearchResponse } from "../shared-ipc/contracts";
import { resolveKnowledgeEmbedder } from "./knowledge/embedder";

/** 服务的注入项（Provider 与密钥来源与知识库共用同一配置面，不新造配置项）。 */
export interface MemoryIndexServiceDeps {
  /** 全部 Provider（嵌入能力解析用，每次现取——用户随时可能改配置）。 */
  readonly listProviders: () => Promise<readonly Provider[]>;
  /** 取明文密钥（主进程 safeStorage 解密，用完即弃，§4.3）。 */
  readonly revealSecret: (ref: ApiKeyRef) => Promise<string | undefined>;
  /** 项目布局解析；注入以便单测指向临时目录。缺省 resolveProjectLayout。 */
  readonly resolveLayout?: (projectRoot: string) => ProjectLayout;
  /** 日志出口（开发者日志一律英文）。 */
  readonly log?: (message: string) => void;
}

/** memory:search 通道 + 写钩子。写钩子永不抛——索引是派生数据，坏了由下次对账自愈。 */
export interface MemoryIndexService {
  /** 混合检索（含惰性开库、首次对账、按差额回填、查询嵌入）。 */
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  /** 条目写入/状态流转后的钩子（先写真实源成功再调，W1.3b 纪律）。 */
  entrySaved(projectRoot: string, entry: MemoryEntry): Promise<void>;
  /** 条目删除后的钩子。 */
  entryDeleted(projectRoot: string, id: MemoryEntryId): Promise<void>;
  /** 关闭全部项目连接（测试收尾用；生产随进程退出）。 */
  close(): void;
}

/** 单个项目的索引状态。 */
interface ProjectIndexState {
  readonly layout: ProjectLayout;
  readonly db: Database.Database;
  readonly extensionLoaded: boolean;
  /** 当前向量索引句柄；未建过 / 后端不可用时 undefined（纯 FTS 模式）。 */
  vectorIndex: VectorIndex | undefined;
  /** 在飞的回填（单飞）。 */
  backfill: Promise<void> | undefined;
}

/** Windows 路径大小写不敏感，键归一后缓存才对得上同一项目的两种写法。 */
function stateKey(projectRoot: string): string {
  return projectRoot.replaceAll("\\", "/").toLowerCase();
}

/** 装配记忆语义检索服务。 */
export function createMemoryIndexService(deps: MemoryIndexServiceDeps): MemoryIndexService {
  const resolveLayout = deps.resolveLayout ?? resolveProjectLayout;
  const log = deps.log ?? (() => {});
  const states = new Map<string, Promise<ProjectIndexState>>();

  async function openProject(projectRoot: string): Promise<ProjectIndexState> {
    const layout = resolveLayout(projectRoot);
    const db = openIndexDb({ filePath: layout.indexDbFile });
    try {
      const extension = await loadVectorExtension(db);
      if (!extension.ok) {
        log(`[memory-index] sqlite-vec unavailable, using fallback backend: ${extension.reason}`);
      }
      const opened = openMemoryVectorIndex(db, extension.ok);
      const state: ProjectIndexState = {
        layout,
        db,
        extensionLoaded: extension.ok,
        vectorIndex: opened.ok ? opened.index : undefined,
        backfill: undefined,
      };
      // 首次打开对账：索引此前无常驻维护者，可能落后真实源（见模块注释 2）
      const { issues } = await reconcileIndexFromStore(layout, db, state.vectorIndex);
      if (issues.length > 0) {
        log(`[memory-index] reconcile skipped ${issues.length} corrupt entries`);
      }
      return state;
    } catch (thrown) {
      closeIndexDb(db);
      throw thrown;
    }
  }

  function ensureProject(projectRoot: string): Promise<ProjectIndexState> {
    const key = stateKey(projectRoot);
    let pending = states.get(key);
    if (pending === undefined) {
      pending = openProject(projectRoot);
      // 打开失败不留半死缓存：下次调用重试
      pending.catch(() => {
        if (states.get(key) === pending) {
          states.delete(key);
        }
      });
      states.set(key, pending);
    }
    return pending;
  }

  /** 解析当前嵌入能力（与知识库同一解析器与配置面）。 */
  async function resolveEmbedding(
    state: ProjectIndexState,
  ): Promise<ReturnType<typeof resolveKnowledgeEmbedder>> {
    const spec = readMemoryVectorState(state.db);
    return resolveKnowledgeEmbedder({
      providers: await deps.listProviders(),
      revealSecret: deps.revealSecret,
      ...(spec === undefined ? {} : { vectorSpec: spec }),
      desiredBackend: state.extensionLoaded ? "vec0" : "fallback",
    });
  }

  /** 按差额回填向量（单飞）。失败只降级不抛：当轮纯关键词，下轮续传。 */
  function ensureBackfill(state: ProjectIndexState, embedder: Embedder): Promise<void> {
    if (state.backfill !== undefined) {
      return state.backfill;
    }
    const run = (async (): Promise<void> => {
      const pending = listMemoryRowsForEmbedding(state.db);
      if (pending.length === 0) {
        return;
      }
      const report = await embedChunks<MemoryEmbeddingRow>(pending, {
        embedder,
        onEmbedded: ({ chunk, vector }) => {
          // 首条向量到手才知道维度，此时才建向量表（vec0 维度在 CREATE 时固定）
          if (state.vectorIndex === undefined) {
            const ensured = ensureMemoryVectorIndex(state.db, {
              dimensions: vector.length,
              model: embedder.model,
              extensionLoaded: state.extensionLoaded,
            });
            if (!ensured.ok) {
              throw new Error(`memory vector index unavailable: ${ensured.reason}`);
            }
            state.vectorIndex = ensured.index;
          }
          storeMemoryVector(state.db, state.vectorIndex, chunk.entryRowid, vector, chunk.textHash);
        },
      });
      if (report.failed > 0 || report.fatal !== undefined) {
        log(
          `[memory-index] backfill incomplete: embedded=${report.embedded} failed=${report.failed}` +
            (report.fatal === undefined ? "" : ` fatal=${report.fatal.message}`),
        );
      }
    })();
    state.backfill = run.finally(() => {
      state.backfill = undefined;
    });
    return state.backfill;
  }

  return {
    async search(request) {
      const state = await ensureProject(request.projectRoot);
      const query = request.query.trim();
      if (query === "") {
        return { hits: [], usedFts: false, usedVector: false };
      }

      let resolution = await resolveEmbedding(state);
      // 规格失配（换嵌入模型 / 换后端）：自动重建而不是让用户面对一个没有出口的状态
      //（见模块注释 3）。drop 连带清嵌入记账 → 下方回填把全部条目按新模型重算。
      if (!resolution.status.available && resolution.status.blocker === "spec-mismatch") {
        log(`[memory-index] vector spec mismatch (${resolution.status.detail ?? ""}), rebuilding`);
        dropMemoryVectorIndex(state.db);
        state.vectorIndex = undefined;
        resolution = await resolveEmbedding(state);
      }

      let queryVector: readonly number[] | undefined;
      if (resolution.embedder !== undefined) {
        const embedder = resolution.embedder;
        try {
          await ensureBackfill(state, embedder);
          if (state.vectorIndex !== undefined) {
            const [vector] = await embedder.embed([query]);
            queryVector = vector;
          }
        } catch (thrown) {
          // 查询嵌入 / 回填失败：退化为纯关键词，不让一次嵌入端点抖动毁掉搜索框
          log(`[memory-index] query embedding failed, keyword-only: ${String(thrown)}`);
        }
      }

      const result = searchMemoryHybrid(state.db, {
        query,
        ...(request.categories === undefined ? {} : { categories: request.categories }),
        ...(request.statuses === undefined ? {} : { statuses: request.statuses }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(queryVector === undefined || state.vectorIndex === undefined
          ? {}
          : { queryVector, vectorIndex: state.vectorIndex }),
      });

      // 向量路缺席时把「为什么」带上（同 knowledge:search 口径）
      const blocker =
        result.usedVector || resolution.status.available ? undefined : resolution.status.blocker;
      return {
        hits: result.hits.map((hit) => ({
          id: hit.id,
          category: hit.category,
          status: hit.status,
          title: hit.title,
          score: hit.score,
          sources: [...hit.sources],
        })),
        usedFts: result.usedFts,
        usedVector: result.usedVector,
        ...(blocker === undefined ? {} : { embeddingBlocker: blocker }),
      };
    },

    async entrySaved(projectRoot, entry) {
      // 项目还没开过索引连接就不开：首次检索的对账会把这条捡起来
      const pending = states.get(stateKey(projectRoot));
      if (pending === undefined) {
        return;
      }
      try {
        const state = await pending;
        syncEntrySaved(state.db, entry, state.vectorIndex);
      } catch (thrown) {
        log(`[memory-index] entrySaved sync failed: ${String(thrown)}`);
      }
    },

    async entryDeleted(projectRoot, id) {
      const pending = states.get(stateKey(projectRoot));
      if (pending === undefined) {
        return;
      }
      try {
        const state = await pending;
        syncEntryDeleted(state.db, id, state.vectorIndex);
      } catch (thrown) {
        log(`[memory-index] entryDeleted sync failed: ${String(thrown)}`);
      }
    },

    close() {
      for (const pending of states.values()) {
        void pending.then((state) => closeIndexDb(state.db)).catch(() => {});
      }
      states.clear();
    },
  };
}
