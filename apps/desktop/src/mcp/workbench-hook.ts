/**
 * 工作台观察型 hook（T10.6' / T10.7b）。
 * Claude：argv 里只有我们固定的事件名。stdin 上的事件 JSON 只取出 tool_use_id、
 * tool_name + 规范化 tool_input 的 SHA-256，以及 SessionStart / UserPromptSubmit 的 session_id。
 * 工具正文不进入上报、不写文件、不交给 shell。
 * Codex notify：事件 JSON 是最后一个参数。只读取 type 和 thread-id：agent-turn-complete 映射成 Stop，
 * thread-id 作为会话编号一并上报（主进程凭窗口令牌认窗口，凭它认会话，不去扫 sessions 目录）。
 * 从环境变量读取管道名和窗口令牌，上报后立刻退出 0。
 * 不写日志、不把令牌落盘。退出码恒为 0，不返回 allow/deny。
 * 唯一的 stdout：Claude 的 UserPromptSubmit 提交的是工作台「[新消息]」提醒时，
 * 向主进程取未读正文，作为 additionalContext 交给模型（读出即标记已读）；
 * 提交的是用户自己的话时，只取一句「还有几条未读、谁发的」（不标已读）。取不到就什么也不写。
 * PreToolUse（T11.8）：只做项目外写入检查（见 write-guard.ts），不上报主进程、不连管道；该拒绝就输出拒绝。
 * 干活中途（T11.7）：Claude 每调用完一个工具（PostToolUse / PostToolUseFailure），问一次主进程
 * 有没有上级或用户本人的新消息，有就作为 additionalContext 插进去，模型下一步就能看到。不往终端打字。
 */

import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWrite, denyHookOutput, parseWriteRoots, WRITE_ROOTS_ENV } from "./write-guard";

