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

export const WORKBENCH_HOOK_SCRIPT = "workbench-hook.mjs";

export const WORKBENCH_HOOK_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "UserPromptSubmit",
  "SessionStart",
] as const;

export type WorkbenchHookEvent = (typeof WORKBENCH_HOOK_EVENTS)[number];

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

export function prepareWindowHooks(input: {
  readonly windowId: string;
  readonly nodePath: string | undefined;
  readonly scriptPath: string;
}): PreparedWindowHooks {
  releaseWindowHooks(input.windowId);
  if (input.nodePath === undefined || input.nodePath.trim() === "") {
    return { notifyArgv: [], files: [] };
  }
  const nodePath = input.nodePath;
  const dir = join(tmpdir(), `ffpane-wb-hooks-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  dirs.set(input.windowId, dir);
  const claudeHooks: Record<string, unknown> = {};
  for (const event of WORKBENCH_HOOK_EVENTS) {
    claudeHooks[event] = [{ hooks: [claudeHookExec(nodePath, input.scriptPath, event)] }];
  }
  const settingsPath = join(dir, "claude-settings.json");
  writeFileSync(settingsPath, `${JSON.stringify({ hooks: claudeHooks }, null, 2)}\n`, "utf8");
  return {
    settingsPath,
    notifyArgv: [nodePath, input.scriptPath],
    files: [settingsPath],
  };
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
