/** 源码解析 fixture：T6.2 将按函数/类边界分块，故此处保留多个顶层声明。 */

export interface RetrievalOptions {
  readonly topK: number;
  readonly minScore?: number;
}

/** 倒数排名融合：把 BM25 与向量两路排名合成一个分数。 */
export function fuseRankings(
  bm25: readonly string[],
  vector: readonly string[],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [index, id] of bm25.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  }
  for (const [index, id] of vector.entries()) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
  }
  return scores;
}

export class QueryPlanner {
  private readonly options: RetrievalOptions;

  constructor(options: RetrievalOptions) {
    this.options = options;
  }

  plan(query: string): string {
    return query.trim().slice(0, this.options.topK);
  }
}
