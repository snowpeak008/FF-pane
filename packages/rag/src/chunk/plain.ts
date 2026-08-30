/**
 * 通用分段（T6.2）：按空行切段落。
 *
 * 服务于 text / html / docx 三种格式，以及各专用分段器的兜底路径。
 * html 与 docx 的正文经 T6.1 抽取后已是「块级元素间以空行分隔」的纯文本
 * （见 parse/html.ts），空行正是那里刻意保留的段落边界信号。
 *
 * 已知取舍：html/docx 的标题在纯文本里与普通段落无从区分，故这两种格式的块
 * 不带 headingPath——ChunkProvenance 对此的约定本就是「非 Markdown 缺省」。
 */

import { estimateTokens } from "./tokens.js";
import type { Segment } from "./types.js";

/** 按空行切分段落，去空白、丢空段。 */
export function splitParagraphs(text: string): readonly string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/** 把纯文本切成段落级的段（无结构信息，全部可自由合并）。 */
export function splitPlainText(text: string): readonly Segment[] {
  return splitParagraphs(text).map((paragraph) => ({
    text: paragraph,
    tokens: estimateTokens(paragraph),
    boundary: "paragraph" as const,
  }));
}
