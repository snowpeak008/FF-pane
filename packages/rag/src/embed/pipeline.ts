/**
 * 批量嵌入调度（T6.3 主入口）。
 *
 * 承担工单点名的四件事：**批量、并发限制、按块哈希断点续传、失败不中断整批**。
 *
 * 关键取舍：
 * - **不累积结果**。十万级块 × 千维向量若全留在内存里就是数百 MB；
 *   向量一算出来就经 onEmbedded 交给调用方落库，函数本身只返回一份统计报告。
 *   这也正是断点续传成立的前提——已算的必须已经落盘。
 * - **重试与放弃分开判**。限流、抖动、超时退避重试；鉴权失败、维度不符、
 *   配置错属于「再试也一样」，立即收工（isFatalEmbedError），
 *   不拿几千次注定失败的请求去刷屏。
 * - **同文重复只算一次**。同一批导入里内容完全相同的块（模板页脚、重复的 README 段落）
 *   共用一次请求的结果，按指纹归并后再扇出。
 */

import { setTimeout as delay } from "node:timers/promises";
import { estimateTokens } from "../chunk/tokens.js";
import { planBatches } from "./batch.js";
import { EmbedAbortedError, EmbedError, EmbedHttpError, isRetriableEmbedError } from "./errors.js";
import { embeddingFingerprint } from "./fingerprint.js";
import { signalAborted } from "./http.js";
import type { Embedder, EmbeddingVector } from "./types.js";

/** 可嵌入对象的最小形状：有正文即可。ChunkDraft 与 KnowledgeChunk 都天然满足。 */
export interface EmbeddableChunk {
  /** 块正文。 */
  readonly text: string;
}

/** 单块的嵌入结果（经 onEmbedded 逐个交付，不在报告里累积）。 */
export interface EmbeddedChunk<T extends EmbeddableChunk = EmbeddableChunk> {
  /** 原始块对象（原样回传，调用方据此拿到 id / seq / 出处）。 */
  readonly chunk: T;
  /** 该块在入参数组中的下标。 */
  readonly index: number;
  /** 块指纹（落库后即成为下次导入的断点续传依据）。 */
  readonly fingerprint: string;
  /** 向量。 */
  readonly vector: EmbeddingVector;
}

/** 重试策略（指数退避）。 */
export interface EmbedRetryPolicy {
  /** 单批最多尝试几次（含首次）。1 表示不重试。 */
  readonly maxAttempts: number;
  /** 首次退避毫秒数，此后每次翻倍。 */
  readonly baseDelayMs: number;
  /** 退避上限毫秒数。 */
  readonly maxDelayMs: number;
}

/** 缺省重试策略：三次机会、0.5s 起步、封顶 8s。 */
export const DEFAULT_EMBED_RETRY: EmbedRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
});

/**
 * 缺省并发数。取 2 而不是更高：远端服务的限流阈值不可知，
 * 而本地 Ollama 是单机推理——并发拉高只会让每个请求都变慢，总吞吐不增反降。
 */
export const DEFAULT_EMBED_CONCURRENCY = 2;

/** 进度快照（每批结束回调一次，供导入进度条使用，T6.5）。 */
export interface EmbedProgress {
  /** 已有结论的块数（跳过 + 成功 + 失败 + 空白）。 */
  readonly done: number;
  /** 总块数。 */
  readonly total: number;
  /** 已成功嵌入的块数。 */
  readonly embedded: number;
  /** 因指纹已在库而跳过的块数。 */
  readonly skipped: number;
  /** 失败的块数。 */
  readonly failed: number;
}

/** 一批的失败记录（该批的块全部计入失败，其余批次照常进行）。 */
export interface EmbedBatchFailure {
  /** 该批涉及的块下标（含因去重而共享同一次请求的块）。 */
  readonly indexes: readonly number[];
  /** 实际尝试次数。 */
  readonly attempts: number;
  /** 最后一次失败的错误。 */
  readonly error: Error;
}

