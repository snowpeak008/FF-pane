/**
 * habits 层错误类型（T5.1）：沿用 memory 层的「Error 子类 + code 字面量判别」模式
 * （见 memory/errors.ts）。习惯条目是全局共享记忆（设计文档 §8.2），一条一文件，
 * 编解码复用 memory 的 frontmatter 子集，落位规则独立（habits/<category>/<id>.md）。
 *
 * code 取值与 fs 层（not-found / corrupt-json / io-error）完全不重叠，跨层组合的
 * 联合类型仍可用 error.code 做穷尽分支收窄。读 API 以 HabitResult 判别联合返回，
 * 写 API 失败即抛。
 */

import type { StorageIoError, StorageNotFoundError } from "../fs/index.js";

/** habits 层错误码（判别字段的取值全集）。 */
export const HABIT_FILE_ERROR_CODES = [
  "frontmatter-syntax",
  "invalid-entry",
  "entry-not-found",
  "encode-invalid",
  "validation",
] as const;

/** habits 层错误码。 */
export type HabitFileErrorCode = (typeof HABIT_FILE_ERROR_CODES)[number];

/** habits 层错误基类：携带判别码，子类各自携带路径 / 字段 / 条目 ID 等上下文。 */
export abstract class HabitFileError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: HabitFileErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** frontmatter 超出受控子集 / 结构损坏，读入被拒。携带路径与行号。 */
export class HabitFrontmatterError extends HabitFileError {
  override readonly code = "frontmatter-syntax" as const;
  /** 出错的文件路径。 */
  readonly path: string;
  /** 出错行号（从 1 起，相对整个文件）。 */
  readonly line: number;
  /** 语法错误原因。 */
  readonly reason: string;

  constructor(path: string, line: number, reason: string) {
    super(`习惯文件 frontmatter 语法错误（第 ${line} 行：${reason}）: ${path}`);
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}

/** 必填字段缺失 / 枚举值非法 / 字段类型不符，读入被拒。携带路径与字段名。 */
export class HabitEntryFieldError extends HabitFileError {
  override readonly code = "invalid-entry" as const;
  /** 出错的文件路径。 */
  readonly path: string;
  /** 出错的字段名（frontmatter key，或正文对应的 content）。 */
  readonly field: string;
  /** 校验失败原因。 */
  readonly reason: string;

  constructor(path: string, field: string, reason: string) {
    super(`习惯文件字段非法（${field}：${reason}）: ${path}`);
    this.path = path;
    this.field = field;
    this.reason = reason;
  }
}

/** loadHabit 在全部分类目录中都找不到 <id>.md。 */
export class HabitEntryNotFoundError extends HabitFileError {
  override readonly code = "entry-not-found" as const;
  /** 要找的条目 ID。 */
  readonly entryId: string;
  /** 实际查找过的目录清单。 */
  readonly searchedDirs: readonly string[];

  constructor(entryId: string, searchedDirs: readonly string[]) {
    super(`习惯条目不存在（已查找 ${searchedDirs.join("、")}）: ${entryId}`);
    this.entryId = entryId;
    this.searchedDirs = searchedDirs;
  }
}

/** 写侧输入无法编码（content 无法表达、id 含文件名非法字符等），属调用方缺陷。 */
export class HabitEncodeError extends HabitFileError {
  override readonly code = "encode-invalid" as const;

  // biome-ignore lint/complexity/noUselessConstructor: 基类构造器为 protected，此处提供公开构造入口
  constructor(message: string) {
    super(message);
  }
}

/** 习惯草稿结构校验失败（create / update 前），携带字段名（设计文档 §8.2）。 */
export class HabitValidationError extends HabitFileError {
  override readonly code = "validation" as const;
  /** 违规字段名。 */
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`习惯草稿非法（${field}：${reason}）`);
    this.field = field;
  }
}

/**
 * habits 读 API 的判别联合结果。与 memory 层 MemoryResult 同形；单独定义避免
 * 跨模块耦合（habits 不依赖 memory 的业务错误族）。
 */
export type HabitResult<TValue, TError extends Error> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

/** 条目文件解码的失败集合（纯文本 → HabitEntry 阶段）。 */
export type HabitEntryDecodeError = HabitEntryFieldError | HabitFrontmatterError;

/** loadHabit / updateHabitStatus 读取阶段的失败集合。 */
export type HabitEntryLoadError = HabitEntryDecodeError | HabitEntryNotFoundError | StorageIoError;

/** 供上层需要区分「文件不存在是常态」的读路径复用。 */
export type HabitEntryReadError = HabitEntryLoadError | StorageNotFoundError;
