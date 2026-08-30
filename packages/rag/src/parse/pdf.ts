/**
 * PDF 解析（技术选型 §8「.pdf → pdfjs-dist 提取文本 + 页码」）。
 *
 * 只做文本抽取，永不渲染：故走 legacy 构建 + 关闭 worker/eval/系统字体，
 * 并在依赖层跳过 @napi-rs/canvas（见 pnpm-workspace.yaml 注释）。
 * 页边界是 PDF 唯一可靠的结构信号，逐页返回，直接喂给 T6.2 的「按页与段落」分块。
 */

import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { MalformedDocumentError } from "./errors.js";
import { fileBaseName } from "./formats.js";
import { normalizeText } from "./text.js";
import type { ParsedDocument, ParsedPage } from "./types.js";

/**
 * pdfjs 文本项的结构性最小契约。
 * 不从 pdfjs 的内部类型路径导入：那些路径不在其 exports 映射内，
 * 跨版本易碎；此处按运行时实际形状收窄，配合下方守卫使用。
 */
interface PdfTextItem {
  readonly str: string;
  /** 该项后是否换行（pdfjs 依据文本行布局给出）。 */
  readonly hasEOL?: boolean;
}

/** getTextContent 的 items 混有 TextMarkedContent（无 str），据此筛出真正的文本项。 */
function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === "object" && item !== null && typeof (item as PdfTextItem).str === "string";
}

/** 把一页的文本项拼为正文：hasEOL 处断行，其余顺序拼接。 */
function assemblePageText(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (!isTextItem(item)) {
      continue;
    }
    parts.push(item.str);
    if (item.hasEOL === true) {
      parts.push("\n");
    }
  }
  return normalizeText(parts.join(""))
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 从 PDF 元数据取标题；缺失或空白则回退文件名。 */
function resolveTitle(filePath: string, info: unknown): string {
  if (typeof info === "object" && info !== null) {
    const title = (info as Record<string, unknown>)["Title"];
    if (typeof title === "string" && title.trim() !== "") {
      return title.trim();
    }
  }
  return fileBaseName(filePath);
}

/**
 * 解析 PDF 为「全文 + 逐页正文」。
 * 加密、结构损坏、非 PDF 内容等一律抛 MalformedDocumentError。
 */
export async function parsePdf(filePath: string, bytes: Uint8Array): Promise<ParsedDocument> {
  // pdfjs 会持有并写入传入的缓冲区，必须给它一份独占副本，
  // 否则调用方（批量导入）复用的字节会被就地改坏。
  const data = new Uint8Array(bytes);

  const loadingTask = getDocument({
    data,
    // 以下四项 = Node 端纯文本抽取的标准配方：不起 worker、不 eval、不碰系统字体与画布
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const doc = await loadingTask.promise;
    try {
      const metadata = await doc.getMetadata().catch(() => undefined);
      const pages: ParsedPage[] = [];

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          pages.push({ page: pageNumber, text: assemblePageText(content.items) });
        } finally {
          // 及时释放页级资源：万级文档批量导入时，累积的页对象会顶爆内存
          page.cleanup();
        }
      }

      return {
        format: "pdf",
        title: resolveTitle(filePath, metadata?.info),
        // 空页不参与拼接，但 pages[] 保留它以维持页码与真实页序严格对齐
        text: pages
          .map((entry) => entry.text)
          .filter((text) => text !== "")
          .join("\n\n"),
        pages,
      };
    } finally {
      await doc.destroy();
    }
  } catch (cause) {
    if (cause instanceof MalformedDocumentError) {
      throw cause;
    }
    throw new MalformedDocumentError(
      filePath,
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}