/** embedChunks 的入参。 */
export interface EmbedChunksOptions<T extends EmbeddableChunk> {
  /** 嵌入器。没有嵌入器意味着走纯 FTS，那种情形根本不该调用本函数（见 resolveProviderEmbedder）。 */
  readonly embedder: Embedder;
  /** 覆盖单批条数上限，缺省取 embedder.maxBatchSize。 */
  readonly maxBatchSize?: number;
  /** 覆盖单批 token 上限，缺省取 embedder.maxBatchTokens。 */
  readonly maxBatchTokens?: number;
  /** 并发批次数，缺省 DEFAULT_EMBED_CONCURRENCY。 */
  readonly concurrency?: number;
  /** 重试策略，缺省 DEFAULT_EMBED_RETRY。 */
  readonly retry?: EmbedRetryPolicy;
  /**
   * 断点续传判定：该指纹是否已有向量在库。返回 true 即跳过该块。
   * 调用方通常实现为一次性查出的 Set 查表（同步）；也支持逐块异步查询。
   */
  readonly isEmbedded?: (fingerprint: string, chunk: T) => boolean | Promise<boolean>;
  /**
   * 单块结果交付（落库点）。**按批完成顺序回调，不保证与入参同序。**
   * 此回调抛出即视为落库失败：整轮立即中止并把异常向上抛——
   * 静默继续会让「已算」与「已存」错位，断点续传从此不可信。
   */
  readonly onEmbedded?: (result: EmbeddedChunk<T>) => void | Promise<void>;
  /** 进度回调（每批结束一次）。 */
  readonly onProgress?: (progress: EmbedProgress) => void;
  /** 取消信号：中止在飞请求、停止取新批次；已交付的结果不回滚。 */
  readonly signal?: AbortSignal;
  /** 注入式退避等待（单测用；缺省走真实定时器）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 整轮嵌入的统计报告。 */
export interface EmbedChunksReport {
  /** 入参块总数。 */
  readonly total: number;
  /** 成功嵌入并已交付的块数。 */
  readonly embedded: number;
  /** 因指纹已在库而跳过的块数（断点续传的收益）。 */
  readonly skipped: number;
  /** 正文为空或纯空白被跳过的块数（不发请求，也不算失败）。 */
  readonly blank: number;
  /** 失败的块数。 */
  readonly failed: number;
  /** 实际发出的 HTTP 请求次数（含重试），用于观察批量与重试是否符合预期。 */
  readonly requests: number;
  /** 观测到的向量维度（本轮一次都没成功则为 undefined）。 */
  readonly dimensions: number | undefined;
  /** 是否因取消而提前结束。 */
  readonly aborted: boolean;
  /** 各批失败明细。 */
  readonly failures: readonly EmbedBatchFailure[];
  /** 致命错误：出现即停止取新批次（鉴权失败、维度不符、配置错）。 */
  readonly fatal?: Error;
}

/** 一出现就没必要再发下一批的状态码：401/403 鉴权失败、404 端点或模型不存在。 */
const FATAL_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * 该错误是否意味着「后面的批次也没有任何指望」。
 * 只认三类，其余（含 4xx 里的参数错、响应形状错）当作与本批数据相关的个别失败，
 * 记账后继续——一份坏文档不该让整个文件夹的导入停摆。
 */
export function isFatalEmbedError(error: unknown): boolean {
  if (!(error instanceof EmbedError)) {
    return false;
  }
  if (error.code === "invalid-config" || error.code === "dimension-mismatch") {
    return true;
  }
  // 401/403 鉴权、404 端点或模型不存在：换一批数据也是同样结局
  return error instanceof EmbedHttpError && FATAL_HTTP_STATUSES.has(error.status);
}

/** 内部工作项：一个待嵌入的**去重后**文本 + 它对应的所有块下标。 */
interface WorkItem {
  readonly fingerprint: string;
  readonly text: string;
  readonly tokens: number;
  readonly indexes: number[];
}

/** 缺省退避等待：可被取消信号打断，避免取消后仍傻等一轮退避。 */
async function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await delay(ms, undefined, signal === undefined ? {} : { signal });
}

