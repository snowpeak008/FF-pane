/**
 * 知识库导入编排（T6.5）：把 T6.1~T6.4 四层串成一条管道
 * ——解析 → 分块 → 索引 → 嵌入——并对外只暴露「进度 + 一份报告」。
 *
 * 本模块是 Phase 6 唯一知道这四层先后关系的地方，故几处顺序上的决定写在这里：
 *
 * 1. **增量索引按「同一来源路径的内容哈希」判断，不是按全局哈希查表**。
 *    `findEntryByContentHash` 回答的是「这份内容在库里出现过吗」，而导入要回答的是
 *    「这个文件变了吗」——两者在「同一份内容存在两个路径」时会分叉：按全局哈希会把
 *    第二个路径认成已导入，于是它永远进不了库。故这里先建一张「来源路径 → 条目」表，
 *    在路径上对哈希。
 *
 * 2. **重新索引沿用原条目 ID**。文件改了一版就换一个 ID 的话，用户在来源管理里
 *    看到的是「旧的消失了、来了个新的」，标签也跟着丢；沿用 ID 则 replaceEntryChunks
 *    在单事务里完成整条替换，外部看是同一份文档更新了。
 *
 * 3. **标签取并集而不是覆盖**。标签是用户的整理成果（§8.3.4 的过滤维度），
 *    而一次重新导入只是内容变了；用导入参数覆盖等于每次重导都清一次用户的活。
 *
 * 4. **嵌入阶段的范围是「本次涉及的全部条目」，含被增量跳过的那些**。
 *    跳过意味着「内容没变、块还在」，但它的块**可能压根还没有向量**——用户刚配上
 *    嵌入模型、上一轮导入中途崩了，都是这种情形。把它们一并纳入并按向量存在性过滤，
 *    「补齐差额」与「断点续传」就是同一段代码（§8.3.2 / T6.3 的续传承诺）。
 *
 * 5. **向量索引惰性建立在第一条向量到手时**。维度由嵌入模型决定，而 vec0 虚表的维度
 *    在 CREATE 时就固定（T6.4），导入开始时无从得知——只能等第一批响应回来。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  chunkDocument,
  type EmbedChunksReport,
  type Embedder,
  embedChunks,
  parseDocument,
  toKnowledgeChunks,
} from "@ff-pane/rag";
import type {
  KnowledgeChunkId,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeOrigin,
} from "@ff-pane/shared";
import {
  type EmbeddableChunkRow,
  findEntryRowid,
  listChunkRowsForEmbedding,
  listKnowledgeEntries,
  replaceEntryChunks,
  toPosixPath,
  upsertKnowledgeEntry,
  type VectorIndex,
} from "@ff-pane/storage";
import type Database from "better-sqlite3";
import type {
  KnowledgeImportFailure,
  KnowledgeImportProgressEvent,
  KnowledgeImportReport,
} from "../../shared-ipc/contracts";

/** 编排所需的注入项（IO 与随机性全部从外面来，便于单测）。 */
export interface IngestDeps {
  readonly db: Database.Database;
  /** 当前向量索引；尚未建立时返回 undefined。 */
  readonly getVectorIndex: () => VectorIndex | undefined;
  /**
   * 按给定维度惰性建立向量索引并返回。规格冲突时抛错——
   * 抛出会经 onEmbedded 冒泡为整轮中止，那正是我们要的（不能把两种规格的向量混进一张表）。
   */
  readonly ensureVectorIndex: (dimensions: number, model: string) => VectorIndex;
  /** 嵌入器；缺席即纯 FTS 模式（§8.3.3），嵌入阶段整段跳过。 */
  readonly embedder?: Embedder;
  readonly newEntryId: () => KnowledgeEntryId;
  readonly newChunkId: () => KnowledgeChunkId;
  readonly now: () => number;
  readonly onProgress: (event: KnowledgeImportProgressEvent) => void;
  readonly signal: AbortSignal;
  /** 读原文件；注入以便单测不落盘。 */
  readonly readFileBytes?: (filePath: string) => Promise<Uint8Array>;
}

/** 一次导入 / 重建的输入。文件清单由调用方展开（见 scan.ts）。 */
export interface IngestRequest {
  readonly importId: string;
  /** 待索引的文件绝对路径（已去重排序）。 */
  readonly files: readonly string[];
  /** 本批要打的标签。 */
  readonly tags?: readonly string[];
  /** 忽略内容哈希强制重新索引。 */
  readonly force: boolean;
}

