/** 解析层公共出口（T6.1）。管道下一步是 T6.2 分块器，消费 ParsedDocument。 */

export {
  BinaryContentError,
  MalformedDocumentError,
  PARSE_ERROR_CODES,
  ParseError,
  type ParseErrorCode,
  ParseReadError,
  UnsupportedFormatError,
} from "./errors.js";
export {
  detectFormat,
  type FormatDescriptor,
  fileBaseName,
  fileExtension,
  isSupportedFile,
  SUPPORTED_EXTENSIONS,
} from "./formats.js";
export { decodeHtmlEntities, extractHtmlText } from "./html.js";
export { type ParseFilesOptions, parseDocument, parseFile, parseFiles } from "./registry.js";
export { decodeTextFile, normalizeText } from "./text.js";
export type { ParsedDocument, ParsedPage, ParseFileOutcome, ParseInput } from "./types.js";
