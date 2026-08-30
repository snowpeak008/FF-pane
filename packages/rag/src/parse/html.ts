/**
 * HTML 正文抽取（技术选型 §8「.html → 正文抽取」）。
 *
 * 实现选择：手写线性扫描器，不用正则剥标签、不引 jsdom/cheerio。
 * 理由有二——
 * 1. 依赖纪律：技术选型未纳入 DOM 库，正文抽取的自研量本就可控；
 * 2. ReDoS：本仓已在 Gemini 适配器上踩过一次正则回溯炸弹（见进度快照 §1），
 *    含嵌套量词的标签正则是同一类风险。扫描器对任意输入都是 O(n)，无回溯。
 *
 * 抽取策略（可预测优先，不做 readability 那种打分式启发）：
 * - 有 <main> 取其子树，否则有 <body> 取 body，否则取全文（mammoth 产出的是无壳片段）；
 * - script/style/noscript/svg/head 等非正文元素连内容一并丢弃；
 * - 块级标签转换为换行，td/th 转为空格，<pre> 区间内保留原始空白；
 * - 实体解码后再做空白规范化。
 */

import { normalizeText } from "./text.js";

/** 内容整体丢弃的元素（含其子树）。 */
const DROP_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg", "head", "template"]);

/** 转换为换行的块级元素。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/** 转换为空格的单元格元素（保持同一行的表格单元不粘连）。 */
const CELL_TAGS = new Set(["td", "th"]);

/**
 * 命名实体表：覆盖 HTML 文本节点里的高频实体，其余走数字实体解码。
 * nbsp 刻意映射为**普通空格**（U+0020）而非 U+00A0，以便随后被空白折叠规则统一处理。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  frac12: "½",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  larr: "←",
  rarr: "→",
  harr: "↔",
  ne: "≠",
  le: "≤",
  ge: "≥",
  infin: "∞",
};

/** 解码 HTML 实体（命名 + 十进制/十六进制数字实体）。无法识别的原样保留。 */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) {
    return input;
  }
  // 定长上界的字符类，无嵌套量词，线性匹配
  return input.replace(
    /&(#[Xx]?[0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = isHex ? body.slice(2) : body.slice(1);
        const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
          return match;
        }
        // 代理区码点非法：fromCodePoint 会产出孤立代理项，原样保留更安全
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** 一个已解析的开始/结束标签。 */
interface TagToken {
  readonly name: string;
  readonly closing: boolean;
  /** 标签在源串中结束的下一个下标（即 '>' 之后）。 */
  readonly end: number;
}

/** 标签名允许的字符（ASCII 字母数字即可覆盖 HTML 元素名）。 */
function isTagNameChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9")
  );
}

/**
 * 从 `<` 处读一个标签。属性值内的 `>` 不会被误判为标签结束。
 * 非标签（如裸露的 `<` 后跟空白）返回 undefined，由调用方按普通文本处理。
 */
function readTag(html: string, start: number): TagToken | undefined {
  let i = start + 1;
  const closing = html[i] === "/";
  if (closing) {
    i += 1;
  }
  const nameStart = i;
  while (i < html.length && isTagNameChar(html[i] as string)) {
    i += 1;
  }
  if (i === nameStart) {
    return undefined;
  }
  const name = html.slice(nameStart, i).toLowerCase();

  // 跳到标签结束，跳过引号包裹的属性值
  let quote: string | undefined;
  while (i < html.length) {
    const char = html[i] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return { name, closing, end: i + 1 };
    }
    i += 1;
  }
  // 未闭合标签：吃到串尾
  return { name, closing, end: html.length };
}

/** 一段正文片段：pre=true 的片段保留原始空白。 */
interface TextSegment {
  readonly text: string;
  readonly pre: boolean;
}

/**
 * 若存在 <main> 或 <body>，把抽取范围收窄到其内部；否则返回原串。
 * lower 为 source 的小写副本（调用方预先算好，避免重复 O(n) 转换）。
 */
function narrowToContentRoot(source: string, lower: string): string {
  for (const tag of ["main", "body"]) {
    const openIndex = lower.indexOf(`<${tag}`);
    if (openIndex === -1) {
      continue;
    }
    const openTag = readTag(source, openIndex);
    if (openTag === undefined || openTag.closing || openTag.name !== tag) {
      continue;
    }
    const closeIndex = lower.indexOf(`</${tag}`, openTag.end);
    return source.slice(openTag.end, closeIndex === -1 ? source.length : closeIndex);
  }
  return source;
}

/**
 * 行内空白折叠：连续空白 → 单空格，并吃掉换行两侧的空格。仅用于非 <pre> 片段。
 * 吃掉换行两侧空格是必要的：<tr> 产出换行、<td> 产出空格，
 * 不处理则每个表格行都会以一个空格开头。字符类无嵌套量词，线性匹配。
 */
function collapseInlineWhitespace(text: string): string {
  return text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n");
}

/**
 * 抽取 HTML 正文为纯文本。输入可以是完整文档，也可以是片段
 * （docx 经 mammoth 转换出的 HTML 即为无壳片段）。
 */
export function extractHtmlText(html: string): string {
  const normalized = normalizeText(html);
  const source = narrowToContentRoot(normalized, normalized.toLowerCase());
  const lowerSource = source.toLowerCase();

  const segments: TextSegment[] = [];
  let buffer: string[] = [];
  let preDepth = 0;

  /** 把当前缓冲区按「当时的 pre 状态」定格为一个片段。 */
  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ text: buffer.join(""), pre: preDepth > 0 });
      buffer = [];
    }
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;

    if (char !== "<") {
      buffer.push(char);
      index += 1;
      continue;
    }

    // 注释与 doctype/CDATA：整段丢弃
    if (source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<!", index)) {
      const close = source.indexOf(">", index + 2);
      index = close === -1 ? source.length : close + 1;
      continue;
    }

    const tag = readTag(source, index);
    if (tag === undefined) {
      // 裸露的 `<`，按普通文本处理
      buffer.push(char);
      index += 1;
      continue;
    }

    if (DROP_CONTENT_TAGS.has(tag.name)) {
      if (tag.closing) {
        index = tag.end;
        continue;
      }
      // 原始文本元素：内容连同结束标签一并跳过（在预先算好的小写副本上定位）
      const closeIndex = lowerSource.indexOf(`</${tag.name}`, tag.end);
      if (closeIndex === -1) {
        index = source.length;
        continue;
      }
      const closeTag = readTag(source, closeIndex);
      index = closeTag?.end ?? source.length;
      continue;
    }

    if (tag.name === "pre") {
      // pre 边界处切段：段内空白策略由切段时的 preDepth 决定
      flush();
      preDepth = tag.closing ? Math.max(0, preDepth - 1) : preDepth + 1;
      buffer.push("\n");
      flush();
    } else if (BLOCK_TAGS.has(tag.name)) {
      buffer.push("\n");
    } else if (CELL_TAGS.has(tag.name)) {
      buffer.push(" ");
    }

    index = tag.end;
  }
  flush();

  const joined = segments
    .map((segment) => {
      const decoded = decodeHtmlEntities(segment.text);
      return segment.pre ? decoded : collapseInlineWhitespace(decoded);
    })
    .join("");

  return joined
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
