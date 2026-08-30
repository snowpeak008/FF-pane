/**
 * 会话登记层错误类型（T4.3），沿用 providers 层的错误设计模式：
 * Error 子类 + `code` 字面量判别字段。文件系统故障（io-error / corrupt-json /
 * not-found）不在此重复定义——store 层直接向上传递 W1.2a 的 StorageFsError 错误族。
 */

/** 会话登记层错误码（判别字段的取值全集）。 */
export const SESSION_STORE_ERROR_CODES = ["sessions-file-invalid"] as const;

/** 会话登记层错误码。 */
export type SessionStoreErrorCode = (typeof SESSION_STORE_ERROR_CODES)[number];

/** 会话登记层错误基类。 */
export abstract class SessionStoreError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: SessionStoreErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * sessions.json 是合法 JSON 但整文件结构不符合约定（顶层非对象、版本不支持、
 * sessions 非数组、条目字段非法）。与 JSON 语法损坏不同：语法损坏由 W1.2a 隔离并抛
 * StorageCorruptJsonError；结构不符不隔离（内容对用户仍有价值，留在原地人工修复）。
 */
export class SessionsFileInvalidError extends SessionStoreError {
  override readonly code = "sessions-file-invalid" as const;
  /** 出错的 sessions.json 路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`sessions.json 结构不符合约定（${reason}）: ${path}`);
    this.path = path;
  }
}