/** 内容哈希：与条目的 contentHash 同口径，带算法前缀便于日后换算法时区分。 */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 标签并集，按字典序（与 storage 读回标签的顺序一致：标签是集合，顺序不承载信息）。 */
export function mergeTags(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): readonly string[] {
  const merged = new Set<string>();
  for (const tag of [...(existing ?? []), ...(incoming ?? [])]) {
    const trimmed = tag.trim();
    if (trimmed !== "") {
      merged.add(trimmed);
    }
  }
  return [...merged].sort();
}

/** 建「来源路径 → 已有条目」索引（只含 file_import；另两种来源没有原文件可比对）。 */
function indexEntriesBySourcePath(db: Database.Database): Map<string, KnowledgeEntry> {
  const byPath = new Map<string, KnowledgeEntry>();
  for (const row of listKnowledgeEntries(db)) {
    if (row.entry.origin.kind === "file_import") {
      byPath.set(toPosixPath(row.entry.origin.sourcePath), row.entry);
    }
  }
  return byPath;
}

/** 空报告骨架（各分支就地补差异，避免每处重复列全部字段）。 */
function emptyReport(importId: string): KnowledgeImportReport {
  return {
    importId,
    scanned: 0,
    indexed: 0,
    skipped: 0,
    chunks: 0,
    embedded: 0,
    embedSkipped: 0,
    embedFailed: 0,
    failures: [],
    cancelled: false,
  };
}

/** 索引阶段的产物。 */
interface IndexPhaseResult {
  readonly indexed: number;
  readonly skipped: number;
  readonly chunks: number;
  readonly failures: readonly KnowledgeImportFailure[];
  /** 本次涉及的全部条目（含被跳过的），供嵌入阶段取块。 */
  readonly touchedEntryIds: readonly KnowledgeEntryId[];
  readonly cancelled: boolean;
}

