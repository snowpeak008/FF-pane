/**
 * 工作台观察型 hook（T10.6' / T10.7b）。
 * Claude：argv 里只有我们固定的事件名。stdin 上的事件 JSON 只取出 tool_use_id，
 * 以及 tool_name + 规范化 tool_input 的 SHA-256。工具正文不进入上报、不写文件、不交给 shell。
 * Codex notify：事件 JSON 是最后一个参数。只读取 type，agent-turn-complete 映射成 Stop。
 * 从环境变量读取管道名和窗口令牌，上报后立刻退出 0。
 * 不写 stdout、不写日志、不把令牌落盘。退出码恒为 0，不返回 allow/deny。
 */

import { createHash } from "node:crypto";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_REPORT_TIMEOUT_MS = 1500;

const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_DIGEST = /^[a-f0-9]{64}$/;

function isToolName(value: string): boolean {
  if (value.length < 1 || value.length > 128) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return false;
    }
  }
  return true;
}
const STDIN_ID_BUDGET = 1024 * 1024;
const STDIN_WAIT_MS = 250;

export interface HookPairing {
  readonly toolUseId?: string;
  readonly toolName?: string;
  readonly toolDigest?: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) {
        continue;
      }
      out[key] = sortKeys(child);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return value;
}

/** tool_name 与规范化 tool_input 的摘要。键顺序不同但内容相同则摘要相同。 */
export function permissionInputDigest(toolName: string, toolInput: unknown): string | undefined {
  if (!isToolName(toolName)) {
    return undefined;
  }
  try {
    const canonical = JSON.stringify(sortKeys(toolInput));
    if (typeof canonical !== "string") {
      return undefined;
    }
    return createHash("sha256").update(`${toolName}\0${canonical}`, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * 从 Claude hook 的 stdin JSON 取出配对材料。
 * 返回值只有 id、工具名和摘要，不含 tool_input / tool_response。
 */
export function extractHookPairing(raw: string): HookPairing {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return {};
  }
  try {
    const value = JSON.parse(trimmed) as { tool_use_id?: unknown; tool_name?: unknown };
    if (value === null || typeof value !== "object") {
      return {};
    }
    const id = value.tool_use_id;
    const toolUseId = typeof id === "string" && TOOL_USE_ID.test(id) ? id : undefined;
    const toolName = typeof value.tool_name === "string" ? value.tool_name : undefined;
    const toolInput = (value as { tool_input?: unknown }).tool_input;
    const toolDigest =
      toolName !== undefined ? permissionInputDigest(toolName, toolInput) : undefined;
    return {
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(toolDigest !== undefined && toolName !== undefined ? { toolName, toolDigest } : {}),
    };
  } catch {
    return {};
  }
}

/** 从 Claude hook 的 stdin JSON 里只取出 tool_use_id。正文一律不返回。 */
export function extractToolUseId(raw: string): string | undefined {
  return extractHookPairing(raw).toolUseId;
}

function readStdinText(): Promise<string> {
  return new Promise((resolveText) => {
    if (process.stdin.isTTY === true) {
      resolveText("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (text: string): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolveText(text);
    };
    timer = setTimeout(() => {
      process.stdin.pause();
      finish("");
    }, STDIN_WAIT_MS);
    process.stdin.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > STDIN_ID_BUDGET) {
        process.stdin.pause();
        finish("");
        return;
      }
      chunks.push(buf);
    });
    process.stdin.on("end", () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      finish("");
    });
    process.stdin.resume();
  });
}

/** 向控制通道上报一条 hook。失败也正常结束，避免卡住 CLI。 */
export function sendHookReport(
  pipePath: string,
  token: string,
  event: string,
  toolUseId?: string,
  pairing?: { readonly toolName?: string; readonly toolDigest?: string },
): Promise<void> {
  return new Promise((resolveReport) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveReport();
    };
    const socket = net.connect(pipePath);
    socket.setTimeout(HOOK_REPORT_TIMEOUT_MS);
    socket.on("timeout", finish);
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("connect", () => {
      const payload: {
        v: 1;
        type: "hook";
        token: string;
        event: string;
        toolUseId?: string;
        toolName?: string;
        toolDigest?: string;
      } = { v: 1, type: "hook", token, event };
      if (toolUseId !== undefined && TOOL_USE_ID.test(toolUseId)) {
        payload.toolUseId = toolUseId;
      }
      if (
        pairing?.toolName !== undefined &&
        pairing.toolDigest !== undefined &&
        isToolName(pairing.toolName) &&
        TOOL_DIGEST.test(pairing.toolDigest)
      ) {
        payload.toolName = pairing.toolName;
        payload.toolDigest = pairing.toolDigest;
      }
      socket.end(`${JSON.stringify(payload)}\n`);
    });
  });
}

const NAMED_HOOK_EVENTS = new Set([
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "UserPromptSubmit",
  "SessionStart",
]);

/** Codex notify 把事件 JSON 放在最后一个参数。agent-turn-complete 视为回合结束。 */
export function mapNotifyArgument(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return "";
  }
  try {
    const value = JSON.parse(trimmed) as { type?: unknown };
    if (value !== null && typeof value === "object" && value.type === "agent-turn-complete") {
      return "Stop";
    }
  } catch {
    return "";
  }
  return "";
}

/**
 * Claude 用 argv[2] 的事件名；Codex 用末尾的 notify JSON。
 * 先看末尾参数，避免把 JSON 正文当成事件名。
 */
export function resolveReportedHookEvent(argv: readonly string[]): string {
  for (let index = argv.length - 1; index >= 2; index -= 1) {
    const mapped = mapNotifyArgument(argv[index] ?? "");
    if (mapped !== "") {
      return mapped;
    }
  }
  const named = argv[2] ?? "";
  return NAMED_HOOK_EVENTS.has(named) ? named : "";
}

function invokedDirectly(): boolean {
  const entry = process.argv[1] ?? "";
  const normalized = entry.replaceAll("\\", "/");
  if (
    normalized.endsWith("/workbench-hook.js") ||
    normalized.endsWith("/workbench-hook.mjs") ||
    normalized.endsWith("/workbench-hook.ts")
  ) {
    return true;
  }
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const event = resolveReportedHookEvent(process.argv);
  const pipePath = process.env["FF_PANE_WB_PIPE"] ?? "";
  const token = process.env["FF_PANE_WINDOW_TOKEN"] ?? "";
  if (pipePath === "" || token === "" || event === "") {
    process.exit(0);
  }
  void readStdinText()
    .then((raw) => {
      const pairing = extractHookPairing(raw);
      return sendHookReport(pipePath, token, event, pairing.toolUseId, {
        ...(pairing.toolName !== undefined ? { toolName: pairing.toolName } : {}),
        ...(pairing.toolDigest !== undefined ? { toolDigest: pairing.toolDigest } : {}),
      });
    })
    .then(() => {
      process.exit(0);
    });
}
