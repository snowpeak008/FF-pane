/**
 * Gemini 窗口（agy 本机登录）的账号状态（T11.23 计划 §10）。
 *
 * agy 没有 status / login 子命令，登录信息存在 Windows 凭据管理器的 `gemini:antigravity` 条目里
 * （2026-11-28 实测；换 HOME 隔离不了，`agy models` 和 cli.log 的「未登录」警告也不能当依据）。
 * 所以这里只看两件事：agy 在不在、凭据条目在不在。不调用模型，不耗额度，不读令牌内容。
 * 条目在只说明登录过，不保证令牌现在有效；真失效要等读取模型或开窗才知道，由界面标「连接失败」。
 */

import { execFile } from "node:child_process";
import { stripAnsi } from "@ff-pane/adapters";
import type { CursorCommandResult, GeminiAccountStatus } from "../shared-ipc/contracts";
import type { InvokeHandlers } from "../shared-ipc/server";
import { agyCommandEnv, resolveAgyTarget } from "./workbench/agy-cli";

/** agy 登录后写进凭据管理器的条目名。 */
export const AGY_CREDENTIAL_TARGET = "gemini:antigravity";

/** 官方安装命令。 */
export const GEMINI_INSTALL_COMMAND = "irm https://antigravity.google/cli/install.ps1 | iex";

const LONG_TASK_TIMEOUT_MS = 5 * 60_000;

/**
 * `cmdkey /list` 的输出里有没有 agy 的条目。
 * 只认纯 ASCII 的 `target=gemini:antigravity` 这一段，不受系统语言影响；
 * 行尾必须到头，免得把 `gemini:antigravity-xxx` 之类的别的条目当成它。
 */
export function hasAgyCredential(cmdkeyOutput: string): boolean {
  return /target=gemini:antigravity[ \t]*\r?$/im.test(cmdkeyOutput);
}

export interface GeminiStatusDeps {
  readonly platform: NodeJS.Platform;
  readonly resolveTarget: (env: NodeJS.ProcessEnv) => string | undefined;
  /** 返回 `cmdkey /list` 的输出；读不了就抛。 */
  readonly listCredentials: (env: NodeJS.ProcessEnv) => Promise<string>;
}

function systemTool(env: NodeJS.ProcessEnv, name: string): string {
  const root = env["SYSTEMROOT"] ?? env["SystemRoot"] ?? "C:\\Windows";
  return `${root}\\System32\\${name}`;
}

const realDeps: GeminiStatusDeps = {
  platform: process.platform,
  resolveTarget: (env) => resolveAgyTarget(env),
  listCredentials: (env) =>
    new Promise<string>((done, fail) => {
      // 输出是系统本地编码（中文系统是 GBK），按 latin1 读，不会丢字节；我们只认 ASCII 段。
      execFile(
        systemTool(env, "cmdkey.exe"),
        ["/list"],
        { encoding: "latin1", timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            fail(error);
            return;
          }
          done(String(stdout));
        },
      );
    }),
};

/** 读当前状态。没装、读不了都不抛。 */
export async function readGeminiAccountStatus(
  env: NodeJS.ProcessEnv = process.env,
  deps: GeminiStatusDeps = realDeps,
): Promise<GeminiAccountStatus> {
  if (deps.resolveTarget(env) === undefined) {
    return { installed: false };
  }
  if (deps.platform !== "win32") {
    return { installed: true, detail: "只有 Windows 能读到 agy 的登录状态。" };
  }
  try {
    const output = await deps.listCredentials(env);
    return { installed: true, authenticated: hasAgyCredential(output) };
  } catch (error) {
    return {
      installed: true,
      detail: `读不了 Windows 凭据管理器：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type GeminiChannel = "gemini:status" | "gemini:install";

export function createGeminiAccountHandlers(
  env: NodeJS.ProcessEnv = process.env,
): Pick<InvokeHandlers, GeminiChannel> {
  return {
    "gemini:status": () => readGeminiAccountStatus(env),
    "gemini:install": () => installAgy(env),
  };
}

/** 跑官方安装命令。只在 Windows 上；界面已经让用户确认过。 */
async function installAgy(env: NodeJS.ProcessEnv): Promise<CursorCommandResult> {
  if (process.platform !== "win32") {
    return { ok: false, output: "只支持在 Windows 上一键安装。" };
  }
  const powershell = `${systemTool(env, "WindowsPowerShell\\v1.0\\powershell.exe")}`;
  return await new Promise<CursorCommandResult>((done) => {
    execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        GEMINI_INSTALL_COMMAND,
      ],
      {
        env: agyCommandEnv(env),
        timeout: LONG_TASK_TIMEOUT_MS,
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
        done({ ok: resolveAgyTarget(env) !== undefined, output });
      },
    );
  });
}
