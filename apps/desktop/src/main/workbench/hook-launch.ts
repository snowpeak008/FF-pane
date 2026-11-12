/**
 * 按窗口装配观察型 hooks（T10.6'）。
 * Claude：`--settings` 里用 exec 形态（command = node.exe，args = [脚本, 固定事件名]）。
 * 官方文档：带 args 时忽略 shell；事件 JSON 只走 stdin。这里的命令不含任何外部文本。
 * Codex：`-c notify=[node.exe, 脚本]`。Codex 把事件 JSON 追加为最后一个参数，不经 shell。
 * 没有 node.exe 时不装配，该窗口投递保持手动确认。
 * settings 不含令牌。
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeProviderSettings } from "./claude-provider-settings";

export const WORKBENCH_HOOK_SCRIPT = "workbench-hook.mjs";

export const WORKBENCH_HOOK_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  // 一轮因 API 错误（限流、过载、认证失败等）结束时代替 Stop 触发。不接它，窗口会一直算忙。
  "StopFailure",
  "UserPromptSubmit",
  "SessionStart",
] as const;

export type WorkbenchHookEvent = (typeof WORKBENCH_HOOK_EVENTS)[number] | "PreToolUse";

/**
 * 项目外写入检查（T11.8）挂在这些工具的 PreToolUse 上。只在主进程给了允许目录
 * （环境变量 FF_PANE_WRITE_ROOTS）时才真的检查，hook 不上报、不连管道。
 */
export const WRITE_GUARD_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell";

export interface PreparedWindowHooks {
  /** 有 node 时才写。Claude `--settings` 指向它。 */
  readonly settingsPath?: string;
  /** Codex `-c notify=`。无 node 时为空，调用方不传 notify。 */
  readonly notifyArgv: readonly string[];
  /** 启动前扫描“不得含令牌明文”。 */
  readonly files: readonly string[];
}

const dirs = new Map<string, string>();

/** 打包后在 resources/；开发态在主进程产物目录。两处都是普通文件，不在 asar 里。 */
export function resolveWorkbenchHookScriptPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly moduleDir: string;
}): string {
  if (input.isPackaged) {
    return join(input.resourcesPath, WORKBENCH_HOOK_SCRIPT);
  }
  return join(input.moduleDir, WORKBENCH_HOOK_SCRIPT);
}

/**
 * Claude exec 形态的一条 hook。command 与 args 都是我们固定的路径和事件名。
 * 不拼 shell 字符串，路径里的空格和非 ASCII 保持为单独的参数。
 */
export function claudeHookExec(
  nodePath: string,
  scriptPath: string,
  event: WorkbenchHookEvent,
): { readonly type: "command"; readonly command: string; readonly args: readonly string[] } {
  return {
    type: "command",
    command: nodePath,
    args: [scriptPath, event],
  };
}

/**
 * claudeProvider：Claude 中转窗口的地址、模型和 apiKeyHelper，与 hooks 写进同一份 `--settings`。
 * 没有 node 时不装 hooks，但有 claudeProvider 仍要写这份文件。
 */
export function prepareWindowHooks(input: {
  readonly windowId: string;
  readonly nodePath: string | undefined;
  readonly scriptPath: string;
  readonly claudeProvider?: ClaudeProviderSettings;
}): PreparedWindowHooks {
  releaseWindowHooks(input.windowId);
  const nodePath =
    input.nodePath === undefined || input.nodePath.trim() === "" ? undefined : input.nodePath;
  if (nodePath === undefined && input.claudeProvider === undefined) {
    return { notifyArgv: [], files: [] };
  }
  const dir = join(tmpdir(), `ffpane-wb-hooks-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  dirs.set(input.windowId, dir);
  const settings: Record<string, unknown> = {};
  if (nodePath !== undefined) {
    const claudeHooks: Record<string, unknown> = {};
    for (const event of WORKBENCH_HOOK_EVENTS) {
      claudeHooks[event] = [{ hooks: [claudeHookExec(nodePath, input.scriptPath, event)] }];
    }
    claudeHooks["PreToolUse"] = [
      {
        matcher: WRITE_GUARD_TOOL_MATCHER,
        hooks: [claudeHookExec(nodePath, input.scriptPath, "PreToolUse")],
      },
    ];
    settings["hooks"] = claudeHooks;
  }
  if (input.claudeProvider !== undefined) {
    settings["env"] = input.claudeProvider.env;
    if (input.claudeProvider.apiKeyHelper !== undefined) {
      settings["apiKeyHelper"] = input.claudeProvider.apiKeyHelper;
    }
  }
  const settingsPath = join(dir, "claude-settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return {
    settingsPath,
    notifyArgv: nodePath !== undefined ? [nodePath, input.scriptPath] : [],
    files: [settingsPath],
  };
}

/** 本窗口的钩子临时目录（装了钩子才有）。Cursor 的插件和说明文件也放这里，关窗一起删。 */
export function windowHookDir(windowId: string): string | undefined {
  return dirs.get(windowId);
}

export function releaseWindowHooks(windowId: string): void {
  const dir = dirs.get(windowId);
  if (dir === undefined) {
    return;
  }
  dirs.delete(windowId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 窗口已经退出，临时目录清不掉也不影响下一次启动
  }
}
