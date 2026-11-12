/**
 * Cursor 窗口的插件目录和项目钩子（T11.10，计划 §3.2 / §3.3）。
 *
 * - 插件目录（每个窗口一份，放在本窗口的钩子临时目录里，关窗一起删）：只有 MCP。
 *   令牌和管道名只写 `${env:…}`，由 Cursor 从 CLI 进程环境展开。
 * - 项目钩子 `<git 根>/.cursor/hooks.json`：Cursor 交互界面只在用户级或项目级文件里有
 *   beforeSubmitPrompt / stop 时才触发这两个钩子，只写在插件里不触发，所以只能写项目级。
 *   合并写，只动命令里带本软件钩子脚本和 `Cursor…` 事件名的条目，用户自己的条目原样保留。
 *   同项目的多个窗口共用这一份，靠环境里的窗口令牌区分。文件里没有令牌、没有密钥。
 * - 项目权限 `<git 根>/.cursor/cli.json`：permissions.allow 里加一条放行工作台 MCP 的规则，同 Claude 窗口的
 *   `--allowedTools mcp__ffpane-workbench`。只加不删，别的键和用户自己的规则原样保留。钩子回 allow 跳不过
 *   Cursor 的「Run this MCP tool?」，用户级配置又不能碰，只能写这里（T11.10 实测）。
 * - 绝不写用户 `~/.cursor`。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";

/** Cursor 事件 → 传给钩子脚本的事件名。 */
export const CURSOR_HOOK_EVENTS = {
  sessionStart: "CursorSessionStart",
  beforeSubmitPrompt: "CursorPromptSubmit",
  preToolUse: "CursorPreToolUse",
  postToolUse: "CursorPostToolUse",
  stop: "CursorStop",
} as const;

export type CursorHookScriptEvent = (typeof CURSOR_HOOK_EVENTS)[keyof typeof CURSOR_HOOK_EVENTS];

export const CURSOR_PLUGIN_NAME = "ffpane";
/** 钩子读完就删的说明文件（角色说明 + 技能清单）。 */
export const CURSOR_CONTEXT_FILE_ENV = "FF_PANE_CURSOR_CONTEXT_FILE";

/** 本软件写进 hooks.json 的条目：`"<node>" "<…workbench-hook.mjs>" Cursor…`。 */
const OWN_COMMAND = /workbench-hook\.m?js"?\s+Cursor[A-Za-z]+\s*$/;

