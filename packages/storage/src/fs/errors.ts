/**
 * storage 层统一错误类型（W1.2a），后续 W1.2b/c、W1.5a 沿用。
 *
 * 设计决策（W1.2a）：
 * - Error 子类 + `code` 字面量判别字段的组合：既能 instanceof 捕获、保留堆栈与
 *   `cause` 链，又能在联合类型上用 `error.code` 做穷尽分支收窄。
 * - 读取类 API 不抛异常，返回 FsResult 判别联合——文件不存在是常态分支而非事故；
 *   写入类 API 失败即抛 StorageFsError 子类——写失败属于环境事故，调用方通常无法就地恢复。
 * - 错误信息一律包含出错路径与原因（开发计划 §1.4 红线 3：系统边界失败路径必须可理解）。
 */

/** storage 文件系统层错误码（判别字段的取值全集）。 */
export const STORAGE_FS_ERROR_CODES = ["not-found", "corrupt-json", "io-error"] as const;

/** storage 文件系统层错误码。 */
export type StorageFsErrorCode = (typeof STORAGE_FS_ERROR_CODES)[number];

/** storage 文件系统层错误基类：携带出错路径与判别码。 */
export abstract class StorageFsError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: StorageFsErrorCode;
  /** 出错的文件 / 目录路径（与传入 API 的路径一致）。 */
  readonly path: string;

  protected constructor(path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.path = path;
  }
}

/** 目标文件不存在。读取类 API 的常态分支，不代表故障。 */
export class StorageNotFoundError extends StorageFsError {
  override readonly code = "not-found" as const;

  constructor(path: string) {
    super(path, `文件不存在: ${path}`);
  }
}

/**
 * JSON 文件损坏，原文件已隔离（重命名）为 `<原名>.corrupt-<时间戳>`。
 * `cause` 保留原始解析错误；`quarantinePath` 指向隔离后的文件，供用户人工检视恢复。
 */
export class StorageCorruptJsonError extends StorageFsError {
  override readonly code = "corrupt-json" as const;
  /** 隔离后文件的路径。 */
  readonly quarantinePath: string;

  constructor(path: string, quarantinePath: string, reason: string, options?: ErrorOptions) {
    super(path, `JSON 解析失败（${reason}），原文件已隔离为 ${quarantinePath}: ${path}`, options);
    this.quarantinePath = quarantinePath;
  }
}

/** 其余文件系统故障（权限、磁盘、句柄占用等），`cause` 保留底层错误。 */
export class StorageIoError extends StorageFsError {
  override readonly code = "io-error" as const;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(path, `${reason}: ${path}`, options);
  }
}

/** 读取类 API 的判别联合结果：ok=false 时携带 typed error，绝不抛裸异常。 */
export type FsResult<TValue, TError extends StorageFsError = StorageFsError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

/** readText 的失败集合。 */
export type ReadTextError = StorageIoError | StorageNotFoundError;

/** readJson 的失败集合（含损坏隔离）。 */
export type ReadJsonError = StorageCorruptJsonError | StorageIoError | StorageNotFoundError;

/** 提取 Node 文件系统错误的 errno 码（如 "ENOENT"、"EPERM"）；非 fs 错误返回 undefined。 */
export function errnoCodeOf(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
