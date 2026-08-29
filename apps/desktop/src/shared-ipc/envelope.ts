/**
 * IPC 结果信封：主进程 handler 的返回值与异常统一包装为可结构化克隆的 IpcResult，
 * 渲染侧解包还原为返回值或 IpcInvokeError。
 * 纯逻辑，无 Electron / Node 依赖，可直接单测。
 */

/** 跨进程可序列化的错误快照。 */
export interface SerializedIpcError {
  readonly channel: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedIpcError };

export function okResult<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** 将任意 thrown 值规范化为可序列化错误信封。 */
export function errResult(channel: string, thrown: unknown): IpcResult<never> {
  if (thrown instanceof Error) {
    return {
      ok: false,
      error: {
        channel,
        name: thrown.name,
        message: thrown.message,
        ...(thrown.stack !== undefined ? { stack: thrown.stack } : {}),
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

/** 渲染侧收到主进程错误信封时抛出的异常类型。 */
export class IpcInvokeError extends Error {
  readonly channel: string;
  readonly remoteName: string;
  readonly remoteStack: string | undefined;

  constructor(error: SerializedIpcError) {
    super(`IPC 调用 "${error.channel}" 失败：${error.name}: ${error.message}`);
    this.name = "IpcInvokeError";
    this.channel = error.channel;
    this.remoteName = error.name;
    this.remoteStack = error.stack;
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
