/**
 * Gemini 窗口（agy 本机登录）的项目钩子和 MCP 配置（T11.23 第一期，计划 §3.3）。
 *
 * agy 只从两处读钩子和 MCP：全局 `~/.gemini/config/`（不能碰）和工作区 `.agents/`。
 * 所以只能写项目里的 `.agents/hooks.json` 和 `.agents/mcp_config.json`，做法同 Cursor 写 `.cursor/`：
 * 同项目多个窗口共用一份，靠环境里的窗口令牌区分；合并写，只增删本软件的条目，用户自己的原样保留。
 *
 * 钩子文件结构（2026-11-28 实测，官方 hooks.md 同）：
 * - 顶层键是钩子名，下面按事件分；
 * - `SessionStart`、`PreInvocation`、`PostInvocation`、`Stop` 平铺（数组里直接放处理器对象）；
 * - 只有 `PreToolUse`、`PostToolUse` 用分组（`matcher` + `hooks`）。
 * 结构套错时 agy 只在 `~/.gemini/antigravity-cli/cli.log` 写 `Failed to parse hooks file`，整份钩子都不生效。
 * 钩子命令在 Windows 上由 `cmd /c` 执行，工作目录是 `hooks.json` 所在目录。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";

/** 本软件写进 hooks.json 的钩子名。 */
export const AGY_HOOK_NAME = "ffpane-workbench";

/** agy 事件 → 传给钩子脚本的事件名。 */
export const AGY_HOOK_EVENTS = {
  SessionStart: "AgySessionStart",
  PreInvocation: "AgyPromptSubmit",
  PostInvocation: "AgyPostInvocation",
  PreToolUse: "AgyPreToolUse",
  Stop: "AgyStop",
} as const;

export type AgyHookScriptEvent = (typeof AGY_HOOK_EVENTS)[keyof typeof AGY_HOOK_EVENTS];

/** 钩子读完就删的说明文件（角色说明 + 技能清单）。 */
export const AGY_CONTEXT_FILE_ENV = "FF_PANE_AGY_CONTEXT_FILE";

/** 本软件写的钩子命令：`"<node>" "<…workbench-hook.mjs>" Agy…`。 */
const OWN_COMMAND = /workbench-hook\.m?js"?\s+Agy[A-Za-z]+\s*$/;

/** `cmd /c` 里会出问题、或引号本身。路径里有就不装钩子（同 Cursor 的保守做法）。 */
const UNSAFE_IN_QUOTES = /["`$%&|<>^\r\n]/;

/** 平铺事件（直接放处理器对象）。 */
const FLAT_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"] as const;

/** 分组事件（`matcher` + `hooks`）。只装 PreToolUse：PostToolUse 只认空对象，插不进消息。 */
const GROUPED_EVENTS = ["PreToolUse"] as const;

/** 不再安装、但要清掉旧条目的分组事件。 */
const RETIRED_GROUPED_EVENTS = ["PostToolUse"] as const;

function pathIsUnder(candidate: string, root: string): boolean {
  const left = candidate.toLowerCase();
  const right = root.toLowerCase();
  return left === right || left.startsWith(right + sep);
}

/**
 * 目标若落在用户 `~/.gemini`（含符号链接）则拒绝。agy 的用户设置和登录凭据都在那里，不能写。
 */
export function assertNotUserAgyPath(target: string, home: string = homedir()): void {
  const root = resolve(home, ".gemini");
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
      throw new Error("refusing to write user ~/.gemini");
    }
  }
}

export function agyAgentsDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".agents");
}

export function agyHooksPath(projectRoot: string): string {
  return join(agyAgentsDir(projectRoot), "hooks.json");
}

export function agyMcpConfigPath(projectRoot: string): string {
  return join(agyAgentsDir(projectRoot), "mcp_config.json");
}

/**
 * 一条钩子处理器的命令。
 * 用 `node "<脚本>" <事件名>`：agy 用 `cmd /c` 执行整串，路径带空格时靠双引号。
 * 路径里有引号或 cmd 会吃的字符时返回 undefined，调用方就不装钩子。
 */
export function agyHookCommand(
  nodePath: string,
  scriptPath: string,
  event: AgyHookScriptEvent,
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

interface Handler {
  readonly type: "command";
  readonly command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOwnHandler(command: unknown): boolean {
  return typeof command === "string" && OWN_COMMAND.test(command);
}

/** 平铺数组里去掉本软件旧的条目。 */
function withoutOwnFlat(entries: readonly unknown[]): unknown[] {
  return entries.filter((entry) => !(isRecord(entry) && isOwnHandler(entry["command"])));
}

/**
 * 分组数组里去掉本软件旧的条目；某个分组被清空就整个丢掉。
 * 用户自己的分组里还留着别的钩子，就原样保留。
 */
function withoutOwnGrouped(entries: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry["hooks"])) {
      kept.push(entry);
      continue;
    }
    const hooks = (entry["hooks"] as readonly unknown[]).filter(
      (handler) => !(isRecord(handler) && isOwnHandler(handler["command"])),
    );
    if (hooks.length === 0) {
      continue;
    }
    kept.push({ ...entry, hooks });
  }
  return kept;
}

