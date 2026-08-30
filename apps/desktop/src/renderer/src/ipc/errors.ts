/**
 * IPC 错误的渲染层统一形态（W3.1c）——所有页面工单的错误态只消费 IpcErrorInfo。
 *
 * 为什么按字段取值、不用 instanceof（W1.2b 提醒）：
 * 主进程 handler 抛出的异常经 shared-ipc 的错误信封（envelope.ts）序列化过一次，
 * 到渲染侧已经不是原来那个对象——自定义 Error 子类的原型链在跨进程后一律丢失。
 * 因此本模块只按 **字段名** 取值（code / message / path），
 * 任何 `thrown instanceof XxxError` 的判定在这一层都是不可靠的。
 *
 * 字段来源与优先级：
 *   code    ← thrown.code → thrown.remoteName（IpcInvokeError 携带的远端 name）→ thrown.name
 *   message ← thrown.message → 值本身的字符串化（非 Error 抛出物也能拿到可读文本）
 *   path    ← thrown.path（渲染层本地抛出的错误直接携带；远端错误在信封扩展结构化
 *             details 之后同样落到这里，本层无需改动）
 *   channel ← thrown.channel → 调用方传入的通道名
 *
 * 展示约定（设计系统 §6.2 错误态）：message 是错误原文，必须原样可见、可复制；
 * code 与 path 用 font-mono 元信息呈现；禁止只显示"出错了"。
 */

/** 渲染层统一错误形态：跨 IPC 只靠字段传递，不依赖原型。 */
export interface IpcErrorInfo {
  /** 机器可读错误码（用于分支处理与埋点）。 */
  readonly code: string;
  /** 人类可读的错误原文（三态错误态原样展示）。 */
  readonly message: string;
  /** 出错涉及的路径（文件/目录/资源），有则展示为 font-mono 元信息。 */
  readonly path?: string;
  /** 出错的 IPC 通道名。 */
  readonly channel?: string;
}

/** 取不到任何错误码时的兜底码。 */
export const UNKNOWN_IPC_ERROR_CODE = "IPC_UNKNOWN";

/** 拿不到任何可读文本时的兜底文案（开发者可见的英文哨兵，非 UI 文案）。 */
export const UNKNOWN_IPC_ERROR_MESSAGE = "unknown ipc error";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringifyThrown(thrown: unknown): string {
  if (typeof thrown === "string" && thrown.trim().length > 0) {
    return thrown;
  }
  if (thrown === undefined || thrown === null) {
    return UNKNOWN_IPC_ERROR_MESSAGE;
  }
  try {
    const json: string | undefined = JSON.stringify(thrown);
    return json === undefined || json === "{}" ? String(thrown) : json;
  } catch {
    return String(thrown);
  }
}

/**
 * 把任意抛出物规范化为 IpcErrorInfo。
 * @param thrown 捕获到的任意值（Error、结构化克隆后的普通对象、字符串、undefined…）
 * @param channel 调用方已知的通道名（抛出物自带 channel 时以自带的为准）
 */
export function toIpcErrorInfo(thrown: unknown, channel?: string): IpcErrorInfo {
  const fields = asRecord(thrown);
  const code =
    fields === undefined
      ? undefined
      : (readNonEmptyString(fields, "code") ??
        readNonEmptyString(fields, "remoteName") ??
        readNonEmptyString(fields, "name"));
  const message = fields === undefined ? undefined : readNonEmptyString(fields, "message");
  const path = fields === undefined ? undefined : readNonEmptyString(fields, "path");
  const resolvedChannel =
    (fields === undefined ? undefined : readNonEmptyString(fields, "channel")) ??
    (channel !== undefined && channel.trim().length > 0 ? channel : undefined);

  return {
    code: code ?? UNKNOWN_IPC_ERROR_CODE,
    message: message ?? stringifyThrown(thrown),
    ...(path !== undefined ? { path } : {}),
    ...(resolvedChannel !== undefined ? { channel: resolvedChannel } : {}),
  };
}

/** 运行时守卫：判断未知值是否已经是规范化后的错误形态。 */
export function isIpcErrorInfo(value: unknown): value is IpcErrorInfo {
  const fields = asRecord(value);
  return (
    fields !== undefined &&
    typeof fields["code"] === "string" &&
    typeof fields["message"] === "string"
  );
}

/** 开发者日志用的一行式描述（英文，不进 UI）。 */
export function describeIpcError(error: IpcErrorInfo): string {
  const channel = error.channel === undefined ? "" : ` channel=${error.channel}`;
  const path = error.path === undefined ? "" : ` path=${error.path}`;
  return `[${error.code}]${channel}${path} ${error.message}`;
}
