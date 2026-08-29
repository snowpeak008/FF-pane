/**
 * 密钥模块统一错误类型（W1.5b），形制沿用 @ff-pane/storage 的
 * 「Error 子类 + code 字面量判别」组合：既能 instanceof 捕获、保留 cause 链，
 * 又能在联合类型上用 error.code 做穷尽分支收窄。
 *
 * 红线（设计文档 §4.3 / 技术选型 §6）：所有错误信息一律不含明文与密文；
 * 底层原因只经 cause 链保留（safeStorage 与 fs 的报错本身不携带敏感内容）。
 */

/** 密钥模块错误码（判别字段的取值全集）。 */
export const SECRETS_ERROR_CODES = [
  "backend-unavailable",
  "encrypt-failed",
  "decrypt-failed",
  "ref-not-found",
  "invalid-secrets-file",
] as const;

/** 密钥模块错误码。 */
export type SecretsErrorCode = (typeof SECRETS_ERROR_CODES)[number];

/** 密钥模块错误基类。 */
export abstract class SecretsError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: SecretsErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * 系统加密后端不可用（EncryptionBackend.isAvailable() 为 false）。
 * 策略（W1.5b 决策）：宁可不能用也不做明文降级存储，存 / 取一律明确拒绝。
 */
export class SecretsBackendUnavailableError extends SecretsError {
  override readonly code = "backend-unavailable" as const;

  constructor() {
    super(
      "系统加密功能不可用（safeStorage 报告 isAvailable=false），已拒绝密钥操作：" +
        "本应用不做明文降级存储。请确认系统凭据服务正常后重试",
    );
  }
}

/** 加密失败。信息不含明文，底层原因见 cause。 */
export class SecretEncryptError extends SecretsError {
  override readonly code = "encrypt-failed" as const;

  constructor(options?: ErrorOptions) {
    super("密钥加密失败，明文未写入任何文件（底层原因见 cause）", options);
  }
}

/** 解密失败（密文损坏、或由其他系统账户加密等）。信息只含不透明引用，可安全展示。 */
export class SecretDecryptError extends SecretsError {
  override readonly code = "decrypt-failed" as const;
  /** 出错的密钥引用（不透明 ID）。 */
  readonly ref: string;

  constructor(ref: string, options?: ErrorOptions) {
    super(`密钥解密失败（引用 ${ref}）：密文可能损坏，或由其他系统账户加密`, options);
    this.ref = ref;
  }
}

/** 密钥引用不存在（已删除或从未存在）。 */
export class SecretNotFoundError extends SecretsError {
  override readonly code = "ref-not-found" as const;
  /** 查无此项的密钥引用（不透明 ID）。 */
  readonly ref: string;

  constructor(ref: string) {
    super(`密钥引用不存在（可能已被删除）: ${ref}`);
    this.ref = ref;
  }
}

/**
 * secrets.json 结构不符合预期（JSON 本身可解析，但版本或字段错误，
 * 例如用户手改坏了文件）。信息只含路径与结构性原因，不回显文件内容。
 */
export class SecretsFileInvalidError extends SecretsError {
  override readonly code = "invalid-secrets-file" as const;
  /** 出错的密文文件路径。 */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`密文文件结构无效（${reason}）: ${path}`);
    this.path = path;
  }
}