/** 解析 → 分块 → 落库：逐文件推进，单文件失败不中断整批（同 T6.1 parseFiles 的纪律）。 */
async function runIndexPhase(deps: IngestDeps, request: IngestRequest): Promise<IndexPhaseResult> {
  const read = deps.readFileBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const byPath = indexEntriesBySourcePath(deps.db);
  const failures: KnowledgeImportFailure[] = [];
  const touched: KnowledgeEntryId[] = [];
  let indexed = 0;
  let skipped = 0;
  let chunks = 0;

  for (const [position, filePath] of request.files.entries()) {
    if (deps.signal.aborted) {
      return { indexed, skipped, chunks, failures, touchedEntryIds: touched, cancelled: true };
    }
    deps.onProgress({
      importId: request.importId,
      phase: "indexing",
      done: position,
      total: request.files.length,
      currentPath: filePath,
    });

    try {
      const bytes = await read(filePath);
      const contentHash = hashBytes(bytes);
      const existing = byPath.get(toPosixPath(filePath));

      if (existing !== undefined && existing.contentHash === contentHash && !request.force) {
        // 内容未变：块与向量原样留着，只把它纳入嵌入阶段的范围（可能还缺向量）
        skipped += 1;
        touched.push(existing.id);
        continue;
      }

      const document = await parseDocument({ filePath, bytes });
      const drafts = chunkDocument(document, { filePath });
      const entryId = existing?.id ?? deps.newEntryId();
      const origin: KnowledgeOrigin = { kind: "file_import", sourcePath: filePath };
      const tags = mergeTags(existing?.tags, request.tags);
      const entry: KnowledgeEntry = {
        id: entryId,
        title: document.title,
        format: document.format,
        origin,
        contentHash,
        // 重新索引不刷新导入时间：它是「这份资料什么时候进的知识库」，
        // 是用户用来做时间过滤（§8.3.4）的锚，不该因为重建索引整体漂移
        importedAt: existing?.importedAt ?? deps.now(),
        ...(tags.length === 0 ? {} : { tags }),
      };

      upsertKnowledgeEntry(deps.db, entry);
      const knowledgeChunks = toKnowledgeChunks(drafts, {
        entryId,
        newId: () => deps.newChunkId(),
      });
      replaceEntryChunks(
        deps.db,
        entryId,
        knowledgeChunks.map((chunk) => ({
          id: chunk.id,
          seq: chunk.seq,
          text: chunk.text,
          provenance: chunk.provenance,
        })),
        deps.getVectorIndex(),
      );

      indexed += 1;
      chunks += knowledgeChunks.length;
      touched.push(entryId);
    } catch (thrown) {
      failures.push({
        filePath,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  }

  deps.onProgress({
    importId: request.importId,
    phase: "indexing",
    done: request.files.length,
    total: request.files.length,
  });
  return { indexed, skipped, chunks, failures, touchedEntryIds: touched, cancelled: false };
}

/** 嵌入阶段的产物。 */
interface EmbedPhaseResult {
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly fatal?: string;
  readonly cancelled: boolean;
}

/** 待嵌入块 → 调度层要的最小形状（EmbeddableChunk 只要求有 text）。 */
type PendingChunk = EmbeddableChunkRow;

/**
 * 嵌入并落向量。没有嵌入器就整段不做——**不造零向量**，
 * 那会把一个显式降级变成一堆无意义的向量混进索引（§8.3.3 / T6.3 同一条纪律）。
 */
async function runEmbedPhase(
  deps: IngestDeps,
  request: IngestRequest,
  touchedEntryIds: readonly KnowledgeEntryId[],
): Promise<EmbedPhaseResult> {
  const { embedder } = deps;
  if (embedder === undefined || touchedEntryIds.length === 0) {
    return { embedded: 0, skipped: 0, failed: 0, cancelled: false };
  }

  const rows = listChunkRowsForEmbedding(deps.db, touchedEntryIds);
  // 已有向量的块不再重算：这既是断点续传，也是「增量导入只花新块的钱」
  const existing = deps.getVectorIndex()?.existingRowids(rows.map((row) => row.chunkRowid));
  const pending: PendingChunk[] =
    existing === undefined ? [...rows] : rows.filter((row) => !existing.has(row.chunkRowid));
  const alreadyEmbedded = rows.length - pending.length;
  if (pending.length === 0) {
    return { embedded: 0, skipped: alreadyEmbedded, failed: 0, cancelled: false };
  }

  let index = deps.getVectorIndex();
  let report: EmbedChunksReport;
  try {
    report = await embedChunks(pending, {
      embedder,
      signal: deps.signal,
      onEmbedded: ({ chunk, vector }) => {
        // 首条向量到手才知道维度，此时才建索引（vec0 虚表维度在 CREATE 时固定）
        index ??= deps.ensureVectorIndex(vector.length, embedder.model);
        index.put(chunk.chunkRowid, vector);
      },
      onProgress: (progress) => {
        deps.onProgress({
          importId: request.importId,
          phase: "embedding",
          done: progress.done,
          total: progress.total,
        });
      },
    });
  } catch (thrown) {
    // onEmbedded 抛出（建索引失败 / 落库失败）会中止整轮：已算与已存一旦错位，续传就不可信
    return {
      embedded: 0,
      skipped: alreadyEmbedded,
      failed: pending.length,
      fatal: thrown instanceof Error ? thrown.message : String(thrown),
      cancelled: deps.signal.aborted,
    };
  }

  return {
    embedded: report.embedded,
    skipped: alreadyEmbedded + report.skipped,
    failed: report.failed,
    ...(report.fatal === undefined ? {} : { fatal: report.fatal.message }),
    cancelled: report.aborted,
  };
}

/**
 * 跑一轮完整的导入 / 重建。
 * 取消不是错误：已经落库的条目与向量原样保留（都是幂等可续的），报告里 cancelled 置真。
 */
export async function runIngest(
  deps: IngestDeps,
  request: IngestRequest,
): Promise<KnowledgeImportReport> {
  const base = emptyReport(request.importId);
  const indexResult = await runIndexPhase(deps, request);
  const embedResult = indexResult.cancelled
    ? { embedded: 0, skipped: 0, failed: 0, cancelled: true }
    : await runEmbedPhase(deps, request, indexResult.touchedEntryIds);

  deps.onProgress({
    importId: request.importId,
    phase: "done",
    done: request.files.length,
    total: request.files.length,
  });

  return {
    ...base,
    scanned: request.files.length,
    indexed: indexResult.indexed,
    skipped: indexResult.skipped,
    chunks: indexResult.chunks,
    embedded: embedResult.embedded,
    embedSkipped: embedResult.skipped,
    embedFailed: embedResult.failed,
    ...(embedResult.fatal === undefined ? {} : { embedFatal: embedResult.fatal }),
    failures: indexResult.failures,
    cancelled: indexResult.cancelled || embedResult.cancelled,
  };
}

/** 条目是否还能重建（只有 file_import 有原文件可回读）。 */
export function isRebuildable(entry: KnowledgeEntry): boolean {
  return entry.origin.kind === "file_import";
}

/** 条目仍在库中（重建前的存在性检查）。 */
export function entryExists(db: Database.Database, entryId: KnowledgeEntryId): boolean {
  return findEntryRowid(db, entryId) !== undefined;
}
