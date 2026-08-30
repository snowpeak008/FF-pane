/**
 * 解析层错误族（T6.1）：沿用 storage 的「Error 子类 + code 字面量判别」模式，
 * 便于批量导入时按 code 分类统计与在界面上给出可理解的失败原因（§1.4 边界处理）。
 *
 * 约定：单文件解析失败即抛（由批量层 parseFiles 捕获降级为 ParseFileOutcome），
 * 与 storage 层「读 API 判别联合、写 API 抛」的分工一致。
 */

/** 解析层错误码（判别字段取值全集）。 */
export const PARSE_ERROR_CODES = [
  "unsupported-format",
  "binary-content",
  "malformed-document",
  "read-error",
] as const;

/** 解析层错误码。 */
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/** 解析层错误基类：携带判别码与出错文件路径。 */
export abstract class ParseError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: ParseErrorCode;
  /** 出错的文件路径。 */
  readonly filePath: string;

  protected constructor(message: string, filePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.filePath = filePath;
  }
}

/** 扩展名不在支持清单内（设计文档 §8.3.2 支持格式）。批量导入时跳过该文件。 */
export class UnsupportedFormatError extends ParseError {
  override readonly code = "unsupported-format" as const;
  /** 实际的扩展名（小写，含点；无扩展名为空串）。 */
  readonly extension: string;

  constructor(filePath: string, extension: string) {
    super(
      `不支持的文件格式（${extension === "" ? "无扩展名" : extension}）: ${filePath}`,
      filePath,
    );
    this.extension = extension;
  }
}

/** 文本类文件里检出二进制内容（NUL 字节），拒绝当文本解析——防止乱码块污染索引。 */
export class BinaryContentError extends ParseError {
  override readonly code = "binary-content" as const;

  constructor(filePath: string) {
    super(`文件疑似二进制内容，无法作为文本解析: ${filePath}`, filePath);
  }
}

/** 文档结构损坏：PDF 无法打开、docx 不是合法 OOXML 包等。携带底层原因。 */
export class MalformedDocumentError extends ParseError {
  override readonly code = "malformed-document" as const;
  /** 失败原因（底层库的错误信息原文）。 */
  readonly reason: string;

  constructor(filePath: string, reason: string, options?: ErrorOptions) {
    super(`文档解析失败（${reason}）: ${filePath}`, filePath, options);
    this.reason = reason;
  }
}

/** 读盘失败（parseFile / parseFiles 专有：文件不存在、无权限等）。 */
export class ParseReadError extends ParseError {
  override readonly code = "read-error" as const;
  /** 失败原因（底层 fs 错误信息原文）。 */
  readonly reason: string;

  constructor(filePath: string, reason: string, options?: ErrorOptions) {
    super(`读取文件失败（${reason}）: ${filePath}`, filePath, options);
    this.reason = reason;
  }
}
