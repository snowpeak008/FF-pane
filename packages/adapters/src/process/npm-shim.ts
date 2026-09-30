/**
 * 解析 npm 全局 `.cmd` 垫片的真实启动目标，供工作台 PTY 绕开 cmd.exe。
 *
 * 本机实测（Windows + npm 全局）：
 * - claude.cmd → `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`
 * - codex.cmd  → `node` + `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`
 *
 * 失败时返回 undefined（调用方应拒绝启动，勿回退不安全的 cmd 拼接）。
 */

/// <reference types="node" />

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findExecutableOnWindowsPath, getEnvCaseInsensitive } from "./windows-command.js";

const NATIVE_EXECUTABLE_EXT = /\.(?:com|exe)$/i;

/** 直接 spawn 目标（参数数组，无 cmd 拼接）。 */
export interface DirectCliTarget {
  readonly file: string;
  readonly args: readonly string[];
  /** PATH 上命中的原始命令路径（.cmd / .exe）。 */
  readonly resolvedCommand: string;
  readonly kind: "native" | "shim-exe" | "shim-node";
}

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveDp0Path(dp0: string, relative: string): string {
  const cleaned = relative.replace(/^\\+/, "").replace(/\//g, path.sep);
  return path.resolve(dp0, cleaned);
}

function resolveNodeBinary(dp0: string, env: NodeJS.ProcessEnv): string | undefined {
  const bundledExe = path.join(dp0, "node.exe");
  if (isFile(bundledExe)) {
    return bundledExe;
  }
  const bundled = path.join(dp0, "node");
  if (isFile(bundled)) {
    return bundled;
  }
  return findExecutableOnWindowsPath("node", env);
}

/**
 * 解析单个 npm `.cmd` 垫片内容。
 * 支持经典 `%dp0%` / `%~dp0` 形态；不执行垫片本身。
 */
export function parseNpmCmdShim(
  cmdPath: string,
  env: NodeJS.ProcessEnv = process.env,
):
  | {
      readonly file: string;
      readonly prefixArgs: readonly string[];
      readonly kind: "shim-exe" | "shim-node";
    }
  | undefined {
  let content: string;
  try {
    content = readFileSync(cmdPath, "utf8");
  } catch {
    return undefined;
  }
  const dp0 = path.dirname(path.resolve(cmdPath));

  // 优先：node + .js（codex 形态）——须先于 .exe，避免匹配到垫片里的 node.exe
  const jsMatch = /"(?:%(?:~dp0|dp0)%)\\?([^"\r\n]+\.js)"/i.exec(content);
  if (jsMatch?.[1] !== undefined) {
    const scriptPath = resolveDp0Path(dp0, jsMatch[1]);
    if (!isFile(scriptPath)) {
      return undefined;
    }
    const nodeFile = resolveNodeBinary(dp0, env);
    if (nodeFile === undefined) {
      return undefined;
    }
    return { file: nodeFile, prefixArgs: [scriptPath], kind: "shim-node" };
  }

  // 次选：显式 .exe 目标（claude 形态）；排除垫片内的 node.exe 引用
  const exeMatch = /"(?:%(?:~dp0|dp0)%)\\?([^"\r\n]+\.exe)"/i.exec(content);
  if (exeMatch?.[1] !== undefined) {
    const rel = exeMatch[1];
    if (!/node\.exe$/i.test(rel.replace(/\//g, "\\"))) {
      const exePath = resolveDp0Path(dp0, rel);
      if (isFile(exePath)) {
        return { file: exePath, prefixArgs: [], kind: "shim-exe" };
      }
    }
  }

  return undefined;
}

/**
 * 解析 CLI 的直接 spawn 目标：原生 exe 或 npm shim 真实入口。
 * Windows 上若只能落到未识别的 `.cmd`，返回 undefined（拒绝 cmd 回退）。
 */
export function resolveDirectCliTarget(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DirectCliTarget | undefined {
  if (process.platform !== "win32") {
    if (command.includes("/") || command.includes("\\")) {
      if (!isFile(command)) {
        return undefined;
      }
      return {
        file: command,
        args,
        resolvedCommand: command,
        kind: "native",
      };
    }
    const pathEnv = getEnvCaseInsensitive(env, "PATH") ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir === "") {
        continue;
      }
      const candidate = path.join(dir, command);
      if (isFile(candidate)) {
        return {
          file: candidate,
          args,
          resolvedCommand: candidate,
          kind: "native",
        };
      }
    }
    return {
      file: command,
      args,
      resolvedCommand: command,
      kind: "native",
    };
  }

  const found = findExecutableOnWindowsPath(command, env);
  if (found === undefined) {
    return undefined;
  }

  if (NATIVE_EXECUTABLE_EXT.test(found)) {
    return {
      file: found,
      args,
      resolvedCommand: found,
      kind: "native",
    };
  }

  if (/\.(?:cmd|bat)$/i.test(found)) {
    const parsed = parseNpmCmdShim(found, env);
    if (parsed === undefined) {
      return undefined;
    }
    return {
      file: parsed.file,
      args: [...parsed.prefixArgs, ...args],
      resolvedCommand: found,
      kind: parsed.kind,
    };
  }

  return undefined;
}
