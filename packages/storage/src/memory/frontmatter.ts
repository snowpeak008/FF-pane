/**
 * 受控 frontmatter 子集编解码器（W1.2c）——类别无关的独立文本层。
 *
 * 只认识「--- 包围的扁平 key/值 块 + Markdown 正文」，不含任何业务字段知识，
 * Phase 5 习惯记忆条目文件直接复用本模块（导入本文件即可，无 memory 业务依赖）。
 *
 * 受控语法（自实现，非 YAML；超出子集一律拒绝并报行号）：
 * - 文件以 `---` 独占行开头，frontmatter 到下一个 `---` 独占行结束，其后是正文。
 * - 每行一条 `key: 值`；key 匹配 /^[A-Za-z_][A-Za-z0-9_-]*$/；重复 key、空行、
 *   缩进行（嵌套块）、`key:` 空值一律拒绝。
 * - 值只有两种形态：标量，或单行 `[a, b, c]` 扁平数组；不支持嵌套数组/对象、
 *   续行、块语法、注释。
 * - 标量三型：`true`/`false` → 布尔；/^-?\d+(\.\d+)?$/ → 数字；其余为字符串。
 *   字符串默认裸写；含双引号/逗号/方括号/换行或首尾空白等歧义字符、或与
 *   布尔/数字字面量同形时，用 JSON 双引号语法（转义规则 = JSON.stringify）。
 * - 正文：收尾 `---` 行之后的全部文本。编码器在非空正文前固定加一个空行作
 *   分隔，解码时剥掉这一个换行，保证 body 逐字符往返。
 * - 容错：CRLF 输入按 LF 规范化（§8.4 允许用户用任意编辑器直改；写侧永远 LF）。
 */

const FRONTMATTER_DELIMITER = "---";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NUMBER_TOKEN_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** frontmatter 标量：布尔 / 十进制定点数 / 字符串。 */
export type FrontmatterScalar = boolean | number | string;

/** frontmatter 值：标量或扁平标量数组（受控子集不支持嵌套）。 */
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[];

/** 解析出的 frontmatter 键值表（保留文件内的全部 key，未知 key 由上层决定取舍）。 */
export type FrontmatterMap = Readonly<Record<string, FrontmatterValue>>;

/** 一份「frontmatter + 正文」文档。 */
export interface FrontmatterDocument {
  readonly frontmatter: FrontmatterMap;
  readonly body: string;
}

/** 解析失败的定位信息（行号从 1 起，相对整个文件）。 */
export interface FrontmatterSyntaxIssue {
  readonly line: number;
  readonly reason: string;
}

/** parseFrontmatterDocument 的判别联合结果。issue 为纯数据，路径由调用方补充。 */
export type FrontmatterParseResult =
  | { readonly ok: true; readonly value: FrontmatterDocument }
  | { readonly ok: false; readonly issue: FrontmatterSyntaxIssue };

/** 编码侧拿到无法用受控子集表示的值（如非有限数字、非法 key）时抛出。 */
export class FrontmatterEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterEncodeError";
  }
}

type ScalarParse =
  | { readonly ok: true; readonly value: FrontmatterScalar }
  | { readonly ok: false; readonly reason: string };

type ValueParse =
  | { readonly ok: true; readonly value: FrontmatterValue }
  | { readonly ok: false; readonly reason: string };

function parseScalarToken(token: string): ScalarParse {
  if (token.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(token);
      if (typeof parsed !== "string") {
        return { ok: false, reason: `引号语法只用于字符串: ${token}` };
      }
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, reason: `非法的 JSON 引号字符串: ${token}` };
    }
  }
  if (token === "true") {
    return { ok: true, value: true };
  }
  if (token === "false") {
    return { ok: true, value: false };
  }
  if (NUMBER_TOKEN_PATTERN.test(token)) {
    return { ok: true, value: Number(token) };
  }
  if (token.includes('"')) {
    return { ok: false, reason: `裸标量不允许包含双引号（请整体用 JSON 引号语法）: ${token}` };
  }
  return { ok: true, value: token };
}

