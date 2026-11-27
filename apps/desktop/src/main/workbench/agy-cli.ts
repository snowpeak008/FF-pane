/**
 * Antigravity CLI（`agy`）定位、环境与子命令（T11.23 第一期）。
 *
 * agy 1.5.18 是原生 exe，装在 `%LOCALAPPDATA%\agy\bin\agy.exe`（2026-11-28 实测），
 * 官方安装脚本 `irm https://antigravity.google/cli/install.ps1 | iex`。
 * 和 Cursor 不同，它不是 node 脚本，所以直接启动 exe，不经 cmd / PowerShell。
 *
 * 代理：agy 是 Go 程序，Go 的 http 客户端默认读 `HTTPS_PROXY` / `HTTP_PROXY`，
 * 但 Windows 的系统代理不在这两个变量里，需要照 Cursor 的做法补上（读不读待探针）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "@ff-pane/adapters";

/** agy 默认可执行文件名。 */
export const AGY_COMMAND = "agy";

/** Windows 安装目录名：`%LOCALAPPDATA%\agy`，可执行文件在 `bin` 下。 */
export const AGY_INSTALL_DIR_NAME = "agy";

/**
 * 钩子进程环境里去掉的变量。2026-11-28 实测这几个会带进钩子（`MSYSTEM=MINGW64` 来自 Git Bash），
 * 目前没影响脚本运行；照 Cursor 先去掉，免得 agy 哪天也照它决定钩子的 shell。
 */
export const AGY_STRIPPED_ENV = ["MSYSTEM", "EXEPATH", "SHELL"] as const;

export interface AgyFs {
  readonly exists: (path: string) => boolean;
  readonly isFile: (path: string) => boolean;
}

const realFs: AgyFs = {
  exists: (path) => existsSync(path),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** 可能的 agy 可执行文件：PATH 上的 `agy.exe` / `agy` 优先，再看默认的 `%LOCALAPPDATA%\agy\bin`。 */
export function agyInstallRoots(env: NodeJS.ProcessEnv, fs: AgyFs = realFs): string[] {
  const found: string[] = [];
  const pathEnv = envValue(env, "PATH") ?? "";
  for (const dir of pathEnv.split(";")) {
    const trimmed = dir.trim();
    if (trimmed === "") {
      continue;
    }
    for (const name of [`${AGY_COMMAND}.exe`, AGY_COMMAND]) {
      const candidate = join(trimmed, name);
      if (fs.isFile(candidate)) {
        found.push(candidate);
      }
    }
  }
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData !== undefined) {
    for (const name of [`${AGY_COMMAND}.exe`, AGY_COMMAND]) {
      const candidate = join(localAppData, AGY_INSTALL_DIR_NAME, "bin", name);
      if (fs.isFile(candidate)) {
        found.push(candidate);
      }
    }
  }
  return [...new Set(found)];
}

/** 找到可以直接启动的 agy。没装返回 undefined。 */
export function resolveAgyTarget(
  env: NodeJS.ProcessEnv = process.env,
  fs: AgyFs = realFs,
): string | undefined {
  return agyInstallRoots(env, fs)[0];
}

// ---------- 系统代理 ----------

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
export function agyProxyEnv(
  env: Readonly<Record<string, string | undefined>>,
  readSystem: () => Record<string, string> = readSystemProxyEnv,
): Record<string, string> {
  return hasProxyEnv(env) ? {} : readSystem();
}

/**
 * agy 窗口进程的环境：去掉 Git Bash 变量，补上代理。
 * 去掉的变量写成 undefined：终端管理器是把这份叠在主进程环境上的，只有写成 undefined 才会删掉。
 * parentEnv 里大小写不同的同名变量也一并标掉。返回新对象，不改入参。
 */
