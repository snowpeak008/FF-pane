/**
 * Cursor 账号管理（T11.18，计划 docs/Cursor账号管理计划.md）：
 * 设置里看 Cursor CLI 装没装、登录的哪个账号、什么档位、版本新不新；软件里登录 / 退出 / 更新 / 安装。
 *
 * - 状态：`status --format json`（不联网，读本地凭据）+ `about --format json`（档位、版本，要联网）。
 * - 登录：跑 `login` 并设 NO_OPEN_BROWSER，从输出里认出登录链接交给界面，由界面点「打开浏览器」；
 *   浏览器里登录完 CLI 自己存好凭据、以 0 退出。令牌只在 CLI 自己手里，界面只拿到邮箱、名字、档位。
 * - 换账号 = 退出再登录（Tony 2026-11-14 定，不另存多份令牌）。
 * - 安装：官方命令（PowerShell 从 cursor.com 下脚本执行），界面先确认。
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { stripAnsi } from "@ff-pane/adapters";
import { shell } from "electron";
import type {
  CursorAccountStatus,
  CursorCommandResult,
  CursorLoginEvent,
} from "../shared-ipc/contracts";
import { type InvokeHandlers, publishEvent } from "../shared-ipc/server";
import type { MainWindowGetter } from "./data";
import {
  type CursorCliTarget,
  cursorCommandEnv,
  resolveCursorCliTarget,
  runCursorCli,
} from "./workbench/cursor-cli";

/** 浏览器里登录最多等这么久。 */
export const CURSOR_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 更新、安装最多等这么久。 */
export const CURSOR_LONG_TASK_TIMEOUT_MS = 5 * 60_000;

/** 官方安装命令（Cursor 文档里的 Windows 装法）。 */
export const CURSOR_INSTALL_COMMAND = "irm 'https://cursor.com/install?win32=true' | iex";

/** `status --format json` → 登没登录、邮箱、名字。认不出返回 undefined。 */
export function parseCursorStatusJson(
  text: string,
):
  | { readonly authenticated: boolean; readonly email?: string; readonly name?: string }
  | undefined {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) {
    return undefined;
  }
  const authenticated = parsed["isAuthenticated"] === true || parsed["status"] === "authenticated";
  const user = parsed["userInfo"];
  const info =
    typeof user === "object" && user !== null ? (user as Record<string, unknown>) : undefined;
  const email = stringField(info, "email");
  const name = [stringField(info, "firstName"), stringField(info, "lastName")]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return {
    authenticated,
    ...(email !== undefined ? { email } : {}),
    ...(name !== "" ? { name } : {}),
  };
}

/** `about --format json` → 版本、档位、有没有新版。 */
export function parseCursorAboutJson(text: string):
  | {
      readonly version?: string;
      readonly tier?: string;
      readonly latestVersion?: string;
      readonly updateAvailable?: boolean;
      readonly email?: string;
    }
  | undefined {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) {
    return undefined;
  }
  const version = stringField(parsed, "cliVersion");
  const tier = stringField(parsed, "subscriptionTier");
  const latestVersion = stringField(parsed, "latestVersion");
  const latestStatus = stringField(parsed, "latestStatus");
  const email = stringField(parsed, "userEmail");
  return {
    ...(version !== undefined ? { version } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(latestVersion !== undefined ? { latestVersion } : {}),
    ...(latestStatus !== undefined ? { updateAvailable: latestStatus === "update_available" } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/** 只放行 https 的 cursor.com（含子域）链接：界面拿它去开系统浏览器。 */
export function isCursorLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "cursor.com" || host.endsWith(".cursor.com"));
  } catch {
    return false;
  }
}

