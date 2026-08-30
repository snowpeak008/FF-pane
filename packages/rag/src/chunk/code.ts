/**
 * 源码分段（T6.2，技术选型 §8「代码按函数/类边界（启发式）」）。
 *
 * 明确是启发式，不是语法分析：本产品要吃 30 种扩展名（见 parse/formats.ts），
 * 为每种语言接一个 parser 与「自研量可控」的定位相悖。故只认两条顶格信号：
 *   ① 行首顶格且首个非修饰词是声明关键字（function / class / def / fn / impl …）；
 *   ② C 家族兜底：顶格、含参数表、以 { 结尾。
 * 声明前紧邻的注释块与装饰器/属性行会被并入该声明（JSDoc、@Override、#[derive]
 * 与它修饰的对象分开毫无意义）。
 *
 * 关键词匹配手写扫描而非正则：修饰词可任意叠加（`export default async function`），
 * 用 `(?:mod\s+)*keyword` 这类写法就是嵌套量词，正是本仓在 Gemini 适配器上
 * 踩过的回溯炸弹形状。
 *
 * 识别不出 2 个以上边界时（配置文件、SQL 脚本、极短文件）退回按空行分段——
 * 宁可粗一点，也不要把整个文件当成一个块交给硬切。
 */

import { splitPlainText } from "./plain.js";
import { estimateTokens } from "./tokens.js";
import type { Segment } from "./types.js";

/** 声明关键字：命中即认定为一处函数/类/类型边界。 */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  "function",
  "func",
  "fn",
  "def",
  "class",
  "struct",
  "interface",
  "enum",
  "impl",
  "trait",
  "type",
  "record",
  "module",
  "namespace",
  "object",
  "protocol",
  "extension",
  "package",
  "const",
  "let",
  "var",
  "val",
  "sub",
  "create", // SQL：CREATE TABLE / CREATE PROCEDURE
]);

/** 修饰词：出现在声明关键字之前，跳过继续看下一个词。 */
const MODIFIER_KEYWORDS: ReadonlySet<string> = new Set([
  "export",
  "default",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "async",
  "open",
  "override",
  "suspend",
  "pub",
  "unsafe",
  "extern",
  "declare",
  "inline",
  "virtual",
  "readonly",
  "data",
  "sealed",
  "partial",
  "operator",
  "or", // SQL：CREATE OR REPLACE
  "replace",
  "global",
  "local",
]);

/** 会被并入其后声明的行前缀：注释、文档串、装饰器、属性宏。 */
const ATTACHED_PREFIXES: readonly string[] = [
  "//",
  "/*",
  "*/",
  "*",
  "#[",
  "#!",
  "#",
  "--",
  "<!--",
  "@",
  '"""',
  "'''",
];

/** 扫描一个词的字母部分（到首个非字母/下划线为止），转小写。 */
function wordKey(token: string): string {
  let end = 0;
  while (end < token.length) {
    const code = token.charCodeAt(end);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    if (!isLetter) {
      break;
    }
    end += 1;
  }
  return token.slice(0, end).toLowerCase();
}

/** 最多检查行首多少个词——修饰词叠加再多也不会超过这个数。 */
const MAX_SCANNED_WORDS = 6;

/** 该行是否是一处顶层声明。 */
function isDeclarationLine(line: string): boolean {
  const first = line[0];
  if (first === undefined || first === " " || first === "\t" || first === "}" || first === ")") {
    return false;
  }

  let scanned = 0;
  let cursor = 0;
  while (cursor < line.length && scanned < MAX_SCANNED_WORDS) {
    // 跳过词间空白
    while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
      cursor += 1;
    }
    const start = cursor;
    while (cursor < line.length && line[cursor] !== " " && line[cursor] !== "\t") {
      cursor += 1;
    }
    if (cursor === start) {
      break;
    }
    scanned += 1;
    const key = wordKey(line.slice(start, cursor));
    if (key === "") {
      break;
    }
    if (DECLARATION_KEYWORDS.has(key)) {
      return true;
    }
    if (!MODIFIER_KEYWORDS.has(key)) {
      break;
    }
  }

  // C 家族兜底：`int main(int argc) {`、`build() {` 这类无关键字的函数定义
  return line.trimEnd().endsWith("{") && line.includes("(");
}

/** 该行是否应并入其后的声明（顶格的注释 / 装饰器 / 属性行）。 */
function isAttachedLine(line: string): boolean {
  if (line === "" || line[0] === " " || line[0] === "\t") {
    return false;
  }
  return ATTACHED_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** 把源码切成以顶层声明为边界的段。 */
export function segmentCode(text: string): readonly Segment[] {
  const lines = text.split("\n");

  // 1) 找出所有声明起点，并向前吃掉紧邻的注释/装饰器行
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDeclarationLine(lines[index] ?? "")) {
      continue;
    }
    let start = index;
    while (start > 0 && isAttachedLine(lines[start - 1] ?? "")) {
      start -= 1;
    }
    const previous = starts[starts.length - 1];
    // 连续声明共享同一段注释时会算出相同起点，去重并保持严格递增
    if (previous === undefined || start > previous) {
      starts.push(start);
    }
  }

  // 2) 切片。首个声明之前的部分（license 头、import 区）自成一段
  const boundaries = starts[0] === 0 ? [...starts] : [0, ...starts];
  const segments: Segment[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const from = boundaries[index] ?? 0;
    const to = boundaries[index + 1] ?? lines.length;
    const body = lines.slice(from, to).join("\n").trim();
    if (body === "") {
      continue;
    }
    segments.push({
      text: body,
      tokens: estimateTokens(body),
      // 首段可能只是 import 区，但它同样是一处天然断点，统一按结构边界处理
      boundary: "structure",
    });
  }

  // 3) 边界太少说明启发式没吃住这门语言，退回按空行分段
  return segments.length >= 2 ? segments : splitPlainText(text);
}
