/**
 * Codex 会话记录（rollout）里的回合信号。
 *
 * Codex 的 notify 只在回合正常做完时触发（agent-turn-complete），既不告诉我们消息有没有真的提交，
 * 也不报 API 错误。rollout 里有：
 * - event_msg / task_started：一轮开始（消息已经提交）；
 * - event_msg / task_complete：一轮结束，API 出错时带 error（里面有状态码和错误类型）。
 * - event_msg / turn_aborted：一轮被打断（用户按 Esc，reason 为 interrupted）。notify 不报这种结束。
 * 只读文件末尾新增的行，只取事件类型和错误类型，不取对话正文。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type CodexTurnEvent =
  | { readonly kind: "turn-started" }
  | { readonly kind: "turn-complete"; readonly errorType?: string }
  | { readonly kind: "turn-aborted" };

/** 一次最多读这么多新增字节，避免一轮巨大的输出卡住主进程。 */
export const CODEX_ROLLOUT_READ_MAX_BYTES = 4 * 1024 * 1024;
export const CODEX_ROLLOUT_POLL_MS = 500;

/**
 * 把 Codex 的错误换成和 Claude StopFailure 一样的类型名。
 * Codex 的 error.message 常是一段 JSON 字符串，例如 {"type":"error","status":429,...}。
 */
export function codexErrorType(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "");
  const statusMatch = /"?status"?\s*[:=]\s*(\d{3})/.exec(text) ?? /\b(4\d\d|5\d\d)\b/.exec(text);
  const status = statusMatch !== null ? Number(statusMatch[1]) : undefined;
  const lower = text.toLowerCase();
  if (status === 429 || /rate_limit|usage_limit|quota|too many requests/.test(lower)) {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || /auth|unauthorized|forbidden|login/.test(lower)) {
    return "authentication_failed";
  }
  if (status === 529 || status === 503 || /overloaded/.test(lower)) {
    return "overloaded";
  }
  if (status === 404 || /model.*(not found|not supported|does not exist)/.test(lower)) {
    return "model_not_found";
  }
  if (status !== undefined && status >= 500) {
    return "server_error";
  }
  if (status === 400 || /invalid_request/.test(lower)) {
    return "invalid_request";
  }
  if (/context|max.?output|too long/.test(lower)) {
    return "max_output_tokens";
  }
  return "unknown";
}

/** 解析一行 rollout。不是回合事件就返回 undefined。 */
export function parseCodexRolloutLine(line: string): CodexTurnEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("event_msg")) {
    return undefined;
  }
  let value: { readonly type?: unknown; readonly payload?: { type?: unknown; error?: unknown } };
  try {
    value = JSON.parse(trimmed) as typeof value;
  } catch {
    return undefined;
  }
  if (value.type !== "event_msg" || value.payload === undefined || value.payload === null) {
    return undefined;
  }
  if (value.payload.type === "task_started") {
    return { kind: "turn-started" };
  }
  if (value.payload.type === "turn_aborted") {
    return { kind: "turn-aborted" };
  }
  if (value.payload.type === "task_complete") {
    const error = value.payload.error;
    return error === undefined || error === null
      ? { kind: "turn-complete" }
      : { kind: "turn-complete", errorType: codexErrorType(error) };
  }
  return undefined;
}

/** 文件名里的时间比编号里的时间可能早一点、晚几秒（实测晚 1 秒）。在这个范围里逐秒试。 */
const ROLLOUT_NAME_SECONDS_BEFORE = 2;
const ROLLOUT_NAME_SECONDS_AFTER = 10;

/** UUID v7 的前 48 位是创建时刻的毫秒数。不是 v7 就返回 undefined。 */
export function codexThreadIdTimeMs(threadId: string): number | undefined {
  const hex = threadId.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || hex.charAt(12) !== "7") {
    return undefined;
  }
  return Number.parseInt(hex.slice(0, 12), 16);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 只算这个会话自己的文件：sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<id>.jsonl（本地时间）。
 * 用编号里的时间拼出候选名逐个查是否存在，不列目录，不碰别的会话。
 */
export function codexRolloutPathFor(
  sessionsDir: string,
  threadId: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const createdMs = codexThreadIdTimeMs(threadId);
  if (createdMs === undefined) {
    return undefined;
  }
  for (
    let offset = -ROLLOUT_NAME_SECONDS_BEFORE;
    offset <= ROLLOUT_NAME_SECONDS_AFTER;
    offset += 1
  ) {
    const at = new Date(createdMs + offset * 1000);
    const y = String(at.getFullYear());
    const m = pad(at.getMonth() + 1);
    const d = pad(at.getDate());
    const stamp = `${y}-${m}-${d}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
    const candidate = join(sessionsDir, y, m, d, `rollout-${stamp}-${threadId}.jsonl`);
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface CodexRolloutTail {
  stop(): void;
}

/**
 * 从文件当前末尾开始，定时读新增的行。半行留到下次拼上。
 * 文件被截短（极少见）就从新的末尾重来。
 */
export function tailCodexRollout(
  filePath: string,
  onEvent: (event: CodexTurnEvent) => void,
  options: {
    readonly intervalMs?: number;
    readonly schedule?: (fn: () => void, ms: number) => () => void;
  } = {},
): CodexRolloutTail {
  let offset = 0;
  try {
    offset = statSync(filePath).size;
  } catch {
    offset = 0;
  }
  /** 还没遇到换行的字节。按字节攒，整行再解码，免得把多字节字符切开。 */
  let pending = Buffer.alloc(0);
  let stopped = false;
  const intervalMs = options.intervalMs ?? CODEX_ROLLOUT_POLL_MS;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });

  const poll = (): void => {
    if (stopped) {
      return;
    }
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = size;
      pending = Buffer.alloc(0);
      return;
    }
    if (size === offset) {
      return;
    }
    const length = Math.min(size - offset, CODEX_ROLLOUT_READ_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const read = readSync(fd, buffer, 0, length, offset);
      offset += read;
      pending = Buffer.concat([pending, buffer.subarray(0, read)]);
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
    const lastNewline = pending.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return;
    }
    const complete = pending.subarray(0, lastNewline).toString("utf8");
    pending = Buffer.from(pending.subarray(lastNewline + 1));
    for (const line of complete.split("\n")) {
      const event = parseCodexRolloutLine(line);
      if (event !== undefined) {
        onEvent(event);
      }
    }
  };

  const cancel = schedule(poll, intervalMs);
  return {
    stop() {
      stopped = true;
      cancel();
    },
  };
}