export function agyProcessEnv(
  env: Readonly<Record<string, string | undefined>>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const stripped = new Set(AGY_STRIPPED_ENV.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(env)) {
    if (!stripped.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  for (const key of [...AGY_STRIPPED_ENV, ...Object.keys(env), ...Object.keys(parentEnv)]) {
    if (stripped.has(key.toLowerCase())) {
      out[key] = undefined;
    }
  }
  return out;
}

export interface AgyModelEntry {
  readonly id: string;
  readonly displayName: string;
  readonly isDefault: boolean;
}

/** 每行开头 `id` 后面跟的东西。 */
const MODEL_HEAD = /^([A-Za-z0-9][\w.:\-/]*)\s*[\t ][-—–]{0,2}\s*(.*)$/;

/**
 * `agy models` 的真实输出（2026-11-28 实测）：第一行是 `Fetching available models...`，
 * 之后每行两列 `id<TAB>显示名`，例如 `gemini-4-neon-high<TAB>Gemini 4 Neon (High)`。
 * `--model` 要的是左边这个 id，不是显示名。
 * 也兼容 `id - 显示名` 和只有 id 的写法。显示名末尾带 `(default)` 的标出来。
 * 解析不出任何一行时返回空数组，由调用方报 parse_error。
 */
export function parseAgyModels(output: string): AgyModelEntry[] {
  const models: AgyModelEntry[] = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.replace(/[​-‍﻿]/g, "").trim();
    if (line === "" || /^[=\-\s]+$/.test(line) || /^Fetching /i.test(line)) {
      continue;
    }
    const firstTab = line.indexOf("\t");
    let id: string;
    let rest: string;
    if (firstTab >= 0) {
      id = line.slice(0, firstTab).trim();
      rest = line
        .slice(firstTab + 1)
        .split("\t")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .join(" ");
    } else {
      const match = MODEL_HEAD.exec(line);
      id = match?.[1] ?? line;
      rest = (match?.[2] ?? "").trim();
    }
    if (id === "" || !/^[A-Za-z0-9][\w.:\-/]*$/.test(id)) {
      continue;
    }
    const isDefault = /\((?:current,\s*)?default\)/i.test(rest);
    const displayName = rest
      .replace(/\s*\((?:current|default)(?:,\s*(?:current|default))*\)\s*$/i, "")
      .trim();
    models.push({ id, displayName: displayName === "" ? id : displayName, isDefault });
  }
  return models;
}

export type AgyModelsResult =
  | { readonly ok: true; readonly models: readonly AgyModelEntry[]; readonly detail: string }
  | {
      readonly ok: false;
      readonly error: "cli_missing" | "timeout" | "parse_error" | "cli_error";
      readonly detail: string;
    };

/** 一次 agy 子命令的结果。没装、超时、出错都不抛。 */
export type AgyCliRun =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | {
      readonly ok: false;
      readonly error: "cli_missing" | "timeout" | "cli_error";
      readonly stdout: string;
      readonly detail: string;
    };

/** 子命令进程的环境：同 agy 窗口（去掉 Git Bash 变量、补系统代理）。 */
export function agyCommandEnv(
  env: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      stringEnv[key] = value;
    }
  }
  return Object.fromEntries(
    Object.entries({
      ...agyProcessEnv(stringEnv, {}),
      ...agyProxyEnv(stringEnv),
      ...extra,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** 跑一个 agy 子命令（`models` 等）。 */
export async function runAgyCli(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly target?: string;
  } = {},
): Promise<AgyCliRun> {
  const env = options.env ?? process.env;
  const target = options.target ?? resolveAgyTarget(env);
  if (target === undefined) {
    return {
      ok: false,
      error: "cli_missing",
      stdout: "",
      detail: "没找到 Antigravity CLI（agy）。",
    };
  }
  const { execFile } = await import("node:child_process");
  return await new Promise<AgyCliRun>((done) => {
    execFile(
      target,
      [...args],
      {
        env: agyCommandEnv(env),
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const killed = (error as { killed?: boolean }).killed === true;
          done({
            ok: false,
            error: killed ? "timeout" : "cli_error",
            stdout: String(stdout),
            detail: stripAnsi(String(stderr || stdout || error.message))
              .trim()
              .slice(0, 600),
          });
          return;
        }
        done({ ok: true, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 跑 `agy models` 列出这个账号能用的模型（设置页「列出模型」）。 */
export async function listAgyModels(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
): Promise<AgyModelsResult> {
  const run = await runAgyCli(["models"], { env, timeoutMs });
  if (!run.ok) {
    return { ok: false, error: run.error, detail: run.detail.slice(0, 300) };
  }
  const models = parseAgyModels(run.stdout);
  return models.length > 0
    ? { ok: true, models, detail: "agy models" }
    : { ok: false, error: "parse_error", detail: run.stdout.trim().slice(0, 300) };
}