/**
 * 把本软件的事件并进现有 hooks.json 正文。
 * 现有正文坏了（不是 JSON 对象、钩子名那一层不是对象、某个事件不是数组）返回 undefined，调用方不写、不装钩子。
 */
export function mergeAgyHooksDocument(
  existing: string | undefined,
  commands: Readonly<Record<AgyHookScriptEvent, string>>,
): string | undefined {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      doc = { ...parsed };
    } catch {
      return undefined;
    }
  }
  const rawHook = doc[AGY_HOOK_NAME] ?? {};
  if (!isRecord(rawHook)) {
    return undefined;
  }
  const hook: Record<string, unknown> = { ...rawHook };

  for (const event of FLAT_EVENTS) {
    const current = hook[event];
    if (current !== undefined && !Array.isArray(current)) {
      return undefined;
    }
    const handler: Handler = { type: "command", command: commands[AGY_HOOK_EVENTS[event]] };
    hook[event] = [...withoutOwnFlat(Array.isArray(current) ? current : []), handler];
  }
  for (const event of GROUPED_EVENTS) {
    const current = hook[event];
    if (current !== undefined && !Array.isArray(current)) {
      return undefined;
    }
    const handler: Handler = { type: "command", command: commands[AGY_HOOK_EVENTS[event]] };
    hook[event] = [
      ...withoutOwnGrouped(Array.isArray(current) ? current : []),
      { matcher: "", hooks: [handler] },
    ];
  }
  for (const event of RETIRED_GROUPED_EVENTS) {
    const current = hook[event];
    if (current === undefined) {
      continue;
    }
    if (!Array.isArray(current)) {
      return undefined;
    }
    const kept = withoutOwnGrouped(current);
    if (kept.length > 0) {
      hook[event] = kept;
    } else {
      delete hook[event];
    }
  }
  return `${JSON.stringify({ ...doc, [AGY_HOOK_NAME]: hook }, null, 2)}\n`;
}

export interface AgyMcpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** agy 的 MCP 文件：根键 `mcpServers`。只动本软件管的服务器名，用户自己的原样保留。 */
export function mergeAgyMcpDocument(
  existing: string | undefined,
  servers: Readonly<Record<string, AgyMcpServerSpec>>,
  managedNames: readonly string[],
): string | undefined {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      doc = { ...parsed };
    } catch {
      return undefined;
    }
  }
  const rawServers = doc["mcpServers"] ?? {};
  if (!isRecord(rawServers)) {
    return undefined;
  }
  const next: Record<string, unknown> = { ...rawServers };
  for (const name of managedNames) {
    delete next[name];
  }
  for (const [name, spec] of Object.entries(servers)) {
    next[name] = {
      command: spec.command,
      ...(spec.args !== undefined ? { args: [...spec.args] } : {}),
      ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    };
  }
  return `${JSON.stringify({ ...doc, mcpServers: next }, null, 2)}\n`;
}

const writeLocks = new Map<string, Promise<unknown>>();

/**
 * 按项目文件排队：读出现有正文 → 合并 → 变了才写。合并给 undefined（现有文件坏了）就不写。
 * 落在 ~/.gemini、读不了、写失败都返回 undefined，不抛。
 */
async function mergeProjectFile(
  filePath: string,
  home: string | undefined,
  merge: (existing: string | undefined) => string | undefined,
): Promise<string | undefined> {
  try {
    assertNotUserAgyPath(filePath, home);
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
        await mkdir(dirname(filePath), { recursive: true });
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
 * 写项目钩子。装不上（路径不安全、现有文件坏了、落在 ~/.gemini）返回 undefined，窗口照开、投递改手动。
 * 内容没变就不写。
 */
export async function writeAgyProjectHooks(input: {
  readonly projectRoot: string;
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly home?: string;
}): Promise<string | undefined> {
  const commands = {} as Record<AgyHookScriptEvent, string>;
  for (const event of Object.values(AGY_HOOK_EVENTS)) {
    const command = agyHookCommand(input.nodePath, input.scriptPath, event);
    if (command === undefined) {
      return undefined;
    }
    commands[event] = command;
  }
  return mergeProjectFile(agyHooksPath(input.projectRoot), input.home, (existing) =>
    mergeAgyHooksDocument(existing, commands),
  );
}

/** 写项目 MCP 配置。写不了返回 undefined：窗口照开，调用工具时 agy 会问。 */
export async function writeAgyProjectMcpConfig(input: {
  readonly projectRoot: string;
  readonly servers: Readonly<Record<string, AgyMcpServerSpec>>;
  readonly managedNames: readonly string[];
  readonly home?: string;
}): Promise<string | undefined> {
  return mergeProjectFile(agyMcpConfigPath(input.projectRoot), input.home, (existing) =>
    mergeAgyMcpDocument(existing, input.servers, input.managedNames),
  );
}

/** 本窗口的说明（角色 + 技能清单）。钩子第一次用到时读出并删掉。没有说明不写。 */
export async function writeAgyContextFile(
  dir: string,
  text: string | undefined,
): Promise<string | undefined> {
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  const filePath = join(dir, "agy-context.md");
  await writeFile(filePath, text, "utf8");
  return filePath;
}