/** 从 `login` 的输出里找登录链接。 */
export function findCursorLoginUrl(output: string): string | undefined {
  for (const match of stripAnsi(output).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const candidate = match[0].replace(/[).,;]+$/, "");
    if (isCursorLoginUrl(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 读当前状态。没装、取不到都不抛。 */
export async function readCursorAccountStatus(
  env: NodeJS.ProcessEnv = process.env,
  target: CursorCliTarget | undefined = resolveCursorCliTarget(env),
): Promise<CursorAccountStatus> {
  if (target === undefined) {
    return { installed: false };
  }
  const [status, about] = await Promise.all([
    runCursorCli(["status", "--format", "json"], { env, target, timeoutMs: 20_000 }),
    runCursorCli(["about", "--format", "json"], { env, target, timeoutMs: 20_000 }),
  ]);
  // 没登录时 status 可能以非 0 退出，但照样打印 JSON：两种情况都看输出。
  const auth = parseCursorStatusJson(status.stdout);
  const info = parseCursorAboutJson(about.stdout);
  const email = auth?.email ?? (auth?.authenticated === true ? info?.email : undefined);
  return {
    installed: true,
    version: info?.version ?? target.version,
    ...(auth !== undefined ? { authenticated: auth.authenticated } : {}),
    ...(email !== undefined && auth?.authenticated === true ? { email } : {}),
    ...(auth?.name !== undefined && auth.authenticated ? { name: auth.name } : {}),
    ...(info?.tier !== undefined && auth?.authenticated === true ? { tier: info.tier } : {}),
    ...(info?.latestVersion !== undefined ? { latestVersion: info.latestVersion } : {}),
    ...(info?.updateAvailable !== undefined ? { updateAvailable: info.updateAvailable } : {}),
    ...(auth === undefined && !status.ok ? { detail: status.detail } : {}),
  };
}

export interface CursorLoginDeps {
  readonly spawnLogin: () => ChildProcess | undefined;
  readonly publish: (event: CursorLoginEvent) => void;
  readonly readStatus: () => Promise<CursorAccountStatus>;
  readonly timeoutMs?: number;
}

export interface CursorLoginController {
  start(): { readonly ok: true } | { readonly ok: false; readonly error: string };
  cancel(): void;
  /** 认出来的登录链接（只有在登录中、而且认出来了才有）。 */
  currentUrl(): string | undefined;
  running(): boolean;
}

/** 一次只跑一个 `login`。认出链接、结束都发事件给界面。 */
export function createCursorLoginController(deps: CursorLoginDeps): CursorLoginController {
  let child: ChildProcess | undefined;
  let url: string | undefined;
  let finished = false;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  const finish = (event: CursorLoginEvent): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    child = undefined;
    url = undefined;
    deps.publish(event);
  };

  return {
    start() {
      if (child !== undefined) {
        return { ok: false, error: "已经在登录了。" };
      }
      const spawned = deps.spawnLogin();
      if (spawned === undefined) {
        return { ok: false, error: "没找到 Cursor CLI（cursor-agent）。" };
      }
      child = spawned;
      url = undefined;
      finished = false;
      cancelled = false;
      let output = "";
      const onData = (chunk: Buffer | string): void => {
        output += chunk.toString();
        if (output.length > 64_000) {
          output = output.slice(-64_000);
        }
        if (url === undefined) {
          const found = findCursorLoginUrl(output);
          if (found !== undefined) {
            url = found;
            deps.publish({ phase: "url", url: found });
          }
        }
      };
      spawned.stdout?.on("data", onData);
      spawned.stderr?.on("data", onData);
      spawned.on("error", (error) => {
        finish({ phase: "done", ok: false, error: error.message });
      });
      spawned.on("close", (code) => {
        if (cancelled) {
          finish({ phase: "done", ok: false, cancelled: true, error: "" });
          return;
        }
        if (code === 0) {
          void deps.readStatus().then(
            (status) => finish({ phase: "done", ok: true, status }),
            () => finish({ phase: "done", ok: true, status: { installed: true } }),
          );
          return;
        }
        finish({
          phase: "done",
          ok: false,
          error: stripAnsi(output).trim().slice(-600) || `cursor-agent login 退出码 ${code}`,
        });
      });
      timer = setTimeout(() => {
        if (child !== undefined) {
          child.kill();
        }
        finish({ phase: "done", ok: false, error: "等了 10 分钟还没在浏览器里登录完，已停下。" });
      }, deps.timeoutMs ?? CURSOR_LOGIN_TIMEOUT_MS);
      return { ok: true };
    },
    cancel() {
      if (child === undefined) {
        return;
      }
      cancelled = true;
      child.kill();
    },
    currentUrl() {
      return url;
    },
    running() {
      return child !== undefined;
    },
  };
}

type CursorChannel =
  | "cursor:status"
  | "cursor:login-start"
  | "cursor:login-cancel"
  | "cursor:login-open"
  | "cursor:logout"
  | "cursor:update"
  | "cursor:install";

export function createCursorAccountHandlers(
  getWindow: MainWindowGetter,
  env: NodeJS.ProcessEnv = process.env,
): Pick<InvokeHandlers, CursorChannel> {
  const login = createCursorLoginController({
    spawnLogin: () => {
      const target = resolveCursorCliTarget(env);
      if (target === undefined) {
        return undefined;
      }
      return spawn(target.nodeFile, [target.indexJs, "login"], {
        env: cursorCommandEnv(env, { NO_OPEN_BROWSER: "1" }),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    publish: (event) => {
      const window = getWindow();
      if (window !== null && !window.isDestroyed()) {
        publishEvent(window.webContents, "cursor:login", event);
      }
    },
    readStatus: () => readCursorAccountStatus(env),
  });

  return {
    "cursor:status": () => readCursorAccountStatus(env),
    "cursor:login-start": () => login.start(),
    "cursor:login-cancel": () => {
      login.cancel();
      return undefined;
    },
    "cursor:login-open": async () => {
      const url = login.currentUrl();
      if (url === undefined || !isCursorLoginUrl(url)) {
        return { ok: false };
      }
      await shell.openExternal(url);
      return { ok: true };
    },
    "cursor:logout": async () => commandResult(await runCursorCli(["logout"], { env })),
    "cursor:update": async () =>
      commandResult(
        await runCursorCli(["update"], { env, timeoutMs: CURSOR_LONG_TASK_TIMEOUT_MS }),
      ),
    "cursor:install": () => installCursorCli(env),
  };
}

function commandResult(run: Awaited<ReturnType<typeof runCursorCli>>): CursorCommandResult {
  return run.ok
    ? { ok: true, output: stripAnsi(`${run.stdout}\n${run.stderr}`).trim().slice(-2000) }
    : { ok: false, output: run.detail };
}

/** 跑官方安装命令。只在 Windows 上；界面已经让用户确认过。 */
async function installCursorCli(env: NodeJS.ProcessEnv): Promise<CursorCommandResult> {
  if (process.platform !== "win32") {
    return { ok: false, output: "只支持在 Windows 上一键安装。" };
  }
  const systemRoot = env["SYSTEMROOT"] ?? env["SystemRoot"] ?? "C:\\Windows";
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return await new Promise<CursorCommandResult>((done) => {
    execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        CURSOR_INSTALL_COMMAND,
      ],
      {
        env: cursorCommandEnv(env),
        timeout: CURSOR_LONG_TASK_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = stripAnsi(`${String(stdout)}\n${String(stderr)}`)
          .trim()
          .slice(-2000);
        if (error !== null) {
          done({ ok: false, output: output || error.message });
          return;
        }
        done({ ok: resolveCursorCliTarget(env) !== undefined, output });
      },
    );
  });
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = stripAnsi(text).trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