export const HOOK_REPORT_TIMEOUT_MS = 1500;
export const INBOX_DIGEST_TIMEOUT_MS = 3000;
/** 每调用完一个工具都要问一次，CLI 等着 hook 退出，所以给得短；取不到就算了，这一轮结束还有提醒。 */
export const MID_TURN_TIMEOUT_MS = 800;
export const INBOX_REMINDER_PREFIX = "[新消息]";
/** 与 main/workbench/claude-provider-settings.ts 同名常量保持一致（脚本单独打包，不 import 主进程）。 */
export const CLAUDE_KEY_ENV = "FF_PANE_CLAUDE_KEY";
export const CLAUDE_KEY_HELPER_EVENT = "ApiKey";

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
  errorType?: string,
  sessionId?: string,
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
    socket.on("end", finish);
    // 必须读掉回执：不读时连接停在暂停态，socket 超时又不保活，进程会在 resolve 之前直接退出，
    // 后面取收件箱正文的步骤就跑不到。
    socket.on("data", finish);
    socket.on("connect", () => {
      const payload: {
        v: 1;
        type: "hook";
        token: string;
        event: string;
        toolUseId?: string;
        toolName?: string;
        toolDigest?: string;
        errorType?: string;
        sessionId?: string;
      } = { v: 1, type: "hook", token, event };
      if (sessionId !== undefined && THREAD_ID.test(sessionId)) {
        payload.sessionId = sessionId;
      }
      if (errorType !== undefined && ERROR_TYPE.test(errorType)) {
        payload.errorType = errorType;
      }
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

const ERROR_TYPE = /^[a-z_]{1,40}$/;
const THREAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Codex notify 的事件 JSON（最后一个参数）里的 thread-id，就是这个窗口的会话编号。
 * 只取这一个字段，别的（输入消息、回复正文）一律不碰。
 */
export function extractNotifyThreadId(argv: readonly string[]): string | undefined {
  for (let index = argv.length - 1; index >= 2; index -= 1) {
    const trimmed = (argv[index] ?? "").trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(trimmed) as { "thread-id"?: unknown };
      const id = value?.["thread-id"];
      return typeof id === "string" && THREAD_ID.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Claude 换了对话也会报这两种事件：开新会话、续接、/clear 走 SessionStart，每次提交走 UserPromptSubmit。 */
const SESSION_REPORT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

/**
 * Claude hook stdin 里的 session_id，就是这个窗口当前的对话编号。在 Claude 里 /resume、/clear 换了对话，
 * 平台靠它记上新编号，下次续接不再接回旧的。只取这一个字段。
 */
export function extractHookSessionId(event: string, raw: string): string | undefined {
  if (!SESSION_REPORT_EVENTS.has(event)) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const id = (JSON.parse(trimmed) as { session_id?: unknown })?.session_id;
    return typeof id === "string" && THREAD_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** StopFailure 的 stdin 里只取错误类型（rate_limit 之类），不取错误正文。 */
export function extractStopFailureType(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const value = JSON.parse(trimmed) as { error?: unknown };
    return typeof value?.error === "string" && ERROR_TYPE.test(value.error)
      ? value.error
      : undefined;
  } catch {
    return undefined;
  }
}

/** UserPromptSubmit 的 stdin 里，prompt 是否是工作台打进来的新消息提醒。只返回真假。 */
export function promptIsInboxReminder(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const value = JSON.parse(trimmed) as { prompt?: unknown };
    return (
      value !== null &&
      typeof value === "object" &&
      typeof value.prompt === "string" &&
      value.prompt.trimStart().startsWith(INBOX_REMINDER_PREFIX)
    );
  } catch {
    return false;
  }
}

/**
 * 向控制通道取附加上下文。inbox-digest：未读正文（标为已读）；inbox-peek：只说有几条未读、谁发的；
 * inbox-midturn：干活中途该看的上级和用户本人的消息（T11.7）。超时、拒绝或断开都返回空串。
 */
export function requestInboxDigest(
  pipePath: string,
  token: string,
  timeoutMs = INBOX_DIGEST_TIMEOUT_MS,
  type: "inbox-digest" | "inbox-peek" | "inbox-midturn" = "inbox-digest",
): Promise<string> {
  return new Promise((resolveDigest) => {
    let settled = false;
    let buffer = "";
    const finish = (text: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveDigest(text);
    };
    const socket = net.connect(pipePath);
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(""));
    socket.on("error", () => finish(""));
    socket.on("close", () => finish(""));
    socket.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as {
          readonly ok?: unknown;
          readonly result?: { readonly text?: unknown };
        };
        const text = parsed.ok === true ? parsed.result?.text : undefined;
        finish(typeof text === "string" ? text : "");
      } catch {
        finish("");
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ v: 1, type, token })}\n`);
    });
  });
}

/** Claude hook 的附加上下文输出：UserPromptSubmit，或干活中途的 PostToolUse / PostToolUseFailure。 */
export function inboxHookOutput(
  text: string,
  hookEventName: "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" = "UserPromptSubmit",
): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

/**
 * PreToolUse 的项目外写入检查（T11.8）。stdin 里取 tool_name、tool_input、cwd；
 * 该拒绝返回要写到 stdout 的那一行，放行返回空串。
 */
export function writeGuardOutput(raw: string, rootsEnv: string | undefined): string {
  const roots = parseWriteRoots(rootsEnv);
  if (roots.length === 0) {
    return "";
  }
  let value: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    value = JSON.parse(raw.trim()) as typeof value;
  } catch {
    return "";
  }
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.tool_name !== "string" ||
    value.tool_input === null ||
    typeof value.tool_input !== "object"
  ) {
    return "";
  }
  const reason = checkWrite(
    {
      toolName: value.tool_name,
      toolInput: value.tool_input as Record<string, unknown>,
      cwd: typeof value.cwd === "string" && value.cwd !== "" ? value.cwd : process.cwd(),
    },
    roots,
    homedir(),
    tmpdir(),
  );
  return reason === undefined ? "" : denyHookOutput(reason);
}

/** 写一行 stdout 再返回，保证进程退出前写完。 */
function writeStdoutLine(line: string): Promise<void> {
  return new Promise<void>((done) => {
    process.stdout.write(`${line}\n`, () => done());
  });
}

const NAMED_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
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

// ---------- Cursor（T11.10）----------
// 项目 .cursor/hooks.json 里的命令是 `"<node>" "<本脚本>" Cursor…`。stdin 是 Cursor 的事件 JSON，
// stdout 回 Cursor 的格式。同项目的窗口共用这一份文件，靠环境里的窗口令牌认窗口；
// 用户在 Cursor 编辑器里打开项目时也会跑到这里，那时没有令牌，什么也不做。

export const CURSOR_SCRIPT_EVENTS = new Set([
  "CursorSessionStart",
  "CursorPromptSubmit",
  "CursorPreToolUse",
  "CursorPostToolUse",
  "CursorStop",
]);

/** 钩子读完就删的说明文件（与主进程 cursor-hook-config.ts 同名）。 */
export const CURSOR_CONTEXT_FILE_ENV = "FF_PANE_CURSOR_CONTEXT_FILE";

/**
 * Cursor 的钩子经 PowerShell 转一道，控制台代码页不是 UTF-8 时中文会乱。
 * 输出只用 ASCII：非 ASCII 字符一律写成 \uXXXX，JSON 读出来一样。
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** stop 的 status：completed / aborted 当正常结束，error 当出错结束（不知道具体原因）。 */
export function cursorStopEvent(raw: string): "Stop" | "StopFailure" {
  try {
    const status = (JSON.parse(raw.trim()) as { status?: unknown })?.status;
    return status === "error" ? "StopFailure" : "Stop";
  } catch {
    return "Stop";
  }
}

const CURSOR_FILE_TOOLS = new Set([
  "Write",
  "Edit",
  "StrReplace",
  "MultiEdit",
  "Delete",
  "EditNotebook",
]);

/**
 * preToolUse 的项目外写入检查。工具名换成 Claude 的再用同一套检查：
 * 改文件类看 file_path（或 path），Shell 当 PowerShell 查。该拒绝返回 Cursor 的拒绝输出，放行返回空串。
 */
export function cursorWriteGuardOutput(raw: string, rootsEnv: string | undefined): string {
  const roots = parseWriteRoots(rootsEnv);
  if (roots.length === 0) {
    return "";
  }
  let value: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    value = JSON.parse(raw.trim()) as typeof value;
  } catch {
    return "";
  }
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.tool_name !== "string" ||
    value.tool_input === null ||
    typeof value.tool_input !== "object"
  ) {
    return "";
  }
  const input = value.tool_input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const item = input[key];
      if (typeof item === "string" && item.trim() !== "") {
        return item;
      }
    }
    return undefined;
  };
  const cwd =
    pick("cwd") ??
    (typeof value.cwd === "string" && value.cwd !== "" ? value.cwd : undefined) ??
    process.cwd();
  let guarded: { toolName: string; toolInput: Record<string, unknown> } | undefined;
  if (CURSOR_FILE_TOOLS.has(value.tool_name)) {
    const filePath = pick("file_path", "path", "target_file");
    guarded =
      filePath === undefined
        ? undefined
        : { toolName: "Write", toolInput: { file_path: filePath } };
  } else if (value.tool_name === "Shell") {
    const command = pick("command");
    guarded =
      command === undefined ? undefined : { toolName: "PowerShell", toolInput: { command } };
  }
  if (guarded === undefined) {
    return "";
  }
  const reason = checkWrite({ ...guarded, cwd }, roots, homedir(), tmpdir());
  return reason === undefined
    ? ""
    : asciiJson({ permission: "deny", user_message: reason, agent_message: reason });
}

/** 读出本窗口的说明并删掉文件，只交给模型一次。没有就返回空串。 */
function consumeCursorContext(): string {
  const file = process.env[CURSOR_CONTEXT_FILE_ENV]?.trim() ?? "";
  if (file === "") {
    return "";
  }
  try {
    const text = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    return text.trim();
  } catch {
    return "";
  }
}

async function runCursorHook(event: string, pipePath: string, token: string): Promise<void> {
  const raw = await readStdinText();
  if (event === "CursorPreToolUse") {
    // 只做项目外写入检查，不上报、不需要管道。
    const out = cursorWriteGuardOutput(raw, process.env[WRITE_ROOTS_ENV]);
    if (out !== "") {
      await writeStdoutLine(out);
    }
    return;
  }
  if (pipePath === "" || token === "") {
    return;
  }
  if (event === "CursorStop") {
    const reported = cursorStopEvent(raw);
    await sendHookReport(
      pipePath,
      token,
      reported,
      undefined,
      undefined,
      reported === "StopFailure" ? "unknown" : undefined,
    );
    return;
  }
  if (event === "CursorPostToolUse") {
    const pairing = extractHookPairing(raw);
    await sendHookReport(pipePath, token, "PostToolUse", pairing.toolUseId, {
      ...(pairing.toolName !== undefined ? { toolName: pairing.toolName } : {}),
      ...(pairing.toolDigest !== undefined ? { toolDigest: pairing.toolDigest } : {}),
    });
    // 干活中途：上级或用户本人有新消息就插进去。
    const midTurn = await requestInboxDigest(pipePath, token, MID_TURN_TIMEOUT_MS, "inbox-midturn");
    if (midTurn !== "") {
      await writeStdoutLine(asciiJson({ additional_context: midTurn }));
    }
    return;
  }
  const reportedEvent = event === "CursorSessionStart" ? "SessionStart" : "UserPromptSubmit";
  await sendHookReport(
    pipePath,
    token,
    reportedEvent,
    undefined,
    undefined,
    undefined,
    extractHookSessionId(reportedEvent, raw),
  );
  // 新开会话在 sessionStart 交说明；续接没有 sessionStart，就在第一次提交时交。
  const parts = [consumeCursorContext()];
  if (event === "CursorPromptSubmit") {
    // 平台的新消息提醒：附上未读正文。用户自己发的话：只提一句还有几条未读。
    parts.push(
      await requestInboxDigest(
        pipePath,
        token,
        INBOX_DIGEST_TIMEOUT_MS,
        promptIsInboxReminder(raw) ? "inbox-digest" : "inbox-peek",
      ),
    );
  }
  const text = parts.filter((part) => part !== "").join("\n\n");
  if (text !== "") {
    await writeStdoutLine(asciiJson({ additional_context: text }));
  }
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
  const named = process.argv[2] ?? "";
  if (named === CLAUDE_KEY_HELPER_EVENT) {
    // Claude 的 apiKeyHelper：只把本窗口进程环境里的密钥交给 Claude，不上报、不连管道。
    process.stdout.write(process.env[CLAUDE_KEY_ENV] ?? "", () => {
      process.exit(0);
    });
  } else if (CURSOR_SCRIPT_EVENTS.has(named)) {
    void runCursorHook(named, pipePath, token)
      .catch(() => undefined)
      .then(() => {
        process.exit(0);
      });
  } else if (event === "PreToolUse") {
    // 只做项目外写入检查，不上报、不需要管道。
    void readStdinText()
      .then(async (raw) => {
        const out = writeGuardOutput(raw, process.env[WRITE_ROOTS_ENV]);
        if (out !== "") {
          await writeStdoutLine(out);
        }
      })
      .catch(() => undefined)
      .then(() => {
        process.exit(0);
      });
  } else if (pipePath === "" || token === "" || event === "") {
    process.exit(0);
  } else {
    void readStdinText()
      .then(async (raw) => {
        const pairing = extractHookPairing(raw);
        await sendHookReport(
          pipePath,
          token,
          event,
          pairing.toolUseId,
          {
            ...(pairing.toolName !== undefined ? { toolName: pairing.toolName } : {}),
            ...(pairing.toolDigest !== undefined ? { toolDigest: pairing.toolDigest } : {}),
          },
          event === "StopFailure" ? (extractStopFailureType(raw) ?? "unknown") : undefined,
          extractNotifyThreadId(process.argv) ?? extractHookSessionId(event, raw),
        );
        if (event === "PostToolUse" || event === "PostToolUseFailure") {
          // 干活中途：上级或用户本人有新消息就插进去。
          const midTurn = await requestInboxDigest(
            pipePath,
            token,
            MID_TURN_TIMEOUT_MS,
            "inbox-midturn",
          );
          if (midTurn !== "") {
            await writeStdoutLine(inboxHookOutput(midTurn, event));
          }
          return;
        }
        if (event !== "UserPromptSubmit") {
          return;
        }
        // 平台的新消息提醒：附上未读正文。用户自己发的话：只提一句还有几条未读。
        const digest = await requestInboxDigest(
          pipePath,
          token,
          INBOX_DIGEST_TIMEOUT_MS,
          promptIsInboxReminder(raw) ? "inbox-digest" : "inbox-peek",
        );
        if (digest !== "") {
          await writeStdoutLine(inboxHookOutput(digest));
        }
      })
      .catch(() => undefined)
      .then(() => {
        process.exit(0);
      });
  }
}
