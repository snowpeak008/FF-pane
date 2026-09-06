/**
 * IPC 结果信封：主进程 handler 的返回值与异常统一包装为可结构化克隆的 IpcResult，
 * 渲染侧解包还原为返回值或 IpcInvokeError。
 * 纯逻辑，无 Electron / Node 依赖，可直接单测。
 *
 * T9.2 ① 结构化扩展（向后兼容）：storage / core 的错误类自带可枚举判别字段
 * （`code` 字面量、`field` 违规字段、`violations` 违规列表——见
 * packages/storage/src/providers/errors.ts、packages/core/src/profile/errors.ts），
 * 此前序列化只留 name/message/stack、结构化字段全部丢失，渲染层只能整串直出
 * 技术原文。现按**字段读取**（跨进程后原型链必丢，instanceof 不可用）把这三个
 * 字段随信封带过去；旧错误 / 第三方错误没有这些字段时信封形状与从前逐字节相同，
 * 渲染层的错误翻译层（ipc/humanize.ts）对无 code 的错误回退现状显示。
 */

/** 结构化违规条目（ProfileValidationError.violations 的线上形状）。 */
export interface SerializedIpcViolation {
  readonly field: string;
  readonly reason: string;
}

/** 跨进程可序列化的错误快照。 */
export interface SerializedIpcError {
  readonly channel: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** 错误自有的判别码（如 "provider-validation"）；旧错误无此字段则缺席。 */
  readonly code?: string;
  /** 违规字段名（ProviderValidationError.field 一类，camelCase 领域字段）。 */
  readonly field?: string;
  /** 违规裸原因（不带模板前缀，ProviderValidationError.reason 一类）。 */
  readonly reason?: string;
  /** 结构化违规列表（ProfileValidationError.violations 一类）。 */
  readonly violations?: readonly SerializedIpcViolation[];
}

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedIpcError };

export function okResult<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function readStringField(source: object, field: string): string | undefined {
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从抛出物上提取结构化违规列表（形状不符的条目一律丢弃，宁缺勿错）。 */
function readViolations(source: object): readonly SerializedIpcViolation[] | undefined {
  const value = (source as Record<string, unknown>)["violations"];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const violations: SerializedIpcViolation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const fields = item as Record<string, unknown>;
    if (typeof fields["field"] === "string" && typeof fields["reason"] === "string") {
      violations.push({ field: fields["field"], reason: fields["reason"] });
    }
  }
  return violations.length > 0 ? violations : undefined;
}

/** 将任意 thrown 值规范化为可序列化错误信封。 */
export function errResult(channel: string, thrown: unknown): IpcResult<never> {
  if (thrown instanceof Error) {
    const code = readStringField(thrown, "code");
    const field = readStringField(thrown, "field");
    const reason = readStringField(thrown, "reason");
    const violations = readViolations(thrown);
    return {
      ok: false,
      error: {
        channel,
        name: thrown.name,
        message: thrown.message,
        ...(thrown.stack !== undefined ? { stack: thrown.stack } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(field !== undefined ? { field } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(violations !== undefined ? { violations } : {}),
      },
    };
  }
  return {
    ok: false,
    error: { channel, name: "NonErrorThrown", message: stringifyThrown(thrown) },
  };
}

function stringifyThrown(thrown: unknown): string {
  if (typeof thrown === "string") {
    return thrown;
  }
  try {
    const json: string | undefined = JSON.stringify(thrown);
    return json === undefined ? String(thrown) : json;
  } catch {
    return String(thrown);
  }
}

/**
 * 渲染侧收到主进程错误信封时抛出的异常类型。
 *
 * 结构化字段直接以 `code` / `field` / `violations` 命名（而非 remoteCode 一类）：
 * ipc/errors.ts 的 toIpcErrorInfo 按字段名取值且 `code` 优先级最高，同名即免改接缝。
 */
export class IpcInvokeError extends Error {
  readonly channel: string;
  readonly remoteName: string;
  readonly remoteStack: string | undefined;
  /** 远端错误的判别码（信封带来的，可能缺席）。 */
  readonly code: string | undefined;
  /** 远端错误的违规字段名（可能缺席）。 */
  readonly field: string | undefined;
  /** 远端错误的违规裸原因（可能缺席）。 */
  readonly reason: string | undefined;
  /** 远端错误的结构化违规列表（可能缺席）。 */
  readonly violations: readonly SerializedIpcViolation[] | undefined;

  constructor(error: SerializedIpcError) {
    super(`IPC 调用 "${error.channel}" 失败：${error.name}: ${error.message}`);
    this.name = "IpcInvokeError";
    this.channel = error.channel;
    this.remoteName = error.name;
    this.remoteStack = error.stack;
    this.code = error.code;
    this.field = error.field;
    this.reason = error.reason;
    this.violations = error.violations;
  }
}

/** 运行时校验未知值是否为合法的 IpcResult 信封。 */
export function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["ok"] === true) {
    return "value" in candidate;
  }
  if (candidate["ok"] === false) {
    const error = candidate["error"];
    if (typeof error !== "object" || error === null) {
      return false;
    }
    const fields = error as Record<string, unknown>;
    return (
      typeof fields["channel"] === "string" &&
      typeof fields["name"] === "string" &&
      typeof fields["message"] === "string"
    );
  }
  return false;
}

/** 解包主进程返回的信封；非法形状或错误信封一律抛 IpcInvokeError。 */
export function unwrapIpcResult<T>(raw: unknown, channel: string): T {
  if (!isIpcResult(raw)) {
    throw new IpcInvokeError({
      channel,
      name: "MalformedIpcResult",
      message: `主进程返回了非法的 IPC 信封：${stringifyThrown(raw)}`,
    });
  }
  if (!raw.ok) {
    throw new IpcInvokeError(raw.error);
  }
  return raw.value as T;
}
