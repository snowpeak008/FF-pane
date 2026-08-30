/**
 * 分块层类型与默认参数（T6.2，设计文档 §8.3.3「块大小 300~800 token，带重叠」）。
 *
 * 分工：
 * - 分段（segment）按格式识别语义单元——Markdown 标题树、PDF 页与段落、
 *   代码函数/类边界（技术选型 §8）——只切不合，产出 Segment。
 * - 打包（pack）与格式无关：把 Segment 合并成落在 [minTokens, maxTokens] 的块，
 *   并按需重叠。两步分离，故新增格式只需写分段器。
 *
 * 产物用 ChunkDraft 而非直接的 KnowledgeChunk：分块本身是纯函数
 * （同样的输入恒得同样的输出，快照测试才立得住），而 KnowledgeChunk 需要
 * 条目 ID 与块 ID —— 那是收录流程（T6.3/T6.5）注入的，不该污染分块逻辑。
 * 由 toKnowledgeChunks 完成最后一步转换。
 */

import type { ChunkProvenance } from "@ff-pane/shared";

/**
 * 段的边界强度：
 * - structure 结构边界（Markdown 标题、PDF 换页、代码顶层声明）——打包时优先在此断开；
 * - paragraph 普通段落——可与前后自由合并。
 */
export type SegmentBoundary = "structure" | "paragraph";

/** 分段产物：一个语义单元 + 它的出处线索。打包层只认这个形状，不关心格式。 */
export interface Segment {
  /** 段正文（已去除首尾空白，内部换行保留）。 */
  readonly text: string;
  /** 估算 token 数（见 estimateTokens）。 */
  readonly tokens: number;
  /** 边界强度。 */
  readonly boundary: SegmentBoundary;
  /** Markdown 标题层级路径（其余格式缺省）。 */
  readonly headingPath?: readonly string[];
  /** PDF 页码，从 1 起（其余格式缺省）。 */
  readonly page?: number;
}

/**
 * 分块产物（未落库形态）：块序号 + 正文 + 出处。
 * 与 KnowledgeChunk 的差别仅在缺 id/entryId，见本文件头注释。
 */
export interface ChunkDraft {
  /** 块在条目内的序号，从 0 起（→ KnowledgeChunk.seq，上下文扩展靠它取相邻块）。 */
  readonly seq: number;
  /** 块正文（含从上一块继承的重叠部分，如果有）。 */
  readonly text: string;
  /** 估算 token 数，恒 ≤ maxTokens。 */
  readonly tokens: number;
  /** 出处（设计文档 §8.3.4：文件路径 / 标题路径 / 页码）。 */
  readonly provenance: ChunkProvenance;
}

/** 分块参数。 */
export interface ChunkingParams {
  /** 块的目标下限：达到它之后才允许在结构边界收口。文档尾块可低于此值。 */
  readonly minTokens: number;
  /** 块的硬上限：含重叠在内，任何块都不得超过。 */
  readonly maxTokens: number;
  /** 重叠比例（相对 maxTokens）。 */
  readonly overlapRatio: number;
}

/** 设计文档 §8.3.3 / 技术选型 §8 —— 目标 300~800 token、15% 重叠。 */
export const DEFAULT_CHUNKING_PARAMS: ChunkingParams = Object.freeze({
  minTokens: 300,
  maxTokens: 800,
  overlapRatio: 0.15,
});