/** 第 attempt 次（从 1 起）失败后的退避毫秒数。 */
function backoffMs(policy: EmbedRetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 批量嵌入一组块。
 *
 * 契约：
 * - 结果经 options.onEmbedded 交付，本函数只返回统计；
 * - 单批失败不影响其余批次（致命错误除外，见 isFatalEmbedError）；
 * - 取消后已交付的结果保留，报告 aborted:true；
 * - 空数组、全空白、全部命中断点续传，都是正常返回而非错误。
 */
export async function embedChunks<T extends EmbeddableChunk>(
  chunks: readonly T[],
  options: EmbedChunksOptions<T>,
): Promise<EmbedChunksReport> {
  const { embedder, signal, onEmbedded, onProgress, isEmbedded } = options;
  const retry = options.retry ?? DEFAULT_EMBED_RETRY;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_EMBED_CONCURRENCY));
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, signal));

  let embedded = 0;
  let skipped = 0;
  let blank = 0;
  let failed = 0;
  let requests = 0;
  let aborted = false;
  let fatal: Error | undefined;
  const failures: EmbedBatchFailure[] = [];
  const total = chunks.length;

  const emitProgress = (): void => {
    onProgress?.({ done: blank + skipped + embedded + failed, total, embedded, skipped, failed });
  };

  // ── 第一步：过滤空白、断点续传、按指纹去重 ──
  const byFingerprint = new Map<string, WorkItem>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    if (signalAborted(signal)) {
      aborted = true;
      break;
    }
    const text = chunk.text;
    if (text.trim() === "") {
      blank += 1;
      continue;
    }
    const fingerprint = embeddingFingerprint(embedder.model, text);
    if (isEmbedded !== undefined && (await isEmbedded(fingerprint, chunk))) {
      skipped += 1;
      continue;
    }
    const existing = byFingerprint.get(fingerprint);
    if (existing === undefined) {
      byFingerprint.set(fingerprint, {
        fingerprint,
        text,
        tokens: estimateTokens(text),
        indexes: [index],
      });
    } else {
      existing.indexes.push(index);
    }
  }

  if (aborted || byFingerprint.size === 0) {
    emitProgress();
    return {
      total,
      embedded,
      skipped,
      blank,
      failed,
      requests,
      dimensions: embedder.dimensions,
      aborted,
      failures,
    };
  }

  // ── 第二步：切批 ──
  const batches = planBatches([...byFingerprint.values()], (item) => item.tokens, {
    maxItems: options.maxBatchSize ?? embedder.maxBatchSize,
    maxTokens: options.maxBatchTokens ?? embedder.maxBatchTokens,
  });

  // ── 第三步：并发跑批，逐块交付 ──
  let cursor = 0;
  let stopped = false;

  const runBatch = async (batch: readonly WorkItem[]): Promise<void> => {
    const texts = batch.map((item) => item.text);
    const indexes = batch.flatMap((item) => item.indexes);
    let attempt = 0;

    for (;;) {
      if (signalAborted(signal)) {
        aborted = true;
        stopped = true;
        return;
      }
      attempt += 1;
      requests += 1;

      let vectors: readonly EmbeddingVector[];
      try {
        vectors = await embedder.embed(texts, signal === undefined ? {} : { signal });
      } catch (caught) {
        const error = toError(caught);
        if (error instanceof EmbedAbortedError || signalAborted(signal)) {
          aborted = true;
          stopped = true;
          return;
        }
        if (isFatalEmbedError(error)) {
          fatal ??= error;
          stopped = true;
          failed += indexes.length;
          failures.push({ indexes, attempts: attempt, error });
          emitProgress();
          return;
        }
        if (isRetriableEmbedError(error) && attempt < retry.maxAttempts) {
          await sleep(backoffMs(retry, attempt)).catch(() => {
            // 退避被取消：交由下一轮循环开头的 aborted 检查收尾
          });
          continue;
        }
        failed += indexes.length;
        failures.push({ indexes, attempts: attempt, error });
        emitProgress();
        return;
      }

      // 成功：交付结果。onEmbedded（落库）抛出不在此处吞掉，向上传导中止整轮
      for (let position = 0; position < batch.length; position += 1) {
        const item = batch[position];
        const vector = vectors[position];
        if (item === undefined || vector === undefined) {
          continue;
        }
        for (const index of item.indexes) {
          const chunk = chunks[index];
          if (chunk === undefined) {
            continue;
          }
          embedded += 1;
          await onEmbedded?.({ chunk, index, fingerprint: item.fingerprint, vector });
        }
      }
      emitProgress();
      return;
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const batchIndex = cursor;
      cursor += 1;
      const batch = batches[batchIndex];
      if (batch === undefined) {
        return;
      }
      await runBatch(batch);
    }
  };

  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
  );
  // 落库回调抛出：整轮作废，把第一个异常原样抛给调用方
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      stopped = true;
      throw toError(outcome.reason);
    }
  }

  return {
    total,
    embedded,
    skipped,
    blank,
    failed,
    requests,
    dimensions: embedder.dimensions,
    aborted,
    failures,
    ...(fatal === undefined ? {} : { fatal }),
  };
}
