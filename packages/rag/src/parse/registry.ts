/**
 * 解析器注册表（T6.1 主入口，技术选型 §8「按扩展名分发」）。
 *
 * 三层入口，职责递进：
 *   parseDocument(input)  纯函数式：字节进、ParsedDocument 出，不碰文件系统，便于单测；
 *   parseFile(path)       读盘 + 解析，单文件失败即抛；
 *   parseFiles(paths)     批量：**单文件失败不中断批量**（设计文档 T6.1 明确要求），
 *                         逐个降级为 ParseFileOutcome，并支持进度回调与取消。
 */

import { readFile } from "node:fs/promises";
import type { KnowledgeFormat } from "@ff-pane/shared";
import { parseDocx } from "./docx.js";
import { ParseReadError, UnsupportedFormatError } from "./errors.js";
import { detectFormat, fileBaseName, fileExtension } from "./formats.js";
import { extractHtmlText } from "./html.js";
import { parsePdf } from "./pdf.js";
import { decodeTextFile } from "./text.js";
import type { ParsedDocument, ParseFileOutcome, ParseInput } from "./types.js";

/**
 * 按格式解析。format 由调用方给定（显式指定或扩展名判定），
 * language 仅 source_code 有值。
 */
async function dispatch(
  input: ParseInput,
  format: KnowledgeFormat,
  language: string | undefined,
): Promise<ParsedDocument> {
  const { filePath, bytes } = input;

  switch (format) {
    case "pdf":
      return parsePdf(filePath, bytes);

    case "docx":
      return parseDocx(filePath, bytes);

    case "html":
      return {
        format,
        title: fileBaseName(filePath),
        text: extractHtmlText(decodeTextFile(filePath, bytes)),
      };

    case "source_code":
      return {
        format,
        title: fileBaseName(filePath),
        text: decodeTextFile(filePath, bytes),
        // exactOptionalPropertyTypes 全开：可选字段用条件展开，不写 undefined
        ...(language === undefined ? {} : { language }),
      };

    case "markdown":
    case "text":
      return {
        format,
        title: fileBaseName(filePath),
        text: decodeTextFile(filePath, bytes),
      };

    default: {
      // 穷尽性检查：KnowledgeFormat 新增成员时此处编译失败，逼迫补解析器
      const exhaustive: never = format;
      throw new Error(`未覆盖的知识库格式: ${String(exhaustive)}`);
    }
  }
}

/**
 * 解析单份文档（纯函数式入口：字节进、结构化产物出）。
 * 格式取 input.format，缺省时按扩展名判定；判定不出抛 UnsupportedFormatError。
 */
export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  if (input.format !== undefined) {
    // 显式指定格式（会话收录 / 手动条目无真实扩展名）：语言仍尽力按扩展名补
    const detected = detectFormat(input.filePath);
    const language = detected?.format === input.format ? detected.language : undefined;
    return dispatch(input, input.format, language);
  }

  const detected = detectFormat(input.filePath);
  if (detected === undefined) {
    throw new UnsupportedFormatError(input.filePath, fileExtension(input.filePath));
  }
  return dispatch(input, detected.format, detected.language);
}

/** 读盘并解析单个文件。读失败抛 ParseReadError，解析失败抛对应 ParseError 子类。 */
export async function parseFile(
  filePath: string,
  format?: KnowledgeFormat,
): Promise<ParsedDocument> {
  // 先判格式再读盘：批量导入喂进来的目录清单里混着 .png/.zip/大体积二进制，
  // 不该为了随后就要拒绝的文件白读一遍全文进内存
  if (format === undefined && detectFormat(filePath) === undefined) {
    throw new UnsupportedFormatError(filePath, fileExtension(filePath));
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch (cause) {
    throw new ParseReadError(filePath, cause instanceof Error ? cause.message : String(cause), {
      cause,
    });
  }
  return parseDocument({ filePath, bytes, ...(format === undefined ? {} : { format }) });
}

/** parseFiles 的可选行为。 */
export interface ParseFilesOptions {
  /** 每完成一个文件（无论成败）回调一次，用于导入进度条（T6.5）。 */
  readonly onProgress?: (done: number, total: number, outcome: ParseFileOutcome) => void;
  /** 取消信号：已中止时停止取新文件，已完成的结果照常返回。 */
  readonly signal?: AbortSignal;
}

/**
 * 批量解析。**单文件失败不中断批量**：失败个体降级为 ok:false 记录继续下一个。
 * 顺序执行——解析是 CPU/IO 混合负载，且导入进度需要可预期的推进节奏；
 * 真正的并发控制放在嵌入阶段（T6.3）。
 */
export async function parseFiles(
  filePaths: readonly string[],
  options: ParseFilesOptions = {},
): Promise<readonly ParseFileOutcome[]> {
  const { onProgress, signal } = options;
  const outcomes: ParseFileOutcome[] = [];
  const total = filePaths.length;

  for (const filePath of filePaths) {
    if (signal?.aborted === true) {
      break;
    }

    let outcome: ParseFileOutcome;
    try {
      outcome = { ok: true, filePath, document: await parseFile(filePath) };
    } catch (error) {
      // 兜底把非 Error 抛出物也包成 Error，保证 outcome.error 恒可读
      outcome = {
        ok: false,
        filePath,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }

    outcomes.push(outcome);
    onProgress?.(outcomes.length, total, outcome);
  }

  return outcomes;
}