/** 双引号里 PowerShell 会展开的字符，以及引号本身。路径里有就不装钩子。 */
const UNSAFE_IN_QUOTES = /["`$\r\n]/;

function pathIsUnder(candidate: string, root: string): boolean {
  const left = candidate.toLowerCase();
  const right = root.toLowerCase();
  return left === right || left.startsWith(right + sep);
}

/** 目标若落在用户 `~/.cursor`（含符号链接）则拒绝。 */
export function assertNotUserCursorPath(target: string, home: string = homedir()): void {
  const root = resolve(home, ".cursor");
  const candidates = [resolve(target)];
  const parent = dirname(target);
  if (existsSync(parent)) {
    try {
      candidates.push(resolve(realpathSync(parent), basename(target)));
    } catch {
      // 父目录打不开时不额外放行
    }
  }
  for (const candidate of candidates) {
    if (pathIsUnder(candidate, root)) {
      throw new Error("refusing to write user ~/.cursor");
    }
  }
}

/** Cursor 认的项目目录：工作目录所在的 git 根；不在 git 里就是工作目录本身。 */
export function cursorProjectDir(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  let dir = resolve(cwd);
  for (;;) {
    if (exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(cwd);
    }
    dir = parent;
  }
}

export function cursorProjectHooksPath(projectDir: string): string {
  return join(projectDir, ".cursor", "hooks.json");
}

/** 一条钩子命令。路径里有引号或 PowerShell 会展开的字符时返回 undefined。 */
export function cursorHookCommand(
  nodePath: string,
  scriptPath: string,
  event: CursorHookScriptEvent,
): string | undefined {
  if (
    nodePath.trim() === "" ||
    scriptPath.trim() === "" ||
    UNSAFE_IN_QUOTES.test(nodePath) ||
    UNSAFE_IN_QUOTES.test(scriptPath)
  ) {
    return undefined;
  }
  return `"${nodePath}" "${scriptPath}" ${event}`;
}

export function isOwnCursorHookCommand(command: unknown): boolean {
  return typeof command === "string" && OWN_COMMAND.test(command);
}

/**
 * 把本软件的钩子并进现有 hooks.json 正文。
 * 现有正文坏了（不是 JSON 对象、hooks 不是对象、某个事件不是数组）返回 undefined，调用方不写、不装钩子。
 */
export function mergeCursorHooksDocument(
  existing: string | undefined,
  commands: Readonly<Record<keyof typeof CURSOR_HOOK_EVENTS, string>>,
): string | undefined {
  let doc: Record<string, unknown> = { version: 1, hooks: {} };
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      doc = { ...(parsed as Record<string, unknown>) };
    } catch {
      return undefined;
    }
  }
  const rawHooks = doc["hooks"] ?? {};
  if (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
    return undefined;
  }
  const hooks: Record<string, unknown> = { ...(rawHooks as Record<string, unknown>) };
  // 先拿掉所有事件里本软件旧的条目（装过又撤掉的事件也清干净）
  for (const [event, entries] of Object.entries(hooks)) {
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      return undefined;
    }
    const kept = entries.filter(
      (entry) =>
        !(
          entry !== null &&
          typeof entry === "object" &&
          isOwnCursorHookCommand((entry as { command?: unknown }).command)
        ),
    );
    if (kept.length > 0) {
      hooks[event] = kept;
    } else {
      delete hooks[event];
    }
  }
  for (const event of Object.keys(CURSOR_HOOK_EVENTS) as (keyof typeof CURSOR_HOOK_EVENTS)[]) {
    const current = hooks[event];
    hooks[event] = [...(Array.isArray(current) ? current : []), { command: commands[event] }];
  }
  return `${JSON.stringify({ ...doc, version: doc["version"] ?? 1, hooks }, null, 2)}\n`;
}

export function cursorProjectCliConfigPath(projectDir: string): string {
  return join(projectDir, ".cursor", "cli.json");
}

/** 放行一个 MCP 服务器全部工具的规则。Cursor 给插件里的服务器名加了前缀，所以前面用 `*`。 */
export function cursorMcpAllowRule(serverName: string): string {
  return `Mcp(*${serverName}:*)`;
}

/**
 * 把放行规则并进现有 cli.json 正文。已经有了就原样返回。
 * Cursor 校验 permissions 时 allow、deny 都必须是数组，少一个整个 CLI 起不来（真机），所以 deny 缺了补空数组。
 * 现有正文坏了（不是 JSON 对象、permissions 不是对象、allow / deny 不是数组）返回 undefined，调用方不写。
 */
export function mergeCursorCliConfigDocument(
  existing: string | undefined,
  rules: readonly string[],
): string | undefined {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      doc = { ...(parsed as Record<string, unknown>) };
    } catch {
      return undefined;
    }
  }
  const rawPermissions = doc["permissions"] ?? {};
  if (
    rawPermissions === null ||
    typeof rawPermissions !== "object" ||
    Array.isArray(rawPermissions)
  ) {
    return undefined;
  }
  const permissions = { ...(rawPermissions as Record<string, unknown>) };
  const allow = permissions["allow"] ?? [];
  const deny = permissions["deny"] ?? [];
  if (!Array.isArray(allow) || !Array.isArray(deny)) {
    return undefined;
  }
  const missing = rules.filter((rule) => !allow.includes(rule));
  if (
    missing.length === 0 &&
    Array.isArray(permissions["deny"]) &&
    existing !== undefined &&
    existing.trim() !== ""
  ) {
    return existing;
  }
  permissions["allow"] = [...allow, ...missing];
  permissions["deny"] = deny;
  return `${JSON.stringify({ ...doc, permissions }, null, 2)}\n`;
}

