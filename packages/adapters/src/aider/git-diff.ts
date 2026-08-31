/**
 * Aider 的 diff 自补：git 快照采集（T7.3b）。
 *
 * 为什么需要它：设计文档 §6.4 的 file_changes 要「路径 + diff」，而 aider 的
 * `Applied edit to <path>` 标记行**只给路径**（调研 §2.4），与 codex 的
 * `file_change` item 处境完全相同。故适配器自己拿 git 补。
 *
 * 与 codex 那份（`codex/git-diff.ts`）刻意分开而不是复用，两点实质差异：
 *
 * 1. **必须看索引侧**。aider 对它**新建**的文件会 `git add`（调研 §7.3 坑 5 实测：
 *    `git status --porcelain` 给出 `AM notes/hello.md`）。这类文件 `git diff` 是空的，
 *    要从 `git diff --cached` 才拿得到；codex 不动索引，那份的三段尝试顺序
 *    是为「工作区 → 索引 → 未跟踪」设计的，语义重心不同。
 * 2. **要判 add / update**。aider 的标记行不带变更类型（codex 的 item 自带 kind），
 *    故这里额外提供 `wasTrackedBeforeTurn()`：turn 前用 `git ls-files` 记一份已跟踪
 *    清单，收到标记时据此判定这是新建还是改写——比事后猜文件是否存在可靠
 *    （文件此刻一定存在，存在与否说明不了它本来在不在）。
 *
 * 三条设计约束与 codex 那份一致：
 * 1. **只读**。全部命令是 status / ls-files / diff，绝不动 index 或工作区。
 * 2. **补不到就缺席**。非 git 仓库、git 不可用、diff 为空一律不产生 diff 字段
 *    （events/types.ts：不造假空 diff），降级原因走事件流外的 diagnostics()。
 * 3. **执行器可注入**。生产实现走 child_process，单测注入假执行器，无需真 git 仓库。
 */

/// <reference types="node" />

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

/** 单次 git 命令的结果。执行器不抛异常，一切失败都落在字段里。 */
export interface AiderGitResult {
  /** 退出码；被杀或 spawn 失败时为 null。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** spawn 层错误（git 不在 PATH、超时等），无则 null。 */
  readonly error: string | null;
}

/** git 命令执行器。参数为完整 argv（不含 "git" 本身）。 */
export type AiderGitExecutor = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<AiderGitResult>;

/** 单次 git 命令的默认超时。 */
export const DEFAULT_AIDER_GIT_TIMEOUT_MS = 10_000;

/** 单条 diff 的默认字节上限；超限截断并注明，不静默丢弃。 */
export const DEFAULT_AIDER_MAX_DIFF_BYTES = 512 * 1024;

