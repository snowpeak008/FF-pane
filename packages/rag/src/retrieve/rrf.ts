/**
 * Reciprocal Rank Fusion（T6.4，设计文档 §8.3.4「BM25 与向量双路召回 → RRF 融合」）。
 *
 * 为什么是 RRF 而不是加权求和分数：BM25 分与余弦距离**没有可比的量纲**——
 * BM25 是负无穷到 0 的对数似然、随语料统计漂移，余弦距离固定在 [0,2]。
 * 把两者归一化再加权，权重只能靠拍脑袋，且换个语料就失准。RRF 只用**名次**，
 * 对两路的分数分布完全免疫，这正是它成为混合检索默认解法的原因。
 *
 * 本文件是纯函数、不认识 SQLite——DB 那一侧在 storage 的 knowledge-search.ts。
 * 分开的好处很实在：融合规则可以拿假名次列表单测到底，不必起一个库。
 */

/** RRF 的标准平滑常数。60 是原论文（Cormack 2009）的取值，也是业界默认。 */
export const DEFAULT_RRF_K = 60;

/** 参与融合的一路召回：一串按相关度降序排好的 ID。 */
export interface RankedList<T> {
  /** 路标识（如 "fts" / "vector"），进融合结果供界面标注命中来源。 */
  readonly source: string;
  /** 该路的命中 ID，**必须已按相关度降序**——RRF 只认顺序。 */
  readonly ids: readonly T[];
  /**
   * 该路权重，缺省 1。
   * 留这个口子不是为了调参玄学，而是为了表达「未配嵌入模型时向量路权重为 0」
   * 这类结构性事实；日常检索两路等权。
   */
  readonly weight?: number;
}

/** 融合后的一条结果。 */
export interface FusedHit<T> {
  /** 命中 ID。 */
  readonly id: T;
  /** RRF 总分（各路 weight / (k + rank) 之和，越大越靠前）。 */
  readonly score: number;
  /** 命中它的路（按传入顺序），供界面标注「关键词命中 / 语义命中 / 两者皆有」。 */
  readonly sources: readonly string[];
  /** 各路名次（从 1 起），未命中的路缺席。调试与解释排序用。 */
  readonly ranks: Readonly<Record<string, number>>;
}

/** fuseByRrf 的可选参数。 */
export interface RrfOptions {
  /** 平滑常数，缺省 DEFAULT_RRF_K。越大则各名次之间的差距越平缓。 */
  readonly k?: number;
  /** 返回条数上限，缺省不限。 */
  readonly limit?: number;
}

/**
 * 多路召回 → RRF 融合排序。
 *
 * 契约：
 * - 同一路内重复的 ID 只按**首次出现**的名次计分（重复项是上游的毛病，
 *   按最好名次算一次是最不伤害结果的处理）；
 * - 总分相同时按「命中路数多的在前」，仍相同则按首次出现顺序稳定排序——
 *   任何情况下结果都是确定的，测试才钉得住；
 * - 空列表、全空、weight 为 0 都是正常输入，不抛。
 */
export function fuseByRrf<T>(
  lists: readonly RankedList<T>[],
  options: RrfOptions = {},
): readonly FusedHit<T>[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`fuseByRrf: k 必须是正数，实际 ${k}`);
  }

  interface Accumulator {
    readonly id: T;
    score: number;
    readonly sources: string[];
    readonly ranks: Record<string, number>;
    /** 首次出现的全局序，用于稳定排序。 */
    readonly arrival: number;
  }

  const accumulators = new Map<T, Accumulator>();
  let arrival = 0;

  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (weight === 0) {
      continue;
    }
    const seen = new Set<T>();
    list.ids.forEach((id, index) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      const rank = index + 1;
      let accumulator = accumulators.get(id);
      if (accumulator === undefined) {
        accumulator = { id, score: 0, sources: [], ranks: {}, arrival };
        arrival += 1;
        accumulators.set(id, accumulator);
      }
      accumulator.score += weight / (k + rank);
      accumulator.sources.push(list.source);
      accumulator.ranks[list.source] = rank;
    });
  }

  const fused = [...accumulators.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.sources.length !== left.sources.length) {
      return right.sources.length - left.sources.length;
    }
    return left.arrival - right.arrival;
  });

  const limited = options.limit === undefined ? fused : fused.slice(0, Math.max(0, options.limit));
  return limited.map((accumulator) => ({
    id: accumulator.id,
    score: accumulator.score,
    sources: accumulator.sources,
    ranks: accumulator.ranks,
  }));
}
