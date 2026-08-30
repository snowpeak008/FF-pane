/**
 * Markdown 分段（T6.2，技术选型 §8「Markdown 按标题树」）。
 *
 * 产出的每一段都带当前标题层级路径（→ ChunkProvenance.headingPath），
 * 且以标题行开头的段标为 structure 边界，让打包层优先在标题处收口——
 * 检索命中时用户看到的是「安装 / Windows」这样的定位，而不是一个孤立段落。
 *
 * 覆盖范围（够用即止，不做完整 CommonMark 解析器）：
 * ATX 标题（# ~ ######）、setext 标题（=== / ---）、围栏代码块（``` / ~~~）、
 * 文首 YAML frontmatter。围栏内的 # 与 --- 一律不当标题——否则代码示例里的
 * 注释行会凭空造出标题层级。
 */

import { estimateTokens } from "./tokens.js";
import type { Segment } from "./types.js";

/** ATX 标题最深层级。 */
const MAX_HEADING_LEVEL = 6;

/** ATX 标题允许的最大缩进（CommonMark 规定 ≤3 个空格）。 */
const MAX_HEADING_INDENT = 3;

/** 围栏代码块的最短标记长度。 */
const MIN_FENCE_LENGTH = 3;

/** setext 二级标题下划线的最短长度：取 3 以避开 "-" 开头的列表项。 */
const MIN_SETEXT_DASHES = 3;

/** 标题栈的一层。 */
interface HeadingFrame {
  readonly level: number;
  readonly title: string;
}

/** 围栏代码块的开栏标记。 */
interface FenceMarker {
  readonly char: string;
  readonly length: number;
}

/** 取行首空格数（制表符按 1 计，仅用于缩进阈值判断）。 */
function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) {
    count += 1;
  }
  return count;
}

/** 识别围栏标记行；不是围栏返回 undefined。 */
function fenceMarker(line: string): FenceMarker | undefined {
  const trimmed = line.trimStart();
  const char = trimmed[0];
  if (char !== "`" && char !== "~") {
    return undefined;
  }
  let length = 0;
  while (length < trimmed.length && trimmed[length] === char) {
    length += 1;
  }
  return length >= MIN_FENCE_LENGTH ? { char, length } : undefined;
}

/** 该行是否闭合了当前围栏（同字符、不短于开栏、其后无内容）。 */
function closesFence(line: string, open: FenceMarker): boolean {
  const marker = fenceMarker(line);
  if (marker === undefined || marker.char !== open.char || marker.length < open.length) {
    return false;
  }
  return line.trim().length === marker.length;
}

/** 识别 ATX 标题行；不是标题返回 undefined。 */
function atxHeading(line: string): HeadingFrame | undefined {
  const indent = leadingSpaces(line);
  if (indent > MAX_HEADING_INDENT) {
    return undefined;
  }
  const body = line.slice(indent);
  let level = 0;
  while (level < body.length && body[level] === "#") {
    level += 1;
  }
  if (level === 0 || level > MAX_HEADING_LEVEL) {
    return undefined;
  }
  const rest = body.slice(level);
  // "#标签" 不是标题：# 之后必须是空白或行尾
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") {
    return undefined;
  }
  let title = rest.trim();
  // 去掉可选的闭合 #
  let end = title.length;
  while (end > 0 && title[end - 1] === "#") {
    end -= 1;
  }
  if (end < title.length) {
    title = title.slice(0, end).trim();
  }
  return { level, title };
}

/** 识别 setext 下划线行，返回它对应的标题层级；不是下划线返回 undefined。 */
function setextLevel(line: string): number | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  const char = trimmed[0];
  if (char !== "=" && char !== "-") {
    return undefined;
  }
  for (const current of trimmed) {
    if (current !== char) {
      return undefined;
    }
  }
  if (char === "=") {
    return 1;
  }
  return trimmed.length >= MIN_SETEXT_DASHES ? 2 : undefined;
}

/** 跳过文首 YAML frontmatter，返回正文起始行号。未闭合则不跳（那是一条分隔线）。 */
function skipFrontMatter(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") {
    return 0;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") {
      return index + 1;
    }
  }
  return 0;
}

/** 把 Markdown 正文切成带标题路径的段。 */
export function segmentMarkdown(text: string): readonly Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  const stack: HeadingFrame[] = [];

  let buffer: string[] = [];
  let bufferPath: readonly string[] = [];
  let bufferIsHeading = false;
  let fence: FenceMarker | undefined;

  const push = (line: string): void => {
    if (buffer.length === 0) {
      // 段的标题路径在它的第一行落定，后续标题变化不再影响本段
      bufferPath = stack.map((frame) => frame.title);
    }
    buffer.push(line);
  };

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    const isHeading = bufferIsHeading;
    buffer = [];
    bufferIsHeading = false;
    if (body === "") {
      return;
    }
    segments.push({
      text: body,
      tokens: estimateTokens(body),
      boundary: isHeading ? "structure" : "paragraph",
      ...(bufferPath.length > 0 ? { headingPath: bufferPath } : {}),
    });
  };

  const openHeading = (frame: HeadingFrame, rawLine: string): void => {
    flush();
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= frame.level) {
      stack.pop();
    }
    stack.push(frame);
    // 标题行留在段内：块正文自带标题，对 BM25 与嵌入都是有效信号
    bufferIsHeading = true;
    push(rawLine);
  };

  for (let index = skipFrontMatter(lines); index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (fence !== undefined) {
      push(line);
      if (closesFence(line, fence)) {
        fence = undefined;
      }
      continue;
    }

    const marker = fenceMarker(line);
    if (marker !== undefined) {
      flush();
      fence = marker;
      push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = atxHeading(line);
    if (heading !== undefined) {
      openHeading(heading, line);
      continue;
    }

    const level = setextLevel(line);
    if (level !== undefined && buffer.length > 0) {
      const title = (buffer[buffer.length - 1] ?? "").trim();
      if (title !== "") {
        // 下划线的上一行才是标题，先把它之前的内容独立成段
        buffer.pop();
        flush();
        openHeading({ level, title }, title);
        continue;
      }
    }

    push(line);
  }

  flush();
  return segments;
}
