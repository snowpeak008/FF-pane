/**
 * 块指纹（T6.3，设计文档 §8.3.2「增量索引：按内容哈希判断变化」的块级对应物）。
 *
 * 断点续传的全部依据就是它：导入中途崩了 / 用户点了取消 / 同一份文档改了一段又重导，
 * 重跑时凡是指纹已在库的块，直接跳过，不再花钱花时间重算向量。
 *
 * 为什么把模型 ID 也搅进哈希：向量只在**同一个模型**下可比。
 * 若指纹只认文本，换一次嵌入模型后旧向量会被当成「已算过」而留在库里，
 * 与新向量混在同一张表——检索结果会静默失真，且几乎无法定位。
 * 把模型写进指纹后，换模型等于全体指纹改变，天然触发重算。
 */

import { createHash } from "node:crypto";

/** 文本的 SHA-256（十六进制，64 字符）。UTF-8 编码，与平台无关。 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 块指纹：sha256(model + NUL + text)。
 * 用 NUL 作分隔符——它不可能出现在正文里（T6.1 的 BinaryContentError 已把含 NUL 的
 * 文件挡在门外），故不存在 "a"+"bc" 与 "ab"+"c" 撞进同一指纹的歧义。
 */
export function embeddingFingerprint(model: string, text: string): string {
  return createHash("sha256").update(model, "utf8").update("\0").update(text, "utf8").digest("hex");
}