function parseArrayValue(raw: string): ValueParse {
  if (!raw.endsWith("]")) {
    return { ok: false, reason: `数组缺少收尾 ]: ${raw}` };
  }
  const inner = raw.slice(1, -1).trim();
  if (inner === "") {
    return { ok: true, value: [] };
  }
  const tokens: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (const ch of inner) {
    if (inString) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "[") {
      return { ok: false, reason: "不支持嵌套数组（受控子集只允许扁平数组）" };
    }
    if (ch === "]") {
      return { ok: false, reason: "数组语法错误（多余的 ]）" };
    }
    if (ch === ",") {
      tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (inString) {
    return { ok: false, reason: "数组内引号字符串未闭合" };
  }
  tokens.push(current);

  const values: FrontmatterScalar[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === "") {
      return { ok: false, reason: "数组包含空元素" };
    }
    const scalar = parseScalarToken(trimmed);
    if (!scalar.ok) {
      return scalar;
    }
    values.push(scalar.value);
  }
  return { ok: true, value: values };
}

function parseValue(raw: string): ValueParse {
  if (raw.startsWith("[")) {
    return parseArrayValue(raw);
  }
  return parseScalarToken(raw);
}

function failAt(line: number, reason: string): FrontmatterParseResult {
  return { ok: false, issue: { line, reason } };
}

/** 解析「受控 frontmatter + 正文」文档。纯函数，不抛异常，失败带行号与原因。 */
export function parseFrontmatterDocument(text: string): FrontmatterParseResult {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return failAt(1, "文件必须以 --- 分隔线独占首行开头");
  }
  const closeIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closeIndex === -1) {
    return failAt(lines.length, "缺少收尾的 --- 分隔线");
  }

  const entries = new Map<string, FrontmatterValue>();
  for (let index = 1; index < closeIndex; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      return failAt(lineNumber, "frontmatter 内不允许空行");
    }
    if (/^\s/.test(line)) {
      return failAt(lineNumber, "不支持缩进行（受控子集不支持嵌套结构）");
    }
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) {
      return failAt(lineNumber, "每行必须是「key: 值」；不支持 key: 空值或嵌套块");
    }
    const key = line.slice(0, separatorIndex);
    if (!KEY_PATTERN.test(key)) {
      return failAt(lineNumber, `非法 key「${key}」（要求匹配 ${KEY_PATTERN.source}）`);
    }
    if (entries.has(key)) {
      return failAt(lineNumber, `重复 key「${key}」`);
    }
    const rawValue = line.slice(separatorIndex + 2).trim();
    if (rawValue === "") {
      return failAt(lineNumber, '不支持空值（空字符串请写成 ""）');
    }
    const parsed = parseValue(rawValue);
    if (!parsed.ok) {
      return failAt(lineNumber, parsed.reason);
    }
    entries.set(key, parsed.value);
  }

  let body = lines.slice(closeIndex + 1).join("\n");
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  return { ok: true, value: { frontmatter: Object.fromEntries(entries), body } };
}

function isBareSafeString(value: string): boolean {
  if (value === "" || value !== value.trim()) {
    return false;
  }
  if (/[\n\r",[\]]/.test(value)) {
    return false;
  }
  if (value === "true" || value === "false") {
    return false;
  }
  if (NUMBER_TOKEN_PATTERN.test(value)) {
    return false;
  }
  return true;
}

function encodeScalarToken(value: FrontmatterScalar): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    const token = String(value);
    if (!NUMBER_TOKEN_PATTERN.test(token)) {
      throw new FrontmatterEncodeError(`数字 ${token} 超出受控子集可表示范围（十进制定点数）`);
    }
    return token;
  }
  return isBareSafeString(value) ? value : JSON.stringify(value);
}

function encodeValue(value: FrontmatterValue): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return encodeScalarToken(value);
  }
  return `[${value.map((item) => encodeScalarToken(item)).join(", ")}]`;
}

/**
 * 编码「受控 frontmatter + 正文」文档，保证 parseFrontmatterDocument 逐字段往返。
 * key 按传入对象的插入顺序输出（调用方负责给出稳定顺序，保证干净的 Git diff）。
 */
export function encodeFrontmatterDocument(doc: FrontmatterDocument): string {
  const lines: string[] = [FRONTMATTER_DELIMITER];
  for (const [key, value] of Object.entries(doc.frontmatter)) {
    if (!KEY_PATTERN.test(key)) {
      throw new FrontmatterEncodeError(`非法 frontmatter key「${key}」`);
    }
    lines.push(`${key}: ${encodeValue(value)}`);
  }
  lines.push(FRONTMATTER_DELIMITER);
  const head = `${lines.join("\n")}\n`;
  return doc.body === "" ? head : `${head}\n${doc.body}`;
}
