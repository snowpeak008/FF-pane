/**
 * 知识库管道：解析、分块、嵌入、混合检索（T6.x 落地）。
 * 硬性规则：本包不得 import 任何 Electron API（技术选型 §3）。
 */
export const PACKAGE_NAME = "@ff-pane/rag";

/** 解析层（T6.1）：按扩展名分发的解析器注册表，产出 ParsedDocument 供分块器消费。 */
export * from "./parse/index.js";

/**
 * Reciprocal Rank Fusion 单路得分：1 / (k + rank)。
 * 用于 BM25 与向量双路召回的融合排序（技术选型 §5），rank 从 1 起。
 */
export function rrfScore(rank: number, k = 60): number {
  if (!Number.isInteger(rank) || rank < 1) {
    throw new RangeError(`rrfScore: rank must be an integer >= 1, got ${rank}`);
  }
  if (k <= 0) {
    throw new RangeError(`rrfScore: k must be positive, got ${k}`);
  }
  return 1 / (k + rank);
}
