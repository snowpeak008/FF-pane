/**
 * cli_login 类型 Provider 的登录态探测——类型定义（W1.5d）。
 *
 * 说明：packages/adapters 尚未接线 @ff-pane/shared，本文件的字符串联合与
 * 守卫为本地定义，Phase 2 接线时统一归并（工单约定）。
 */

/** 支持 cli_login 探测的 Agent Runtime 标识。 */
export const CLI_LOGIN_RUNTIMES = ["codex", "claude-code", "gemini-cli", "opencode"] as const;

/** cli_login Runtime 字符串联合。 */
export type CliLoginRuntime = (typeof CLI_LOGIN_RUNTIMES)[number];

/** CliLoginRuntime 运行时守卫（设置页校验持久化值时使用）。 */
export function isCliLoginRuntime(value: unknown): value is CliLoginRuntime {
  return typeof value === "string" && (CLI_LOGIN_RUNTIMES as readonly string[]).includes(value);
}

/** 探测结论字面量。 */
export const CLI_LOGIN_STATUSES = ["logged_in", "logged_out", "cli_missing", "unknown"] as const;

/**
 * 探测结论：
 * - logged_in    CLI 自带登录态可用（cli_login 类型 Provider 即刻可用）；
 * - logged_out   CLI 存在但未登录，需引导用户去终端完成登录；
 * - cli_missing  PATH 中找不到该 CLI 可执行文件；
 * - unknown      超时 / 异常输出 / 未知退出码，无法判定。
 */
export type CliLoginStatus = (typeof CLI_LOGIN_STATUSES)[number];

/** probeCliLogin 的返回结构。 */
export interface CliLoginProbeResult {
  readonly status: CliLoginStatus;
  /** 人类可读的判定依据。已做敏感内容过滤与长度截断，可直接展示/入日志。 */
  readonly detail: string;
  /** 实际执行的探测命令行（命令 + 参数），供 UI 展示与排障。 */
  readonly probedWith: string;
}

/** 进程正常跑完（含非零退出码）的执行结果。 */
export interface CompletedExecution {
  readonly kind: "completed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 执行器三态结果：
 * - completed    进程退出（任意退出码）；
 * - cli_missing  可执行文件不存在（ENOENT / PATH 查找失败）；
 * - timeout      超过 timeoutMs 未退出（执行器负责终止进程）。
 */
export type ExecutionOutcome =
  | CompletedExecution
  | { readonly kind: "cli_missing" }
  | { readonly kind: "timeout" };

/**
 * 进程执行器接口。生产实现见 executor.ts（child_process.spawn 非 shell 模式，
 * Windows 下处理 npm .cmd 垫片）；测试注入假执行器。
 */
export type ProcessExecutor = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ExecutionOutcome>;

/** probeCliLogin 可选项。 */
export interface ProbeCliLoginOptions {
  /** 注入执行器（默认为 child_process 生产实现）。 */
  readonly execute?: ProcessExecutor;
  /** 超时毫秒数，默认 10_000。Node 系 CLI 冷启动偏慢，UI 侧可酌情放宽。 */
  readonly timeoutMs?: number;
}
