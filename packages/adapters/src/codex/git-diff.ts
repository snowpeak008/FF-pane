/**
 * Codex 的 diff 自补：git 快照采集（W2.3）。
 *
 * 为什么需要它：设计文档 §6.4 的 file_changes 要"路径 + diff"，而 Codex 的
 * `file_change` item **只给路径与 kind，没有 diff 正文**（codex.md §2.3、
 * §7.3 坑 2）。故适配器自己拿 git 补：turn 开始前记一次 `git status --porcelain`
 * 作基线，每个 file_change 完成后对该路径跑 `git diff`。
 *
 * 三条设计约束：
 * 1. **只读**。全部命令是 status / diff，绝不动 index 或工作区——用户项目的
 *    git 状态不该被 FF-pane 改写（这也是不用 `git add -N` 让未跟踪文件出
 *    diff 的原因，改用 `git diff --no-index`）。
 * 2. **补不到就缺席**。非 git 目录、git 不可用、diff 为空一律不产生 diff 字段
 *    （events/types.ts：不造假空 diff），降级原因走事件流外的 diagnostics()。
 * 3. **执行器可注入**。生产实现 executeCodexGitCommand 走 child_process，
 *    单测注入假执行器，无需真 git 仓库（tests/codex.test.ts）。
 *
 * 未跟踪文件的处理（本机 git 2.x + Windows 实测）：`git diff -- <新文件>` 输出
 * 为空且退出码 0，必须用 `git diff --no-index -- <空设备> <文件>`，此时**有差异
 * 就返回退出码 1**（属正常，不是错误）。pathspec 用相对路径：传绝对路径时
 * diff 头部会变成带引号的转义绝对路径，可读性差。
 */

/// <reference types="node" />

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

/** 单次 git 命令的结果。执行器不抛异常，一切失败都落在字段里。 */
export interface CodexGitResult {
  /** 退出码；被杀或 spawn 失败时为 null。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** spawn 层错误（git 不在 PATH、超时等），无则 null。 */
  readonly error: string | null;
}

/** git 命令执行器。参数为完整 argv（不含 "git" 本身）。 */
export type CodexGitExecutor = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CodexGitResult>;

/** 单次 git 命令的默认超时。 */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000;

/** 单条 diff 的默认字节上限；超限截断并注明，不静默丢弃。 */
export const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;

/** 单次 git 命令收集的输出上限（防御性封顶，超出即丢弃后续输出）。 */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 空设备路径：`git diff --no-index` 的左侧。Windows 上 NUL 与 /dev/null 均实测可用。 */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** 生产执行器：spawn("git", …)，非 shell 模式；git 是原生可执行文件，无垫片问题。 */
export const executeCodexGitCommand: CodexGitExecutor = (args, cwd, timeoutMs) => {
  return new Promise<CodexGitResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", error: String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CodexGitResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ exitCode: null, stdout, stderr, error: `git 命令超时（${timeoutMs} ms）` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_GIT_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_GIT_OUTPUT_BYTES) {
        stderr += chunk;
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle({
        exitCode: null,
        stdout,
        stderr,
        error: error.code === undefined ? error.message : `${error.code}: ${error.message}`,
      });
    });
    child.once("close", (code) => {
      settle({ exitCode: code, stdout, stderr, error: null });
    });
  });
};

/**
 * 采集环境判定：
 * - repository       cwd 在 git 仓库内，diff 可采；
 * - not-a-repository cwd 不是 git 仓库（Codex 常开 --skip-git-repo-check，这是
 *                    正常场景），diff 一律缺席；
 * - git-unavailable  git 不在 PATH / 无法执行；
 * - unknown          git 报了别的错（权限、损坏仓库等）；
 * - unchecked        还没跑基线（prime 未完成）。
 */
export type CodexGitRepoState =
  | "unchecked"
  | "repository"
  | "not-a-repository"
  | "git-unavailable"
  | "unknown";

/** diff 自补的诊断结果（事件流外的返回值，含降级原因）。 */
export interface CodexDiffDiagnostics {
  readonly repoState: CodexGitRepoState;
  /** 降级原因（非 git 目录 / git 不可用 / 命令失败）；正常时缺席。 */
  readonly degradedReason?: string;
  /** turn 开始前就已改动的路径（git status --porcelain 基线）：这些路径的 diff 可能含本轮之外的改动。 */
  readonly dirtyBeforeTurn: readonly string[];
  /** 成功补到 diff 的路径。 */
  readonly resolvedPaths: readonly string[];
  /** 请求过但 diff 缺席的路径（降级、空 diff、路径在仓库外等）。 */
  readonly missingPaths: readonly string[];
}

/** diff 采集器。一个实例服务一轮（基线只记一次）。 */
export interface CodexDiffCollector {
  /** 记录 turn 前基线（git status --porcelain）。幂等，重复调用复用同一次结果。 */
  prime(): Promise<void>;
  /** 取某路径的 unified diff；取不到返回 undefined（绝不返回空串）。 */
  collect(filePath: string): Promise<string | undefined>;
  /** 采集诊断快照。 */
  diagnostics(): CodexDiffDiagnostics;
}

