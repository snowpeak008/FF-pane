/**
 * Cursor CLI（cursor-agent）定位与直启（T11.10）。
 * 安装器装在 %LOCALAPPDATA%\cursor-agent\：cursor-agent.cmd → PowerShell → versions\<版本>\node.exe index.js。
 * 照 cursor-agent.ps1 取 versions 下日期最新的目录，直接跑它的 node.exe，不经 cmd / PowerShell。
 * 只认 cursor-agent：本机的 `agent` 可能是别的程序（Grok 也叫 agent）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stripAnsi } from "@ff-pane/adapters";

export const CURSOR_AGENT_COMMAND = "cursor-agent";
export const CURSOR_INSTALL_DIR_NAME = "cursor-agent";

/**
 * Cursor 看到这几个变量就把钩子交给 Git Bash 跑，而钩子命令是按 PowerShell 写的，一跑全报错，
 * `beforeMCPExecution` 失败还会拦掉 MCP 调用（T11.10 实测）。Cursor 窗口的环境里去掉。
 */
export const CURSOR_STRIPPED_ENV = ["MSYSTEM", "EXEPATH", "SHELL"] as const;

export interface CursorCliTarget {
  /** 版本目录里的 node.exe。 */
  readonly nodeFile: string;
  readonly indexJs: string;
  readonly version: string;
}

export interface CursorFs {
  readonly exists: (path: string) => boolean;
  readonly isDirectory: (path: string) => boolean;
  readonly listDir: (path: string) => readonly string[];
}

const realFs: CursorFs = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  listDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/** `2026.11.05-86047df`，新格式 `2026.11.05-12-30-00-86047df`。 */
const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

/** 版本目录名 → 可比较的数（年月日时分秒）。不是版本目录返回 undefined。 */
export function cursorVersionRank(name: string): number | undefined {
  const match = VERSION_DIR.exec(name);
  if (match === null) {
    return undefined;
  }
  const part = (index: number, width: number): string => (match[index] ?? "0").padStart(width, "0");
  return Number(`${part(1, 4)}${part(2, 2)}${part(3, 2)}${part(4, 2)}${part(5, 2)}${part(6, 2)}`);
}

/** 取日期最新的版本目录名。同一天的多个按时间、再按名字。 */
export function pickLatestCursorVersion(names: readonly string[]): string | undefined {
  let best: { readonly name: string; readonly rank: number } | undefined;
  for (const name of names) {
    const rank = cursorVersionRank(name);
    if (rank === undefined) {
      continue;
    }
    if (best === undefined || rank > best.rank || (rank === best.rank && name > best.name)) {
      best = { name, rank };
    }
  }
  return best?.name;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** 可能的安装目录：PATH 上 cursor-agent.cmd 所在目录优先，再看默认的 %LOCALAPPDATA%\cursor-agent。 */
export function cursorInstallRoots(env: NodeJS.ProcessEnv, fs: CursorFs = realFs): string[] {
  const roots: string[] = [];
  const pathEnv = envValue(env, "PATH") ?? "";
  for (const dir of pathEnv.split(";")) {
    const trimmed = dir.trim();
    if (trimmed !== "" && fs.exists(join(trimmed, `${CURSOR_AGENT_COMMAND}.cmd`))) {
      roots.push(trimmed);
    }
  }
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData !== undefined) {
    roots.push(join(localAppData, CURSOR_INSTALL_DIR_NAME));
  }
  return [...new Set(roots)];
}

