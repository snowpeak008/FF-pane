/**
 * 嵌入层错误族（T6.3）：沿用 T6.1 解析层的「Error 子类 + code 字面量判别」模式。
 *
 * 除 code 外多一个 retriable 位——这是嵌入层特有的需求：
 * 导入一个文件夹会打出成百上千次请求，限流（429）与网关抖动（5xx）是常态，
 * 必须自动退避重试；而配置错、鉴权失败、维度不符属于「再试一万次也一样」，
 * 调度层据此**立即收工**，不去刷屏式地失败。
 */

/** 嵌入层错误码（判别字段取值全集）。 */
export const EMBED_ERROR_CODES = [
  "invalid-config",
  "invalid-input",
  "network",
  "timeout",
  "http",
  "invalid-response",
  "dimension-mismatch",
  "aborted",
] as const;

/** 嵌入层错误码。 */
export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[number];

/** 嵌入层错误基类：携带判别码与「是否值得重试」。 */
export abstract class EmbedError extends Error {
  /** 判别字段：各子类收窄为字面量类型，供联合类型穷尽分支。 */
  abstract readonly code: EmbedErrorCode;
  /** 重试是否有意义（调度层的分流依据）。 */
  abstract readonly retriable: boolean;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 配置不可用：baseUrl 非法、model 为空、timeoutS 非正数等。重试无意义。 */
export class EmbedConfigError extends EmbedError {
  override readonly code = "invalid-config" as const;
  override readonly retriable = false as const;

  constructor(message: string) {
    super(`嵌入配置不可用：${message}`);
  }
}

/** 入参不可用：空文本、非字符串。重试无意义。 */
export class EmbedInputError extends EmbedError {
  override readonly code = "invalid-input" as const;
  override readonly retriable = false as const;

  constructor(message: string) {
    super(`嵌入入参不可用：${message}`);
  }
}

/** 网络层失败（连接被拒、DNS 失败、TLS 错误等）。可重试。 */
export class EmbedNetworkError extends EmbedError {
  override readonly code = "network" as const;
  override readonly retriable = true as const;

  constructor(reason: string, options?: ErrorOptions) {
    super(`嵌入请求网络失败：${reason}`, options);
  }
}

/** 单请求超时。可重试。 */
export class EmbedTimeoutError extends EmbedError {
  override readonly code = "timeout" as const;
  override readonly retriable = true as const;
  /** 生效的超时秒数。 */
  readonly timeoutS: number;

  constructor(timeoutS: number, label: string) {
    super(`嵌入请求超时：${timeoutS} 秒内未完成（${label}）`);
    this.timeoutS = timeoutS;
  }
}

/**
 * 非 2xx 响应。是否可重试按状态码判定：
 * 408 请求超时 / 425 过早 / 429 限流 / 5xx 服务端错误 → 可重试；
 * 其余 4xx（401 鉴权、404 模型不存在、400 参数错）→ 不可重试。
 */
export class EmbedHttpError extends EmbedError {
  override readonly code = "http" as const;
  override readonly retriable: boolean;
  /** HTTP 状态码。 */
  readonly status: number;
  /** 响应体原文（已截断；不做改写，与 §4.2 的失败原文透传一致）。 */
  readonly body: string;

  constructor(status: number, statusText: string, label: string, body: string) {
    const statusLine = statusText === "" ? `HTTP ${status}` : `HTTP ${status} ${statusText}`;
    super(`嵌入请求失败：${statusLine}（${label}）\n${body === "" ? "（响应体为空）" : body}`);
    this.status = status;
    this.body = body;
    this.retriable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

/** 2xx 但响应体不是预期形状（非 JSON、缺字段、条目数对不上）。重试无意义。 */
export class EmbedResponseError extends EmbedError {
  override readonly code = "invalid-response" as const;
  override readonly retriable = false as const;

  constructor(message: string) {
    super(`嵌入响应无法解析：${message}`);
  }
}

/** 向量维度与期望（或与本次运行中先前批次）不一致。重试无意义，必须换模型或重建索引。 */
export class EmbedDimensionError extends EmbedError {
  override readonly code = "dimension-mismatch" as const;
  override readonly retriable = false as const;
  /** 期望维度。 */
  readonly expected: number;
  /** 实际维度。 */
  readonly actual: number;

  constructor(model: string, expected: number, actual: number) {
    super(
      `嵌入向量维度不一致：模型 ${model} 返回 ${actual} 维，期望 ${expected} 维。` +
        `更换嵌入模型后需重建向量索引。`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/** 调用方取消。重试无意义。 */
export class EmbedAbortedError extends EmbedError {
  override readonly code = "aborted" as const;
  override readonly retriable = false as const;

  constructor(label: string) {
    super(`嵌入请求已取消（${label}）`);
  }
}

/**
 * 错误是否值得重试。非 EmbedError（第三方库或宿主抛出的意外错误）一律判不可重试：
 * 不认识的失败按最坏情况处理，避免陷入无意义的重试循环。
 */
export function isRetriableEmbedError(error: unknown): boolean {
  return error instanceof EmbedError && error.retriable;
}