/** 单次 git 命令收集的输出上限（防御性封顶）。 */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 空设备路径：`git diff --no-index` 的左侧。 */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** 生产执行器：spawn("git", …)，非 shell 模式。 */
export const executeAiderGitCommand: AiderGitExecutor = (args, cwd, timeoutMs) => {
  return new Promise<AiderGitResult>((resolve) => {
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
    const settle = (result: AiderGitResult): void => {
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
 * 采集环境判定（取值与语义同 codex 那份，便于两份诊断在 Run 日志里横向比对）：
 * - repository       cwd 在 git 仓库内，diff 可采；
 * - not-a-repository cwd 不是 git 仓库（aider 加 `--no-git` 时的正常场景）；
 * - git-unavailable  git 不在 PATH / 无法执行；
 * - unknown          git 报了别的错；
 * - unchecked        还没跑基线。
 */
export type AiderGitRepoState =
  | "unchecked"
  | "repository"
  | "not-a-repository"
  | "git-unavailable"
  | "unknown";

/** diff 自补的诊断结果（事件流外的返回值，含降级原因）。 */
export interface AiderDiffDiagnostics {
  readonly repoState: AiderGitRepoState;
  /** 降级原因；正常时缺席。 */
  readonly degradedReason?: string;
  /** turn 开始前就已改动的路径：这些路径的 diff 可能含本轮之外的改动。 */
  readonly dirtyBeforeTurn: readonly string[];
  /** turn 开始前的 HEAD 提交（40 位 sha）；空仓库或降级时缺席。 */
  readonly headBeforeTurn?: string;
  /** 成功补到 diff 的路径。 */
  readonly resolvedPaths: readonly string[];
  /** 请求过但 diff 缺席的路径。 */
  readonly missingPaths: readonly string[];
}

/** diff 采集器。一个实例服务一轮（基线只记一次）。 */
export interface AiderDiffCollector {
  /** 记录 turn 前基线（status + ls-files + HEAD）。幂等。 */
  prime(): Promise<void>;
  /** 取某路径的 unified diff；取不到返回 undefined（绝不返回空串）。 */
  collect(filePath: string): Promise<string | undefined>;
  /**
   * 该路径在 turn 开始前是否已被 git 跟踪。
   * `undefined` = 基线没跑成或不在仓库里，判不出（调用方据此不猜变更类型）。
   */
  wasTrackedBeforeTurn(filePath: string): boolean | undefined;
  /** turn 后的 HEAD；与基线不同即说明有人在本轮里造了 commit（红线核查用）。 */
  headAfterTurn(): Promise<string | undefined>;
  /** 采集诊断快照。 */
  diagnostics(): AiderDiffDiagnostics;
}

/** createAiderDiffCollector 的可选项。 */
export interface AiderDiffCollectorOptions {
  /** 采集基准目录（Agent 工作根）。 */
  readonly cwd: string;
  /** git 执行器，默认 executeAiderGitCommand（单测注入假执行器）。 */
  readonly execute?: AiderGitExecutor | undefined;
  /** 单次 git 命令超时。 */
  readonly timeoutMs?: number | undefined;
  /** 单条 diff 字节上限。 */
  readonly maxDiffBytes?: number | undefined;
}

/**
 * 解析 `git status --porcelain` 的路径列。形如 `XY <path>`；
 * 重命名为 `R  <old> -> <new>`（取新路径）。含特殊字符时 git 给带引号的形式，
 * 此处只去掉外层引号，不做 C 风格反转义（基线仅用于「turn 前已脏」的提示）。
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

/** 转成相对 cwd 的 posix pathspec；不在 cwd 之下则原样返回。 */
export function toAiderPathspec(cwd: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    // aider 的标记行给的本就是相对 git 根的路径，原样归一斜杠即可。
    return filePath.split("\\").join("/");
  }
  const relative = path.relative(cwd, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

/** 创建 diff 采集器。 */
export function createAiderDiffCollector(options: AiderDiffCollectorOptions): AiderDiffCollector {
  const { cwd } = options;
  const execute = options.execute ?? executeAiderGitCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AIDER_GIT_TIMEOUT_MS;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_AIDER_MAX_DIFF_BYTES;

  let repoState: AiderGitRepoState = "unchecked";
  let degradedReason: string | undefined;
  let dirtyBeforeTurn: readonly string[] = [];
  let headBeforeTurn: string | undefined;
  let trackedBeforeTurn: ReadonlySet<string> | undefined;
  const resolvedPaths: string[] = [];
  const missingPaths: string[] = [];
  let priming: Promise<void> | null = null;

  function degrade(state: AiderGitRepoState, reason: string): void {
    repoState = state;
    degradedReason = reason;
  }

  async function readHead(): Promise<string | undefined> {
    const result = await execute(["rev-parse", "HEAD"], cwd, timeoutMs);
    // 空仓库（还没有任何提交）时 rev-parse 会失败，这是正常状态而非降级。
    return result.error === null && result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async function runPrime(): Promise<void> {
    const status = await execute(["status", "--porcelain"], cwd, timeoutMs);
    if (status.error !== null) {
      degrade("git-unavailable", `git 无法执行：${status.error}`);
      return;
    }
    if (status.exitCode !== 0) {
      const notARepo = /not a git repository/i.test(status.stderr);
      degrade(
        notARepo ? "not-a-repository" : "unknown",
        notARepo
          ? `${cwd} 不是 git 仓库，diff 自补整轮缺席`
          : `git status 退出码 ${String(status.exitCode)}：${status.stderr.trim()}`,
      );
      return;
    }
    repoState = "repository";
    dirtyBeforeTurn = parsePorcelainPaths(status.stdout);

    // 已跟踪清单：判 add / update 的唯一可靠依据（见模块头第 2 点）。
    const tracked = await execute(["ls-files"], cwd, timeoutMs);
    if (tracked.error === null && tracked.exitCode === 0) {
      trackedBeforeTurn = new Set(
        tracked.stdout
          .split("\n")
          .map((line) => line.replace(/\r$/, ""))
          .filter((line) => line !== ""),
      );
    }
    headBeforeTurn = await readHead();
  }

  function truncate(diff: string): string {
    return diff.length <= maxDiffBytes
      ? diff
      : `${diff.slice(0, maxDiffBytes)}\n[FF-pane：diff 超过 ${String(maxDiffBytes)} 字节，已截断]\n`;
  }

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
      const pathspec = toAiderPathspec(cwd, filePath);
      // 顺序有意为之：**索引侧优先**。aider 新建的文件已被它 `git add`
      // （§7.3 坑 5），那种情况下 `git diff` 是空的、只有 `--cached` 有内容；
      // 已跟踪文件的改写则落在工作区侧。最后一段兜未跟踪的新文件
      // （有差异时 `--no-index` 返回退出码 1，属正常不是错误）。
      const attempts: readonly {
        readonly args: readonly string[];
        readonly okCodes: readonly number[];
      }[] = [
        { args: ["diff", "--cached", "--", pathspec], okCodes: [0] },
        { args: ["diff", "--", pathspec], okCodes: [0] },
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

    wasTrackedBeforeTurn(filePath: string): boolean | undefined {
      if (trackedBeforeTurn === undefined) {
        return undefined;
      }
      return trackedBeforeTurn.has(toAiderPathspec(cwd, filePath));
    },

    async headAfterTurn(): Promise<string | undefined> {
      if (repoState !== "repository") {
        return undefined;
      }
      return readHead();
    },

    diagnostics(): AiderDiffDiagnostics {
      return {
        repoState,
        ...(degradedReason === undefined ? {} : { degradedReason }),
        dirtyBeforeTurn: [...dirtyBeforeTurn],
        ...(headBeforeTurn === undefined ? {} : { headBeforeTurn }),
        resolvedPaths: [...resolvedPaths],
        missingPaths: [...missingPaths],
      };
    },
  };
}
