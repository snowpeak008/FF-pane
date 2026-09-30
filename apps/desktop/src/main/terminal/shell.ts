/**
 * 默认 shell 解析与白名单校验（T10.1）。
 * renderer 只能选白名单内的裸名 shell；cwd 必须是已存在目录。
 * 带路径分隔符的 shell（绝对路径 / 穿越）一律拒绝，避免借白名单基名指向任意可执行文件。
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { findExecutableOnWindowsPath } from "@ff-pane/adapters";

/** 本单允许的 shell 基名（不含路径；大小写不敏感）。 */
export const ALLOWED_SHELL_BASENAMES = new Set([
  "pwsh",
  "pwsh.exe",
  "powershell",
  "powershell.exe",
  "cmd",
  "cmd.exe",
]);

/** resize / create 单维上限，防止异常巨大值。 */
export const MAX_TERMINAL_DIMENSION = 1000;

export class TerminalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalValidationError";
  }
}

function basenameLower(file: string): string {
  return path.basename(file).toLowerCase();
}

function hasPathSeparators(value: string): boolean {
  return value.includes("/") || value.includes("\\") || path.isAbsolute(value);
}

/** 校验 cwd：必须是已存在的目录（文件路径同样拒绝）。 */
export function assertValidCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    if (!existsSync(resolved)) {
      throw new TerminalValidationError(`cwd is not an existing directory: ${resolved}`);
    }
    if (!statSync(resolved).isDirectory()) {
      throw new TerminalValidationError(`cwd is not a directory: ${resolved}`);
    }
  } catch (thrown) {
    if (thrown instanceof TerminalValidationError) {
      throw thrown;
    }
    throw new TerminalValidationError(`cwd is not accessible: ${resolved}`);
  }
  return resolved;
}

/**
 * 钳制终端行列：整数、至少 1、至多 MAX_TERMINAL_DIMENSION。
 */
export function clampTerminalDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(1, Math.floor(value)));
}

/**
 * IPC terminal:create：拒绝 renderer 传入 args / env（T10.4 起由主进程内部组装）。
 */
export function assertTerminalCreateIpcSafe(request: object): void {
  const raw = request as { readonly args?: unknown; readonly env?: unknown };
  if (raw.args !== undefined || raw.env !== undefined) {
    throw new TerminalValidationError(
      "terminal:create rejects args/env from renderer (assembled by main process only)",
    );
  }
}

/**
 * 解析用户给定的 shell：仅允许白名单**裸名**；经 PATH 解析为绝对路径。
 * 任何带路径分隔符的输入（含绝对路径 powershell.exe）一律拒绝。
 */
export function resolveAllowedShell(
  shell: string | undefined,
  platform = process.platform,
): string {
  if (shell === undefined || shell.trim() === "") {
    return resolveDefaultShell(platform);
  }
  const trimmed = shell.trim();
  if (hasPathSeparators(trimmed)) {
    throw new TerminalValidationError(`shell must be a bare whitelist name (got path): ${trimmed}`);
  }
  const base = basenameLower(trimmed);
  if (!ALLOWED_SHELL_BASENAMES.has(base)) {
    throw new TerminalValidationError(
      `shell not allowed: ${trimmed} (whitelist: pwsh / powershell / cmd)`,
    );
  }

  if (platform === "win32") {
    const found = findExecutableOnWindowsPath(trimmed);
    if (found === undefined) {
      throw new TerminalValidationError(`shell executable not found on PATH: ${trimmed}`);
    }
    return found;
  }

  // 非 Windows：裸名交由 spawn 走 PATH
  return trimmed;
}

/** 默认 shell：Windows 优先 pwsh.exe，否则 powershell.exe；其它平台 $SHELL 回退。 */
export function resolveDefaultShell(platform = process.platform): string {
  if (platform === "win32") {
    const pwsh = findExecutableOnWindowsPath("pwsh") ?? findExecutableOnWindowsPath("pwsh.exe");
    if (pwsh !== undefined) {
      return pwsh;
    }
    const powershell =
      findExecutableOnWindowsPath("powershell") ?? findExecutableOnWindowsPath("powershell.exe");
    if (powershell !== undefined) {
      return powershell;
    }
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const fallback = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(fallback)) {
      return fallback;
    }
    throw new TerminalValidationError("no default shell found (pwsh / powershell)");
  }

  const fromEnv = process.env["SHELL"];
  if (fromEnv !== undefined && fromEnv.trim() !== "" && existsSync(fromEnv)) {
    return fromEnv;
  }
  for (const candidate of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new TerminalValidationError("no default shell found ($SHELL / /bin/sh)");
}

/** 无项目时的 cwd 回退。 */
export function defaultTerminalCwd(): string {
  return assertValidCwd(homedir());
}
