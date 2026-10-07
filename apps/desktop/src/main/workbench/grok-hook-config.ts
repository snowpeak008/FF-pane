/**
 * Grok 项目钩子（T10.18）。
 * command 只写一个没有空格的程序路径。Grok 直接启动它，不经过 cmd。
 * 文件里没有令牌、没有密钥。多个窗口靠对话编号区分。
 * 不写用户 ~/.grok/config.toml、~/.grok/hooks、~/.claude、~/.cursor。
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";
import { assertNotUserGrokPath } from "./grok-mcp-config";

export const GROK_HOOK_EXE_NAME = "ffpane-grok-hook.exe";
export const GROK_HOOK_FILE_NAME = "ffpane-workbench.json";

const SHELL_METACHAR = /[\s|&$<>"'`;()]/;

function pathIsUnder(candidate: string, root: string): boolean {
  const left = candidate.toLowerCase();
  const right = root.toLowerCase();
  return left === right || left.startsWith(right + sep);
}

/** 没有空格和 shell 符号的绝对路径，Grok 才会直接启动这一个文件。 */
export function grokHookCommandIsDirect(command: string): boolean {
  if (command.length === 0 || command !== command.trim()) {
    return false;
  }
  if (!isAbsolute(command)) {
    return false;
  }
  return !SHELL_METACHAR.test(command);
}

export function selectGrokHookCommand(input: {
  readonly bundledPath: string;
  readonly bundledExists: boolean;
  readonly fallbackPath?: string;
}): { readonly command?: string; readonly copy: boolean } {
  if (input.bundledExists && grokHookCommandIsDirect(input.bundledPath)) {
    return { command: input.bundledPath, copy: false };
  }
  if (
    input.bundledExists &&
    input.fallbackPath !== undefined &&
    grokHookCommandIsDirect(input.fallbackPath)
  ) {
    return { command: input.fallbackPath, copy: true };
  }
  return { copy: false };
}

export function grokHookFallbackPath(localAppData: string | undefined): string | undefined {
  const root = localAppData?.trim() ?? "";
  if (root === "") {
    return undefined;
  }
  return join(root, "ff-pane", GROK_HOOK_EXE_NAME);
}

/** 路径能直接启动就用它。安装目录有空格时，复制到一份没有空格的路径。复制失败就不装钩子。 */
export function resolveGrokHookCommand(input: {
  readonly bundledPath: string;
  readonly localAppData?: string;
}): string | undefined {
  const bundledExists = input.bundledPath.trim() !== "" && existsSync(input.bundledPath);
  const fallbackPath = grokHookFallbackPath(input.localAppData);
  const selected = selectGrokHookCommand({
    bundledPath: input.bundledPath,
    bundledExists,
    ...(fallbackPath !== undefined ? { fallbackPath } : {}),
  });
  if (selected.command === undefined) {
    return undefined;
  }
  if (!selected.copy) {
    return selected.command;
  }
  try {
    mkdirSync(dirname(selected.command), { recursive: true });
    copyFileSync(input.bundledPath, selected.command);
  } catch {
    return undefined;
  }
  return grokHookCommandIsDirect(selected.command) ? selected.command : undefined;
}

export function bundledGrokHookPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  if (input.isPackaged) {
    return join(input.resourcesPath, GROK_HOOK_EXE_NAME);
  }
  return join(input.appPath, "resources", GROK_HOOK_EXE_NAME);
}

/** 上报的对话编号必须和这个窗口自己的编号一致。缺一边时不拿它否决。 */
export function grokHookSessionMatches(
  expected: string | undefined,
  reported: string | undefined,
): boolean {
  const left = expected?.trim() ?? "";
  const right = reported?.trim() ?? "";
  if (left === "" || right === "") {
    return true;
  }
  return left === right;
}

function assertNotUserHookHomes(target: string): void {
  assertNotUserGrokPath(target);
  const home = homedir();
  for (const name of [".claude", ".cursor"] as const) {
    const root = resolve(home, name);
    const candidates = [resolve(target)];
    if (existsSync(dirname(target))) {
      try {
        candidates.push(resolve(dirname(target), basename(target)));
      } catch {
        // 父目录打不开时不额外放行
      }
    }
    for (const candidate of candidates) {
      if (pathIsUnder(candidate, root)) {
        throw new Error(`refusing to write user ~/${name}`);
      }
    }
  }
}

export function grokProjectHookPath(projectRoot: string): string {
  return join(projectRoot, ".grok", "hooks", GROK_HOOK_FILE_NAME);
}

/** command 只有程序路径。没有参数，没有 env，没有令牌。 */
export function buildGrokWorkbenchHookDocument(command: string): string {
  if (!grokHookCommandIsDirect(command)) {
    throw new Error("grok hook command must be one path without spaces");
  }
  const observe = { type: "command", command, timeout: 5 };
  const stop = { type: "command", command, timeout: 10 };
  const document = {
    hooks: {
      Stop: [{ hooks: [stop] }],
      StopFailure: [{ hooks: [observe] }],
      StopCancelled: [{ hooks: [observe] }],
      PermissionDenied: [{ hooks: [observe] }],
      Notification: [{ matcher: "permission_prompt", hooks: [observe] }],
      PostToolUse: [{ hooks: [observe] }],
      PostToolUseFailure: [{ hooks: [observe] }],
      UserPromptSubmit: [{ hooks: [observe] }],
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function writeGrokWorkbenchHookFile(input: {
  readonly projectRoot: string;
  readonly command: string;
}): Promise<string> {
  const filePath = grokProjectHookPath(input.projectRoot);
  assertNotUserHookHomes(filePath);
  const body = buildGrokWorkbenchHookDocument(input.command);
  assertNotUserHookHomes(filePath);
  await writeTextAtomic(filePath, body);
  return filePath;
}
