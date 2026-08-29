/**
 * memory 层错误类型（W1.2c）：沿用 W1.2a 的「Error 子类 + code 字面量判别」模式。
 *
 * code 取值与 fs 层（not-found / corrupt-json / io-error）完全不重叠，
 * 因此跨层组合的联合类型仍可用 error.code 做穷尽分支收窄。
 * 约定沿用 W1.2a：读 API 以 MemoryResult 判别联合返回错误，写 API 失败即抛。
 */

import type { StorageIoError, StorageNotFoundError } from "../fs/index.js";

/** memory 层错误码（判别字段的取值全集）。 */
export const MEMORY_FILE_ERROR_CODES = [
  "frontmatter-syntax",
  "invalid-entry",
  "entry-not-found",
  "state-category",
  "encode-invalid",
] as const;

/** memory 层错误码。 */
export type MemoryFileErrorCode = (typeof MEMORY_FILE_ERROR_CODES)[number];

/** memory 层错误基类：携带判别码，子类各自携带路径 / 字段 / 条目 ID 等上下文。 */
export abstract class MemoryFileError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: MemoryFileErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** frontmatter 超出受控子集 / 结构损坏，读入被拒。携带路径与行号。 */
export class MemoryFrontmatterError extends MemoryFileError {
  override readonly code = "frontmatter-syntax" as const;
  /** 出错的文件路径。 */
  readonly path: string;
  /** 出错行号（从 1 起，相对整个文件）。 */
  readonly line: number;
  /** 语法错误原因。 */
  readonly reason: string;

  constructor(path: string, line: number, reason: string) {
    super(`frontmatter 语法错误（第 ${line} 行：${reason}）: ${path}`);
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}

/** 必填字段缺失 / 枚举值非法 / 字段类型不符，读入被拒。携带路径与字段名。 */
export class MemoryEntryFieldError extends MemoryFileError {
  override readonly code = "invalid-entry" as const;
  /** 出错的文件路径。 */
  readonly path: string;
  /** 出错的字段名（frontmatter key，或正文标题对应的 title）。 */
  readonly field: string;
  /** 校验失败原因。 */
  readonly reason: string;

  constructor(path: string, field: string, reason: string) {
    super(`记忆文件字段非法（${field}：${reason}）: ${path}`);
    this.path = path;
    this.field = field;
    this.reason = reason;
  }
}

/** loadEntry 在全部条目目录（candidates + 三类别目录）中都找不到 <id>.md。 */
export class MemoryEntryNotFoundError extends MemoryFileError {
  override readonly code = "entry-not-found" as const;
  /** 要找的条目 ID。 */
  readonly entryId: string;
  /** 实际查找过的目录清单。 */
  readonly searchedDirs: readonly string[];

  constructor(entryId: string, searchedDirs: readonly string[]) {
    super(`记忆条目不存在（已查找 ${searchedDirs.join("、")}）: ${entryId}`);
    this.entryId = entryId;
    this.searchedDirs = searchedDirs;
  }
}

/** category=state 不走条目文件（快照单文件 state.md），条目 API 拒绝处理。 */
export class MemoryStateCategoryError extends MemoryFileError {
  override readonly code = "state-category" as const;
  /** 被拒绝的条目 ID。 */
  readonly entryId: string;

  constructor(entryId: string) {
    super(
      `category=state 不作为条目文件存储，请改用 saveStateSnapshot / loadStateSnapshot: ${entryId}`,
    );
    this.entryId = entryId;
  }
}

/** 写侧输入无法编码（标题含换行、id 含文件名非法字符等），属调用方缺陷。 */
export class MemoryEncodeError extends MemoryFileError {
  override readonly code = "encode-invalid" as const;

  // biome-ignore lint/complexity/noUselessConstructor: 基类构造器为 protected，此处提供公开构造入口
  constructor(message: string) {
    super(message);
  }
}

/**
 * memory 读 API 的判别联合结果。与 fs 层 FsResult 同形；单独定义是因为
 * FsResult 的错误位约束为 StorageFsError 子类，而本层错误族与之并列。
 */
export type MemoryResult<TValue, TError extends Error> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

/** 条目文件解码的失败集合（纯文本 → MemoryEntry 阶段）。 */
export type MemoryEntryDecodeError = MemoryEntryFieldError | MemoryFrontmatterError;

/** loadEntry / updateEntryStatus 读取阶段的失败集合。 */
export type MemoryEntryLoadError =
  | MemoryEntryDecodeError
  | MemoryEntryNotFoundError
  | StorageIoError;

/** loadStateSnapshot 的失败集合（state.md 有固定路径，不存在是常态分支）。 */
export type MemoryStateSnapshotLoadError =
  | MemoryEntryDecodeError
  | StorageIoError
  | StorageNotFoundError;
