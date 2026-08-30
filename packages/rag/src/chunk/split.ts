/**
 * 文本切点（T6.2 打包层的公共零件）。
 *
 * 打包层有两处必须在段内部下刀：超长段落要切小、块间重叠要取尾巴。
 * 两处都要求「切在人能读懂的地方」，故统一走三级降级：
 *   行边界 → 句末标点 → 按 token 预算硬切。
 * 全部手写线性扫描：本包的 HTML 抽取已因正则回溯风险改为扫描器（T6.1），
 * 切分同样面对用户任意文本，保持同一条纪律。
 */

import { estimateTokens, sliceByTokenBudget } from "./tokens.js";
import { trimBlankEdges } from "./trim.js";

/** 句末标点：中文全角与半角各一组，半角额外要求后随空白或结尾以免切开 "3.14"。 */
const WIDE_SENTENCE_ENDERS = new Set(["。", "！", "？", "；", "…", "”", "）"]);
const NARROW_SENTENCE_ENDERS = new Set([".", "!", "?", ";"]);

/** 按行切分并保留行尾换行符，使 join("") 可还原原文。 */
function splitLinesKeepingBreak(text: string): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/** 按句末标点切分并保留标点，使 join("") 可还原原文。 */
function splitSentencesKeepingEnder(text: string): readonly string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const isEnder =
      WIDE_SENTENCE_ENDERS.has(char) ||
      // 半角句号只有后随空白或位于结尾时才算句末，否则 "v1.2"、"a.b()" 会被切碎
      (NARROW_SENTENCE_ENDERS.has(char) &&
        (index + 1 >= text.length || /\s/.test(text[index + 1] ?? "")));
    if (!isEnder) {
      continue;
    }
    // 把紧跟其后的空白并入本句，避免下一句以空格开头
    let end = index + 1;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) {
      end += 1;
    }
    sentences.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    sentences.push(text.slice(start));
  }
  return sentences;
}

/**
 * 把文本拆成「原子」：每个原子的 token 数都 ≤ maxTokens，且 join("") 还原原文。
 * 打包层据此自由组合，既不会切在字符中间，也不会产出超限片段。
 */
export function atomize(text: string, maxTokens: number): readonly string[] {
  const atoms: string[] = [];
  for (const line of splitLinesKeepingBreak(text)) {
    if (estimateTokens(line) <= maxTokens) {
      atoms.push(line);
      continue;
    }
    for (const sentence of splitSentencesKeepingEnder(line)) {
      if (estimateTokens(sentence) <= maxTokens) {
        atoms.push(sentence);
        continue;
      }
      atoms.push(...sliceByTokenBudget(sentence, maxTokens));
    }
  }
  return atoms;
}

/**
 * 把文本按 token 预算切成若干片，每片 ≤ maxTokens，切点尽量落在行/句边界。
 * 用于「单个段落本身就超过块上限」的情况。
 */
export function splitByTokens(text: string, maxTokens: number): readonly string[] {
  if (estimateTokens(text) <= maxTokens) {
    const single = trimBlankEdges(text);
    return single === "" ? [] : [single];
  }
  const pieces: string[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  const flush = (): void => {
    const piece = trimBlankEdges(buffer.join(""));
    buffer = [];
    tokens = 0;
    if (piece !== "") {
      pieces.push(piece);
    }
  };
  for (const atom of atomize(text, maxTokens)) {
    const atomTokens = estimateTokens(atom);
    if (buffer.length > 0 && tokens + atomTokens > maxTokens) {
      flush();
    }
    buffer.push(atom);
    tokens += atomTokens;
  }
  flush();
  return pieces;
}

/**
 * 在预算内从文本**头部**取尽可能多的内容，返回 [取走的, 剩下的]。
 * 用于「当前块还没到下限、来段又装不下」时把来段切开先填满当前块。
 * 预算装不下任何一个原子时返回 [undefined, 原文]。
 */
export function takeHead(
  text: string,
  maxTokens: number,
): readonly [string | undefined, string | undefined] {
  if (maxTokens <= 0) {
    return [undefined, text];
  }
  const atoms = atomize(text, maxTokens);
  let taken = 0;
  let tokens = 0;
  while (taken < atoms.length) {
    const atomTokens = estimateTokens(atoms[taken] ?? "");
    if (taken > 0 && tokens + atomTokens > maxTokens) {
      break;
    }
    tokens += atomTokens;
    taken += 1;
  }
  const head = trimBlankEdges(atoms.slice(0, taken).join(""));
  const tail = trimBlankEdges(atoms.slice(taken).join(""));
  return [head === "" ? undefined : head, tail === "" ? undefined : tail];
}

/**
 * 在预算内从文本**尾部**取内容（块间重叠用），切点落在行/句边界。
 * 返回的是原文的后缀（已去首尾空行，保留首行缩进）。
 */
export function takeTail(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  const atoms = atomize(text, maxTokens);
  let index = atoms.length;
  let tokens = 0;
  while (index > 0) {
    const atomTokens = estimateTokens(atoms[index - 1] ?? "");
    if (index < atoms.length && tokens + atomTokens > maxTokens) {
      break;
    }
    tokens += atomTokens;
    index -= 1;
  }
  return trimBlankEdges(atoms.slice(index).join(""));
}