/** 找到可以直接启动的 Cursor CLI。没装返回 undefined。 */
export function resolveCursorCliTarget(
  env: NodeJS.ProcessEnv = process.env,
  fs: CursorFs = realFs,
): CursorCliTarget | undefined {
  for (const root of cursorInstallRoots(env, fs)) {
    // 安装目录本身就是版本目录（脚本旁边就有 node.exe）时直接用
    const direct = { nodeFile: join(root, "node.exe"), indexJs: join(root, "index.js") };
    if (fs.exists(direct.nodeFile) && fs.exists(direct.indexJs)) {
      return { ...direct, version: basename(root) };
    }
    const versionsDir = join(root, "versions");
    if (!fs.isDirectory(versionsDir)) {
      continue;
    }
    const names = fs.listDir(versionsDir).filter((name) => fs.isDirectory(join(versionsDir, name)));
    const version = pickLatestCursorVersion(names);
    if (version === undefined) {
      continue;
    }
    const nodeFile = join(versionsDir, version, "node.exe");
    const indexJs = join(versionsDir, version, "index.js");
    if (fs.exists(nodeFile) && fs.exists(indexJs)) {
      return { nodeFile, indexJs, version };
    }
  }
  return undefined;
}

// ---------- 系统代理 ----------
// cursor-agent 是 Node 程序，不读 Windows 的系统代理。没走代理时 Claude、GPT 这类模型会被拒
// （「This model provider is not supported in your region」，真机 2026-11-09），那一轮作废、
// 任务说明退回输入栏，看上去就像没提交。环境里没设代理时，照系统代理给这个窗口设上。

const PROXY_ENV_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] as const;

export interface WindowsProxySettings {
  readonly enabled: boolean;
  readonly server?: string;
}

/** 环境里已经有代理（任意大小写）。有就不动它。 */
export function hasProxyEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(env).some(
    ([key, value]) =>
      (PROXY_ENV_NAMES as readonly string[]).includes(key.toUpperCase()) &&
      value !== undefined &&
      value.trim() !== "",
  );
}

/** `reg query "HKCU\…\Internet Settings"` 的输出里取 ProxyEnable、ProxyServer。 */
export function parseInternetSettings(output: string): WindowsProxySettings {
  let enabled = false;
  let server: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*?)\s*$/i.exec(line);
    if (match === null) {
      continue;
    }
    if ((match[1] ?? "").toLowerCase() === "proxyenable") {
      enabled = /^0x0*1$/i.test(match[2] ?? "") || match[2] === "1";
    } else if ((match[2] ?? "") !== "") {
      server = match[2];
    }
  }
  return { enabled, ...(server !== undefined ? { server } : {}) };
}

/**
 * 系统代理 → 进程环境。ProxyServer 可能是 `host:port`，也可能按协议分开写
 * （`http=a:1;https=b:2`），分开写的取 https，没有再取 http。没开或没有地址返回空对象。
 */
