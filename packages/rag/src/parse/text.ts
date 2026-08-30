/**
 * 文本解码与规范化（md / txt / 源码「直接读取」路径，技术选型 §8）。
 *
 * 三件事，全部是下游正确性的前提：
 * 1. UTF-8 解码 + 去 BOM——BOM 残留会让 Markdown 首个 `#` 不被识别为标题；
 * 2. CRLF/CR → LF——Windows 换行若流到分块器，双平台分块快照会不一致；
 * 3. 二进制守卫——.txt 扩展名的二进制文件解码出的替换字符会污染索引。
 */

import { BinaryContentError } from "./errors.js";

/** UTF-8 解码器：非法字节序列产出 U+FFFD 替换字符（不抛，交由二进制守卫判定）。 */
const UTF8_DECODER = new TextDecoder("utf-8");

/** U+FFFD 替换字符占比超过此阈值即判定为二进制/非 UTF-8 内容。 */
const REPLACEMENT_RATIO_THRESHOLD = 0.1;

/** 判定二进制内容时，样本至少要有这么多字符（避免极短文件被误判）。 */
const MIN_SAMPLE_FOR_RATIO = 32;

/**
 * 把任意换行风格规范化为 LF，并去掉 BOM。
 * 不做 trim：正文首尾空白由分块器按块处理，解析层不擅自裁剪原文。
 */
export function normalizeText(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/**
 * 解码文本类文件为规范化 UTF-8 正文。
 * 检出 NUL 字节或大比例替换字符即抛 BinaryContentError（§1.4 边界处理）。
 */
export function decodeTextFile(filePath: string, bytes: Uint8Array): string {
  // NUL 字节是二进制的强信号：合法 UTF-8 文本永不包含它
  if (bytes.includes(0)) {
    throw new BinaryContentError(filePath);
  }

  const decoded = UTF8_DECODER.decode(bytes);

  // 非 UTF-8 编码（如 GBK）解码后会产生大量替换字符，同样拒收：
  // 与其把乱码写进索引，不如明确报错让用户先转码
  if (decoded.length >= MIN_SAMPLE_FOR_RATIO) {
    let replacements = 0;
    for (const char of decoded) {
      if (char === "�") {
        replacements += 1;
      }
    }
    if (replacements / decoded.length > REPLACEMENT_RATIO_THRESHOLD) {
      throw new BinaryContentError(filePath);
    }
  }

  return normalizeText(decoded);
}