const writeLocks = new Map<string, Promise<unknown>>();

/**
 * 按项目文件排队：读出现有正文 → 合并 → 变了才写。合并给 undefined（现有文件坏了）就不写。
 * 落在 ~/.cursor、读不了、写失败都返回 undefined，不抛。
 */
async function mergeProjectFile(
  filePath: string,
  home: string | undefined,
  merge: (existing: string | undefined) => string | undefined,
): Promise<string | undefined> {
  try {
    assertNotUserCursorPath(filePath, home);
  } catch {
    return undefined;
  }
  const previous = writeLocks.get(filePath) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      let existing: string | undefined;
      try {
        existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
      } catch {
        return undefined;
      }
      const next = merge(existing);
      if (next === undefined) {
        return undefined;
      }
      if (next !== existing) {
        await writeTextAtomic(filePath, next);
      }
      return filePath;
    });
  writeLocks.set(filePath, run);
  try {
    return await run;
  } catch {
    return undefined;
  } finally {
    if (writeLocks.get(filePath) === run) {
      writeLocks.delete(filePath);
    }
  }
}

/**
 * 写项目钩子。装不上（路径不安全、现有文件坏了、落在 ~/.cursor）返回 undefined，窗口照开、投递改手动。
 * 内容没变就不写，免得每次开窗都动用户的文件。
 */
export async function writeCursorProjectHooks(input: {
  readonly projectDir: string;
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly home?: string;
}): Promise<string | undefined> {
  const commands = {} as Record<keyof typeof CURSOR_HOOK_EVENTS, string>;
  for (const [event, scriptEvent] of Object.entries(CURSOR_HOOK_EVENTS)) {
    const command = cursorHookCommand(input.nodePath, input.scriptPath, scriptEvent);
    if (command === undefined) {
      return undefined;
    }
    commands[event as keyof typeof CURSOR_HOOK_EVENTS] = command;
  }
  return mergeProjectFile(cursorProjectHooksPath(input.projectDir), input.home, (existing) =>
    mergeCursorHooksDocument(existing, commands),
  );
}

/** 放行这些 MCP 服务器（工作台）。写不了返回 undefined：窗口照开，调用工具时 Cursor 会问。 */
export async function writeCursorProjectMcpAllow(input: {
  readonly projectDir: string;
  readonly serverNames: readonly string[];
  readonly home?: string;
}): Promise<string | undefined> {
  const rules = input.serverNames.map(cursorMcpAllowRule);
  return mergeProjectFile(cursorProjectCliConfigPath(input.projectDir), input.home, (existing) =>
    mergeCursorCliConfigDocument(existing, rules),
  );
}

export interface CursorMcpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** 在 dir 下生成插件（只有 MCP）。返回插件目录。 */
export async function writeCursorPlugin(input: {
  readonly dir: string;
  readonly servers: Readonly<Record<string, CursorMcpServerSpec>>;
}): Promise<string> {
  // Cursor 用目录名给服务器加前缀（`plugin-<目录>-<服务器>`），目录就叫 ffpane。
  const pluginDir = join(input.dir, CURSOR_PLUGIN_NAME);
  await mkdir(join(pluginDir, ".cursor-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".cursor-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: CURSOR_PLUGIN_NAME,
        version: "1.0.0",
        description: "FF-pane workbench tools for this window",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const mcpServers: Record<string, CursorMcpServerSpec> = {};
  for (const [name, spec] of Object.entries(input.servers)) {
    mcpServers[name] = {
      command: spec.command,
      ...(spec.args !== undefined ? { args: [...spec.args] } : {}),
      ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    };
  }
  await writeFile(
    join(pluginDir, "mcp.json"),
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    "utf8",
  );
  return pluginDir;
}

/** 本窗口的说明（角色 + 技能清单）。钩子第一次用到时读出并删掉。没有说明不写。 */
export async function writeCursorContextFile(
  dir: string,
  text: string | undefined,
): Promise<string | undefined> {
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  const filePath = join(dir, "cursor-context.md");
  await writeFile(filePath, text, "utf8");
  return filePath;
}