export function proxyEnvFromSystem(settings: WindowsProxySettings): Record<string, string> {
  const raw = settings.server?.trim() ?? "";
  if (!settings.enabled || raw === "") {
    return {};
  }
  let address = raw;
  if (raw.includes("=")) {
    const parts = new Map<string, string>();
    for (const part of raw.split(";")) {
      const [scheme, value] = part.split("=", 2);
      if (scheme !== undefined && value !== undefined && value.trim() !== "") {
        parts.set(scheme.trim().toLowerCase(), value.trim());
      }
    }
    address = parts.get("https") ?? parts.get("http") ?? "";
    if (address === "") {
      return {};
    }
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`;
  return { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: "localhost,127.0.0.1,::1" };
}

/** 读当前用户的系统代理。不是 Windows、读不到都返回空对象。 */
export function readSystemProxyEnv(): Record<string, string> {
  if (process.platform !== "win32") {
    return {};
  }
  try {
    const output = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    return proxyEnvFromSystem(parseInternetSettings(output));
  } catch {
    return {};
  }
}

/** 环境里没设代理时补上系统代理。返回要叠加的变量（可能为空）。 */
export function cursorProxyEnv(
  env: Readonly<Record<string, string | undefined>>,
  readSystem: () => Record<string, string> = readSystemProxyEnv,
): Record<string, string> {
  return hasProxyEnv(env) ? {} : readSystem();
}

export interface CursorModelEntry {
  readonly id: string;
  readonly displayName: string;
  readonly isDefault: boolean;
}

/** `cursor-agent models` 的输出：每行 `<id> - <显示名>`，默认那个带 `(default)`。 */
export function parseCursorModels(output: string): CursorModelEntry[] {
  const models: CursorModelEntry[] = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][\w.\-[\]=,]*)\s+-\s+(.+?)\s*$/.exec(rawLine);
    if (match === null) {
      continue;
    }
    const label = (match[2] ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
    // 末尾的标记：`(default)`，当前选中的是 `(current, default)` 或 `(current)`
    const marker = /\s*\(((?:current|default)(?:\s*,\s*(?:current|default))*)\)\s*$/i.exec(label);
    models.push({
      id: match[1] ?? "",
      displayName: marker === null ? label : label.slice(0, marker.index),
      isDefault: marker !== null && /default/i.test(marker[1] ?? ""),
    });
  }
  return models;
}

export type CursorModelsResult =
  | { readonly ok: true; readonly models: readonly CursorModelEntry[]; readonly detail: string }
  | {
      readonly ok: false;
      readonly error: "cli_missing" | "timeout" | "parse_error" | "cli_error";
      readonly detail: string;
    };

/** 跑 `cursor-agent models` 列出这个账号能用的模型（设置页「列出模型」）。 */
export async function listCursorModels(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
): Promise<CursorModelsResult> {
  const target = resolveCursorCliTarget(env);
  if (target === undefined) {
    return { ok: false, error: "cli_missing", detail: "没找到 Cursor CLI（cursor-agent）。" };
  }
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      stringEnv[key] = value;
    }
  }
  const { execFile } = await import("node:child_process");
  return await new Promise<CursorModelsResult>((done) => {
    execFile(
      target.nodeFile,
      [target.indexJs, "models"],
      {
        env: Object.fromEntries(
          Object.entries({
            ...cursorProcessEnv(stringEnv, {}),
            ...cursorProxyEnv(stringEnv),
          }).filter(([, value]) => value !== undefined),
        ),
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const killed = (error as { killed?: boolean }).killed === true;
          done({
            ok: false,
            error: killed ? "timeout" : "cli_error",
            detail: `${String(stderr || stdout || error.message)
              .trim()
              .slice(0, 300)}`,
          });
          return;
        }
        const models = parseCursorModels(String(stdout));
        done(
          models.length > 0
            ? { ok: true, models, detail: "cursor-agent models" }
            : { ok: false, error: "parse_error", detail: String(stdout).trim().slice(0, 300) },
        );
      },
    );
  });
}

/**
 * Cursor 窗口进程的环境：去掉会把钩子交给 Git Bash 的变量，补上脚本本来会设的两个。
 * 去掉的变量写成 undefined：终端管理器是把这份叠在主进程环境上的，只有写成 undefined 才会删掉
 * （漏写的话主进程从 Git Bash 里启动时这几个会带回来，真机就是这样坏的）。
 * parentEnv 里大小写不同的同名变量也一并标掉。返回新对象，不改入参。
 */
export function cursorProcessEnv(
  env: Readonly<Record<string, string | undefined>>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const stripped = new Set(CURSOR_STRIPPED_ENV.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(env)) {
    if (!stripped.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  for (const key of [...CURSOR_STRIPPED_ENV, ...Object.keys(env), ...Object.keys(parentEnv)]) {
    if (stripped.has(key.toLowerCase())) {
      out[key] = undefined;
    }
  }
  out["CURSOR_INVOKED_AS"] = CURSOR_AGENT_COMMAND;
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (envValue(env, "NODE_COMPILE_CACHE") === undefined && localAppData !== undefined) {
    out["NODE_COMPILE_CACHE"] = join(localAppData, "cursor-compile-cache");
  }
  return out;
}