/** createCodexDiffCollector 的可选项。 */
export interface CodexDiffCollectorOptions {
  /** 采集基准目录（Agent 工作根）。 */
  readonly cwd: string;
  /** git 执行器，默认 executeCodexGitCommand（单测注入假执行器）。 */
  readonly execute?: CodexGitExecutor | undefined;
  /** 单次 git 命令超时，默认 DEFAULT_GIT_TIMEOUT_MS。 */
  readonly timeoutMs?: number | undefined;
  /** 单条 diff 字节上限，默认 DEFAULT_MAX_DIFF_BYTES。 */
  readonly maxDiffBytes?: number | undefined;
}

/**
 * 解析 `git status --porcelain` 的路径列。
 * 形如 `XY <path>`；重命名为 `R  <old> -> <new>`（取新路径）；含特殊字符时
 * git 会给带引号的形式，此处只去掉外层引号，不做 C 风格反转义（基线仅用于
 * "turn 前已脏"的提示，不参与路径比较判定）。
 */
function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length < 4) {
      continue;
    }
    const arrow = trimmed.indexOf(" -> ");
    const raw = arrow === -1 ? trimmed.slice(3) : trimmed.slice(arrow + 4);
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted !== "") {
      paths.push(unquoted);
    }
  }
  return paths;
}

/** 转成相对 cwd 的 posix pathspec；不在 cwd 之下则原样返回绝对路径。 */
export function toGitPathspec(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

/** 创建 diff 采集器。 */
export function createCodexDiffCollector(options: CodexDiffCollectorOptions): CodexDiffCollector {
  const { cwd } = options;
  const execute = options.execute ?? executeCodexGitCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;

  let repoState: CodexGitRepoState = "unchecked";
  let degradedReason: string | undefined;
  let dirtyBeforeTurn: readonly string[] = [];
  const resolvedPaths: string[] = [];
  const missingPaths: string[] = [];
  let priming: Promise<void> | null = null;

  function degrade(state: CodexGitRepoState, reason: string): void {
    repoState = state;
    degradedReason = reason;
  }

  async function runPrime(): Promise<void> {
    const result = await execute(["status", "--porcelain"], cwd, timeoutMs);
    if (result.error !== null) {
      degrade("git-unavailable", `git 无法执行：${result.error}`);
      return;
    }
    if (result.exitCode !== 0) {
      const notARepo = /not a git repository/i.test(result.stderr);
      degrade(
        notARepo ? "not-a-repository" : "unknown",
        notARepo
          ? `${cwd} 不是 git 仓库，diff 自补整轮缺席`
          : `git status 退出码 ${String(result.exitCode)}：${result.stderr.trim()}`,
      );
      return;
    }
    repoState = "repository";
    dirtyBeforeTurn = parsePorcelainPaths(result.stdout);
  }

  function truncate(diff: string): string {
    return diff.length <= maxDiffBytes
      ? diff
      : `${diff.slice(0, maxDiffBytes)}\n[FF-pane：diff 超过 ${String(maxDiffBytes)} 字节，已截断]\n`;
  }

  /** 基线只跑一次；collect 与外部调用共用同一个 promise（不依赖 this）。 */
  function primeOnce(): Promise<void> {
    priming ??= runPrime();
    return priming;
  }

  return {
    prime: primeOnce,

    async collect(filePath: string): Promise<string | undefined> {
      await primeOnce();
      if (repoState !== "repository") {
        missingPaths.push(filePath);
        return undefined;
      }
      const pathspec = toGitPathspec(cwd, filePath);
      // 依次尝试：工作区 vs 索引 → 索引 vs HEAD → 未跟踪文件（--no-index）。
      // 前两条覆盖已跟踪文件的改动与删除，第三条覆盖新建文件。
      const attempts: readonly {
        readonly args: readonly string[];
        readonly okCodes: readonly number[];
      }[] = [
        { args: ["diff", "--", pathspec], okCodes: [0] },
        { args: ["diff", "--cached", "--", pathspec], okCodes: [0] },
        { args: ["diff", "--no-index", "--", NULL_DEVICE, pathspec], okCodes: [0, 1] },
      ];
      for (const attempt of attempts) {
        const result = await execute(attempt.args, cwd, timeoutMs);
        if (result.error !== null) {
          degrade("git-unavailable", `git 无法执行：${result.error}`);
          break;
        }
        if (
          result.exitCode !== null &&
          attempt.okCodes.includes(result.exitCode) &&
          result.stdout.trim() !== ""
        ) {
          resolvedPaths.push(filePath);
          return truncate(result.stdout);
        }
      }
      missingPaths.push(filePath);
      return undefined;
    },

    diagnostics(): CodexDiffDiagnostics {
      return {
        repoState,
        ...(degradedReason === undefined ? {} : { degradedReason }),
        dirtyBeforeTurn: [...dirtyBeforeTurn],
        resolvedPaths: [...resolvedPaths],
        missingPaths: [...missingPaths],
      };
    },
  };
}
