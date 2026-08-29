/** cli_login 登录态探测（W1.5d）barrel。 */

export { executeWithChildProcess } from "./executor.js";
export { DEFAULT_PROBE_TIMEOUT_MS, probeCliLogin } from "./probe.js";
export { PROBE_RULES, type RuntimeProbeRule } from "./rules.js";
export { MAX_DETAIL_EXCERPT_LENGTH, sanitizeOutputExcerpt, stripAnsi } from "./sanitize.js";
export {
  CLI_LOGIN_RUNTIMES,
  CLI_LOGIN_STATUSES,
  type CliLoginProbeResult,
  type CliLoginRuntime,
  type CliLoginStatus,
  type CompletedExecution,
  type ExecutionOutcome,
  isCliLoginRuntime,
  type ProbeCliLoginOptions,
  type ProcessExecutor,
} from "./types.js";
