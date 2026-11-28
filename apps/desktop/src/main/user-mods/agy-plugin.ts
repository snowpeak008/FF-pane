/**
 * agy 的 ffpane 工具插件（计划 docs/用户内容可插拔与agy工具插件计划.md §2）。
 *
 * 为什么要它：agy 的 agent 只有「插件自带的 MCP 服务器」才拿得到 MCP 工具（2026-11-28 实测），
 * 项目里 `.agents/mcp_config.json` 配的服务器 agent 看不到。
 *
 * 规矩（Tony 定）：
 * - 只有用户在设置里点「添加」才装；装软件、升级软件、开窗口都不写用户目录。
 * - 已装的才自动更新（内容和现在的 FF-pane 不一致时）；没装的永远不补装，用户在 agy 里自己卸了也不补。
 * - 只认「固定名字 + 归属标记文件」，不看版本，所以新版本能卸旧版本装的。
 * - 同名但没有我们标记的插件是用户自己的，不碰。
 *
 * 所有对外动作（跑 agy、读写目录、台账）都经 `AgyPluginDeps` 注入，本文件不直接碰文件系统。
 * 装和更新都走 `agy plugin install <暂存目录>`（整体替换，用户禁用的状态会保留）。
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  findEntry,
  removeEntry,
  type UserModEntry,
  type UserModsLedger,
  upsertEntry,
} from "./ledger";

/** 固定名字。 */
export const AGY_PLUGIN_NAME = "ffpane-workbench";
/** 插件里的 MCP 服务器名。agent 看到的服务器名是 `<插件名>_<服务器名>`。 */
export const AGY_PLUGIN_SERVER_NAME = "ffpane-workbench";
/** 归属标记文件：有它才算是我们装的。 */
export const AGY_PLUGIN_OWNER_FILE = "ffpane-owner.json";
/** 插件内容的格式版本。和 FF-pane 版本无关，只有生成的内容格式变了才加一。 */
export const AGY_PLUGIN_SCHEMA = 1;

const PLUGIN_JSON = "plugin.json";
const MCP_JSON = "mcp_config.json";
const FILE_NAMES = [PLUGIN_JSON, MCP_JSON, AGY_PLUGIN_OWNER_FILE] as const;

export type AgyPluginFiles = Readonly<Record<string, string>>;

export interface AgyPluginSpec {
  /** FF-pane 可执行文件（Electron）。 */
  readonly execPath: string;
  /** workbench-mcp.js 所在目录。 */
  readonly moduleDir: string;
}

