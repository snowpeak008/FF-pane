/**
 * token 估算（T6.2）。
 *
 * 为什么是估算而不是真分词：块大小只用于「切得不太大也不太小」，
 * 而真正的 tokenizer 随嵌入模型而变（cl100k / Qwen / Ollama 各不相同），
 * 为它引入一个 WASM 分词器既重又仍然对不上号。故用一个**稳定、线性、
 * 略微高估**的启发式：宁可块偏小，也不要撑爆下游模型的上下文。
 *
 * 规则（对 cl100k 系列的经验值）：
 * - 汉字 / 假名 / 全角标点等宽字符：1 字 ≈ 1 token；
 * - 其余（拉丁字母、数字、半角标点）：4 字符 ≈ 1 token；
 * - 空白与控制符不单独计费（它们总是并入相邻 token）。
 */

/** 「一字≈一 token」的码位区间（闭区间，按起点升序，供二分式早退）。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303f], // 康熙部首 + CJK 标点
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容汉字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角货币符号
  [0x20000, 0x2fa1f], // CJK 扩展 B~F + 兼容补充
];

/** 非宽字符按几个字符折算一个 token。 */
const NARROW_CHARS_PER_TOKEN = 4;

/** 宽字符的单字权重（增量切分用）。 */
const WIDE_CHAR_WEIGHT = 1;

/** 非宽字符的单字权重（增量切分用，与 NARROW_CHARS_PER_TOKEN 互为倒数）。 */
const NARROW_CHAR_WEIGHT = 1 / NARROW_CHARS_PER_TOKEN;

/** 该码位是否按「一字一 token」计费。 */
export function isWideCodePoint(codePoint: number): boolean {
  if (codePoint < 0x1100) {
    return false;
  }
  for (const [low, high] of WIDE_RANGES) {
    // 区间按起点升序：一旦落在某区间之前就不可能再命中后面的区间
    if (codePoint < low) {
      return false;
    }
    if (codePoint <= high) {
      return true;
    }
  }
  return false;
}

/**
 * 取 index 处的码位与它占用的 UTF-16 单元数。
 * 手写而不用 for...of：分块要处理十万级文本块，避免迭代器分配。
 */
function codePointAt(
  text: string,
  index: number,
): { readonly code: number; readonly size: number } {
  const unit = text.charCodeAt(index);
  if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { code: (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000, size: 2 };
    }
  }
  return { code: unit, size: 1 };
}

/** 估算文本的 token 数。O(n)，无正则、无回溯。 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  let index = 0;
  while (index < text.length) {
    const { code, size } = codePointAt(text, index);
    index += size;
    // 空格、制表、换行与控制符不单独计费
    if (code <= 0x20) {
      continue;
    }
    if (isWideCodePoint(code)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return wide + Math.ceil(narrow / NARROW_CHARS_PER_TOKEN);
}

/**
 * 把一段没有任何可用切点的长文本按 token 预算硬切（切分的最后手段）。
 * 保证不在代理对中间切开，且 join("") 可还原原文。
 */
export function sliceByTokenBudget(text: string, maxTokens: number): readonly string[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new RangeError(`sliceByTokenBudget: maxTokens must be positive, got ${maxTokens}`);
  }
  const pieces: string[] = [];
  let start = 0;
  let budget = 0;
  let index = 0;
  while (index < text.length) {
    const { code, size } = codePointAt(text, index);
    const weight = code <= 0x20 ? 0 : isWideCodePoint(code) ? WIDE_CHAR_WEIGHT : NARROW_CHAR_WEIGHT;
    // 超预算时在当前字符**之前**断开，当前字符成为下一片的开头
    if (budget + weight > maxTokens && index > start) {
      pieces.push(text.slice(start, index));
      start = index;
      budget = 0;
    }
    budget += weight;
    index += size;
  }
  if (start < text.length) {
    pieces.push(text.slice(start));
  }
  return pieces;
}
