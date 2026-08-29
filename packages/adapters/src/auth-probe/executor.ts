/**
 * ProcessExecutor 的生产实现（W1.5d）：child_process.spawn 非 shell 模式。
 *
 * Windows 特殊处理：npm 全局安装的 CLI（codex/claude/gemini/opencode 真机
 * 确认均如此）落地为 .cmd 垫片，Node ≥18.20 出于安全修复（CVE-2024-27980）
 * 禁止非 shell 模式直接 spawn .cmd/.bat。本实现自行做 PATH × PATHEXT 解析：
 * 命中 .exe/.com 直接执行；命中 .cmd/.bat 经 `cmd.exe /d /s /c` 执行（参数
 * 自行加引号 + windowsVerbatimArguments，等价 cross-spawn 的处理方式）。
 * 探测命令的参数全部是本模块内的固定字面量，不存在注入面。
 */

// 本包尚未声明任何依赖（@types/node 由仓库根 hoist 提供），tsconfig 又不在
// 本工单（W1.5d）允许改动范围内，故以三斜线指令显式纳入 node 类型。
// Phase 2 接线依赖时应改为 tsconfig "types" 或 devDependencies 声明。
/// <reference types="node" />

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ExecutionOutcome, ProcessExecutor } from "./types.js";

/** 单流输出上限（状态查询输出极小，防御性封顶）。 */
const MAX_STREAM_BYTES = 64 * 1024;

/**
 * 探测前从子进程环境中剥离的 API key 类变量。
 * 理由：cli_login 语义只认"CLI 自管的登录态凭证"（设计文档 §4.2）；这些
 * 变量会让部分 CLI（尤其 Gemini，docs/adapters/gemini-cli.md §6）在无
 * OAuth 登录态时也认证成功，造成误报 logged_in。
 * 注意不剥 GOOGLE_GENAI_USE_GCA——它只是"复用 OAuth 登录态"的开关，
 * 不注入任何外部凭证，剥掉反而可能误报 logged_out。
 */
const STRIPPED_ENV_VARS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/** 构造探测专用子进程环境：剥密钥变量、关 opencode 自动更新、抑制色码。 */
function buildProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED_ENV_VARS) {
    delete env[name];
  }
  // opencode 默认自动更新（docs/adapters/opencode.md §1），探测不应触发升级。
  env["OPENCODE_DISABLE_AUTOUPDATE"] = "1";
  // 尊重 NO_COLOR 约定的 CLI 会省掉 ANSI 色码，降低解析噪音（不全信，
  // 判定规则仍会剥 ANSI）。
  env["NO_COLOR"] = "1";
  return env;
}

interface ResolvedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH × PATHEXT 中查找 Windows 可执行文件，找不到返回 undefined。 */
function findOnWindowsPath(cmd: string): string | undefined {
  const rawPathExt = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const pathExts = rawPathExt.split(";").filter((ext) => ext !== "");
  const hasOwnExt = path.extname(cmd) !== "";

  const searchDirs =
    cmd.includes("\\") || cmd.includes("/")
      ? [""] // 带路径的命令不再扫 PATH
      : (process.env["PATH"] ?? "").split(path.delimiter);

  for (const rawDir of searchDirs) {
    const dir = rawDir.replace(/^"|"$/g, "");
    const base = dir === "" ? cmd : path.join(dir, cmd);
    const candidates = hasOwnExt ? [base] : pathExts.map((ext) => base + ext);
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** 固定字面量参数的保守引号包裹（仅供 cmd.exe /c 拼接使用）。 */
function quoteForCmd(token: string): string {
  return `"${token.replace(/"/g, "")}"`;
}

/**
 * 解析实际 spawn 目标。返回 undefined 表示可执行文件不存在（cli_missing）。
 * 非 Windows 平台不预解析，直接交给 spawn（ENOENT 时再判 cli_missing）。
 */
function resolveCommand(cmd: string, args: readonly string[]): ResolvedCommand | undefined {
  if (process.platform !== "win32") {
    return { file: cmd, args, windowsVerbatimArguments: false };
  }
  const found = findOnWindowsPath(cmd);
  if (found === undefined) {
    return undefined;
  }
  const ext = path.extname(found).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    // `cmd /s /c` 会剥掉整串命令的首尾引号，故外层需再包一对引号
    //（与 cross-spawn 处理方式一致），真机验证缺外层引号会解析失败。
    const commandLine = `"${[quoteForCmd(found), ...args.map(quoteForCmd)].join(" ")}"`;
    return {
      file: process.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }
  return { file: found, args, windowsVerbatimArguments: false };
}

/** 超时后按平台终止进程树（Windows 垫片会派生子进程，须整树杀）。 */
function killProcessTree(pid: number | undefined, child: { kill: (s: "SIGKILL") => boolean }) {
  if (process.platform === "win32" && pid !== undefined) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
      /* taskkill 不可用时退回普通 kill */
      child.kill("SIGKILL");
    });
    return;
  }
  child.kill("SIGKILL");
}

/**
 * 生产执行器：spawn（shell: false）+ 超时终止 + 三态结果。
 * stdin 置 ignore（Codex 等 CLI 会等 stdin，见 docs/adapters/codex.md §1.1）。
 */
export const executeWithChildProcess: ProcessExecutor = (cmd, args, timeoutMs) => {
  return new Promise<ExecutionOutcome>((resolve) => {
    const resolved = resolveCommand(cmd, args);
    if (resolved === undefined) {
      resolve({ kind: "cli_missing" });
      return;
    }

    const child = spawn(resolved.file, [...resolved.args], {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildProbeEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (outcome: ExecutionOutcome) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };

    const timer = setTimeout(() => {
      killProcessTree(child.pid, child);
      settle({ kind: "timeout" });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_STREAM_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STREAM_BYTES) {
        stderr += chunk;
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle({ kind: "cli_missing" });
        return;
      }
      // 其余 spawn 层错误（权限、EINVAL 等）：以 -1 退出码回报，
      // 上层规则统一落为 unknown。
      settle({ kind: "completed", exitCode: -1, stdout, stderr: String(error) });
    });

    child.on("close", (code) => {
      settle({ kind: "completed", exitCode: code ?? -1, stdout, stderr });
    });
  });
};