/** 生成插件的三个文件。内容只取决于安装位置，不带 FF-pane 版本，免得每次升级都算「过期」。 */
export function buildAgyPluginFiles(spec: AgyPluginSpec): AgyPluginFiles {
  const plugin = {
    name: AGY_PLUGIN_NAME,
    version: String(AGY_PLUGIN_SCHEMA),
    description:
      "FF-pane 工作台工具（窗口协作、汇报、收件箱等）。由 FF-pane 设置里添加，可在那里卸载。",
  };
  const mcp = {
    mcpServers: {
      [AGY_PLUGIN_SERVER_NAME]: {
        command: spec.execPath,
        args: [join(spec.moduleDir, "workbench-mcp.js")],
        // 窗口令牌、管道名不写文件，由 agy 进程的环境变量继承给这个服务器进程。
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
  const owner = {
    owner: "ff-pane",
    schema: AGY_PLUGIN_SCHEMA,
    note: "This plugin was added by FF-pane. Remove it in FF-pane settings, or `agy plugin uninstall ffpane-workbench`.",
  };
  return {
    [PLUGIN_JSON]: `${JSON.stringify(plugin, null, 2)}\n`,
    [MCP_JSON]: `${JSON.stringify(mcp, null, 2)}\n`,
    [AGY_PLUGIN_OWNER_FILE]: `${JSON.stringify(owner, null, 2)}\n`,
  };
}

/** 键排序后序列化，用来比较「内容是否一致」，不受缩进和键顺序影响。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const raw = value as Record<string, unknown>;
    return `{${Object.keys(raw)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(raw[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    return canonical(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function agyPluginDigest(files: AgyPluginFiles): string {
  const hash = createHash("sha256");
  for (const name of FILE_NAMES) {
    hash.update(`${name}\n${canonicalText(files[name]) ?? "?"}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

export function hasOwnerMarker(files: AgyPluginFiles | undefined): boolean {
  const text = files?.[AGY_PLUGIN_OWNER_FILE];
  if (text === undefined) {
    return false;
  }
  try {
    return (JSON.parse(text) as { owner?: unknown }).owner === "ff-pane";
  } catch {
    return false;
  }
}

export type AgyPluginStatus =
  | { readonly state: "agy-missing" }
  | { readonly state: "not-installed" }
  /** 同名插件存在但没有我们的标记：是用户自己的，不碰。 */
  | { readonly state: "foreign"; readonly path: string }
  | {
      readonly state: "installed";
      /** 内容和现在的 FF-pane 一致。 */
      readonly current: boolean;
      /** 用户在 agy 里禁用了它（更新不会改这个）。 */
      readonly enabled: boolean;
      readonly path: string;
      readonly lastError?: string;
    };

export interface AgyRunResult {
  readonly code: number;
  readonly output: string;
}

export interface AgyPluginDeps {
  /** agy 可执行文件；找不到返回 undefined。 */
  readonly resolveAgy: () => string | undefined;
  readonly runAgy: (args: readonly string[]) => Promise<AgyRunResult>;
  /** 读已装插件目录里我们关心的三个文件；目录不存在返回 undefined。 */
  readonly readInstalled: (dir: string) => Promise<AgyPluginFiles | undefined>;
  /** 把文件写进暂存目录（FF-pane 自己的数据目录里），返回目录路径。 */
  readonly writeStage: (files: AgyPluginFiles) => Promise<string>;
  /** 只在 `agy plugin uninstall` 失败时兜底，调用前已确认有我们的标记。 */
  readonly removeDir: (dir: string) => Promise<void>;
  /** agy 的插件目录（`~/.gemini/config/plugins`）。 */
  readonly pluginsDir: () => string;
  /** 有没有开着的 agy 窗口（它们的服务器进程可能占着插件目录）。 */
  readonly agyWindowsRunning: () => boolean;
  readonly readLedger: () => Promise<UserModsLedger>;
  readonly writeLedger: (ledger: UserModsLedger) => Promise<void>;
  readonly now: () => number;
  readonly appVersion: string;
}

interface ListedPlugin {
  readonly name: string;
  readonly enabled: boolean;
  readonly path?: string;
}

function parseList(output: string): readonly ListedPlugin[] {
  try {
    const raw = JSON.parse(output) as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.flatMap((item): ListedPlugin[] => {
      if (typeof item !== "object" || item === null) {
        return [];
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry["name"] !== "string") {
        return [];
      }
      return [
        {
          name: entry["name"],
          enabled: entry["enabled"] !== false,
          ...(typeof entry["path"] === "string" ? { path: entry["path"] } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

function sameContent(installed: AgyPluginFiles, expected: AgyPluginFiles): boolean {
  return FILE_NAMES.every(
    (name) =>
      canonicalText(installed[name]) !== undefined &&
      canonicalText(installed[name]) === canonicalText(expected[name]),
  );
}

/** 现在的状态。只读，不改任何东西。 */
export async function getAgyPluginStatus(
  deps: AgyPluginDeps,
  spec: AgyPluginSpec,
): Promise<AgyPluginStatus> {
  if (deps.resolveAgy() === undefined) {
    return { state: "agy-missing" };
  }
  const listed = await deps.runAgy(["plugin", "list", "--json"]);
  const found = parseList(listed.output).find((item) => item.name === AGY_PLUGIN_NAME);
  const dir = found?.path ?? join(deps.pluginsDir(), AGY_PLUGIN_NAME);
  const installed = await deps.readInstalled(dir);
  if (found === undefined && installed === undefined) {
    return { state: "not-installed" };
  }
  if (!hasOwnerMarker(installed)) {
    return found === undefined ? { state: "not-installed" } : { state: "foreign", path: dir };
  }
  if (found === undefined) {
    // 目录还在、agy 却不认（被用户在 agy 里卸过但留了残渣之类）：当没装，不去补。
    return { state: "not-installed" };
  }
  const entry = findEntry(await deps.readLedger(), "agy-plugin", AGY_PLUGIN_NAME);
  return {
    state: "installed",
    current: sameContent(installed ?? {}, buildAgyPluginFiles(spec)),
    enabled: found.enabled,
    path: dir,
    ...(entry?.lastError !== undefined ? { lastError: entry.lastError } : {}),
  };
}

export type AgyPluginResult =
  | { readonly ok: true; readonly status: AgyPluginStatus }
  | { readonly ok: false; readonly error: string; readonly status: AgyPluginStatus };

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 400 ? trimmed.slice(-400) : trimmed;
}

async function record(
  deps: AgyPluginDeps,
  spec: AgyPluginSpec,
  path: string,
  patch: { readonly lastError?: string },
): Promise<void> {
  const ledger = await deps.readLedger();
  const old = findEntry(ledger, "agy-plugin", AGY_PLUGIN_NAME);
  const now = deps.now();
  // 更新失败时只记错误：磁盘上装的还是旧内容，台账里的摘要和版本不能改成「新内容」。
  const failed = patch.lastError !== undefined && old !== undefined;
  const entry: UserModEntry = {
    kind: "agy-plugin",
    name: AGY_PLUGIN_NAME,
    path,
    digest: failed ? old.digest : agyPluginDigest(buildAgyPluginFiles(spec)),
    writtenBy: failed ? old.writtenBy : deps.appVersion,
    installedAt: old?.installedAt ?? now,
    updatedAt: failed ? old.updatedAt : now,
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
  };
  await deps.writeLedger(upsertEntry(ledger, entry));
}

/** 添加或更新（用户点按钮，或自动更新已装的）。同名但不是我们装的，不动。 */
export async function installAgyPlugin(
  deps: AgyPluginDeps,
  spec: AgyPluginSpec,
): Promise<AgyPluginResult> {
  const before = await getAgyPluginStatus(deps, spec);
  if (before.state === "agy-missing") {
    return { ok: false, error: "没找到 agy，先安装 agy。", status: before };
  }
  if (before.state === "foreign") {
    return {
      ok: false,
      error: "agy 里已经有一个同名插件，不是 FF-pane 装的，没有动它。",
      status: before,
    };
  }
  const stage = await deps.writeStage(buildAgyPluginFiles(spec));
  const validated = await deps.runAgy(["plugin", "validate", stage]);
  if (validated.code !== 0) {
    return {
      ok: false,
      error: `插件内容没通过 agy 的检查：${tail(validated.output)}`,
      status: before,
    };
  }
  const installed = await deps.runAgy(["plugin", "install", stage]);
  if (installed.code !== 0) {
    return { ok: false, error: `agy 没装上插件：${tail(installed.output)}`, status: before };
  }
  const after = await getAgyPluginStatus(deps, spec);
  if (after.state !== "installed" || !after.current) {
    return { ok: false, error: "装完后核对不一致，请重试。", status: after };
  }
  await record(deps, spec, after.path, {});
  return { ok: true, status: await getAgyPluginStatus(deps, spec) };
}

/** 卸载：只卸有我们标记的。 */
export async function uninstallAgyPlugin(
  deps: AgyPluginDeps,
  spec: AgyPluginSpec,
): Promise<AgyPluginResult> {
  const before = await getAgyPluginStatus(deps, spec);
  if (before.state === "foreign") {
    return {
      ok: false,
      error: "agy 里这个同名插件不是 FF-pane 装的，没有动它。",
      status: before,
    };
  }
  if (before.state === "installed") {
    const done = await deps.runAgy(["plugin", "uninstall", AGY_PLUGIN_NAME]);
    if (done.code !== 0) {
      // 兜底：已确认有我们的标记，直接删这个目录。
      await deps.removeDir(before.path);
    }
    const after = await getAgyPluginStatus(deps, spec);
    if (after.state === "installed" || after.state === "foreign") {
      return { ok: false, error: `没卸干净：${tail(done.output)}`, status: after };
    }
  }
  await deps.writeLedger(removeEntry(await deps.readLedger(), "agy-plugin", AGY_PLUGIN_NAME));
  return { ok: true, status: await getAgyPluginStatus(deps, spec) };
}

export type AgyPluginAutoUpdate =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "updated" }
  | { readonly action: "deferred"; readonly reason: string }
  | { readonly action: "failed"; readonly error: string };

/**
 * 启动时调用：只更新「已装且过期」的。没装的什么都不做、不补装；
 * 台账里有、但已经不在 agy 里（用户自己卸了）的，只清台账。
 */
export async function autoUpdateAgyPlugin(
  deps: AgyPluginDeps,
  spec: AgyPluginSpec,
): Promise<AgyPluginAutoUpdate> {
  const status = await getAgyPluginStatus(deps, spec);
  if (status.state === "agy-missing") {
    return { action: "none", reason: "没装 agy" };
  }
  if (status.state === "foreign") {
    return { action: "none", reason: "同名插件不是 FF-pane 装的" };
  }
  if (status.state === "not-installed") {
    const ledger = await deps.readLedger();
    if (findEntry(ledger, "agy-plugin", AGY_PLUGIN_NAME) !== undefined) {
      await deps.writeLedger(removeEntry(ledger, "agy-plugin", AGY_PLUGIN_NAME));
    }
    return { action: "none", reason: "没添加插件，不补装" };
  }
  if (status.current) {
    if (status.lastError !== undefined) {
      await record(deps, spec, status.path, {});
    }
    return { action: "none", reason: "已是最新" };
  }
  if (deps.agyWindowsRunning()) {
    return { action: "deferred", reason: "有 agy 窗口开着，等它们关了下次再更新" };
  }
  const result = await installAgyPlugin(deps, spec);
  if (result.ok) {
    return { action: "updated" };
  }
  await record(deps, spec, status.path, { lastError: result.error });
  return { action: "failed", error: result.error };
}
