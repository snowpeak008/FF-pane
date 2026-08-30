/**
 * 解析层的中间产物类型（T6.1 定稿，T6.2 分块器唯一消费契约）。
 *
 * 设计要点：
 * - 解析只负责「按格式提取正文与结构」（设计文档 §8.3.3 第一步），
 *   不做分块、不算 token、不碰索引——那些归 T6.2/T6.4。
 * - 结构信息只保留分块器真正需要的三样（技术选型 §8）：
 *   PDF 的页边界（→ ChunkProvenance.page）、源码的语言（→ 函数边界启发式）、
 *   Markdown 的原文（标题树由分块器自己解析，解析层不预先拆解）。
 * - 正文一律规范化为 LF 换行的 UTF-8 纯文本，Windows CRLF 不泄漏到下游
 *   （否则分块快照测试在双平台产出不同结果）。
 */

import type { KnowledgeFormat } from "@ff-pane/shared";

/** PDF 的单页正文（设计文档 §8.3.3「PDF 按页与段落」的页边界来源）。 */
export interface ParsedPage {
  /** 页码，从 1 起（直接进 ChunkProvenance.page）。 */
  readonly page: number;
  /** 该页正文（已规范化）。 */
  readonly text: string;
}

/**
 * 解析产物：正文 + 供分块器使用的结构线索。
 * 真实数据源仍是原文件（设计文档 §8.4），本产物是可随时重算的派生数据。
 */
export interface ParsedDocument {
  /** 判定出的格式（决定 T6.2 走哪套分块策略）。 */
  readonly format: KnowledgeFormat;
  /** 条目标题：PDF 取元数据标题，其余取文件名（不含扩展名）。 */
  readonly title: string;
  /** 全文纯文本（PDF 为各页正文按页序拼接）。 */
  readonly text: string;
  /** 仅 PDF：按页正文。非 PDF 缺省——分块器据此判断是否走「按页」策略。 */
  readonly pages?: readonly ParsedPage[];
  /** 仅 source_code：语言标识（如 "typescript"），供函数/类边界启发式选规则。 */
  readonly language?: string;
}

/** 解析入参：字节 + 路径。解析器不自己读盘，便于纯函数式单测与批量复用。 */
export interface ParseInput {
  /** 原文件路径：用于判定格式、取标题、以及错误信息定位。 */
  readonly filePath: string;
  /** 原文件字节。 */
  readonly bytes: Uint8Array;
  /**
   * 显式指定格式，跳过扩展名判定。
   * 用于会话收录 / 手动新建条目（§8.3.2 后两种来源，无真实扩展名）。
   */
  readonly format?: KnowledgeFormat;
}

/**
 * 批量解析的单文件结果（设计文档要求「单文件失败不中断批量」）。
 * 判别联合：失败个体被降级为一条记录，而不是让整批抛出。
 */
export type ParseFileOutcome =
  | { readonly ok: true; readonly filePath: string; readonly document: ParsedDocument }
  | { readonly ok: false; readonly filePath: string; readonly error: Error };
