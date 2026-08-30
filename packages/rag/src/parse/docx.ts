/**
 * docx 解析（技术选型 §8「.docx → mammoth → HTML → 纯文本」）。
 *
 * 走 convertToHtml 而非 extractRawText，是为了保住段落/标题/列表/表格的块边界：
 * mammoth 的 raw text 会把结构压平，分块器就只剩「按长度硬切」一条路。
 * 转出的 HTML 交给本包的正文抽取器（html.ts）落回纯文本，与 .html 走同一条路径。
 */

import mammoth from "mammoth";
import { MalformedDocumentError } from "./errors.js";
import { fileBaseName } from "./formats.js";
import { extractHtmlText } from "./html.js";
import type { ParsedDocument } from "./types.js";

/**
 * 解析 docx 为纯文本。
 * 非法 OOXML 包（zip 损坏、缺 word/document.xml 等）抛 MalformedDocumentError。
 */
export async function parseDocx(filePath: string, bytes: Uint8Array): Promise<ParsedDocument> {
  let html: string;
  try {
    // mammoth 的 Node 入参要 Buffer；Buffer.from 复用底层 ArrayBuffer，不额外拷贝
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
  } catch (cause) {
    throw new MalformedDocumentError(
      filePath,
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }

  return {
    format: "docx",
    title: fileBaseName(filePath),
    text: extractHtmlText(html),
  };
}
