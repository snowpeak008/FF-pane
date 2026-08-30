/**
 * 全局设置层错误类型，沿用 W1.5a 的错误设计模式：Error 子类 + `code` 判别字段。
 * 文件系统故障复用 W1.2a 的 StorageFsError 族，不在此重复定义。
 */

/** 全局设置层错误码。 */
export const CONFIG_STORE_ERROR_CODES = ["config-file-invalid"] as const;

/** 全局设置层错误码。 */
export type ConfigStoreErrorCode = (typeof CONFIG_STORE_ERROR_CODES)[number];

/** 全局设置层错误基类。 */
export abstract class ConfigStoreError extends Error {
  abstract readonly code: ConfigStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * config.json 是合法 JSON 但结构不符合约定（顶层非对象、version 不支持）。
 * 与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛 StorageCorruptJsonError。
 */
export class ConfigFileInvalidError extends ConfigStoreError {
  override readonly code = "config-file-invalid" as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`config.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
