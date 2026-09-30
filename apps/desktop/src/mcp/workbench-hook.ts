/**
 * 工作台观察型 hook（T10.6'）。
 * Claude：argv 里只有我们固定的事件名；事件 JSON 在 stdin，本脚本不读、不执行。
 * Codex notify：事件 JSON 是最后一个参数。只读取 type，agent-turn-complete 映射成 Stop。
 * 正文（last-assistant-message 等）不进入上报、不写文件、不交给 shell。
 * 从环境变量读取管道名和窗口令牌，上报事件名后立刻退出 0。
 * 不写 stdout、不写日志、不把令牌落盘。退出码恒为 0，不返回 allow/deny。
 */

import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_REPORT_TIMEOUT_MS = 1500;

/** 向控制通道上报一条 hook。失败也正常结束，避免卡住 CLI。 */
export function sendHookReport(pipePath: string, token: string, event: string): Promise<void> {
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
      const line = `${JSON.stringify({ v: 1, type: "hook", token, event })}\n`;
      socket.end(line);
    });
  });
}

const NAMED_HOOK_EVENTS = new Set([
  "PermissionRequest",
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
  void sendHookReport(pipePath, token, event).then(() => {
    process.exit(0);
  });
}
