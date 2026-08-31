/** Aider 适配器（T7.3b）barrel：命令行组装、stdout 行扫描、事件映射、git diff 自补、适配器本体。 */

export {
  AIDER_CAPABILITIES,
  AIDER_KEY_ENV_NAMES,
  type AiderAdapter,
  type AiderAdapterOptions,
  type AiderTurn,
  createAiderAdapter,
} from "./adapter.js";
export {
  AIDER_FIXED_ENV,
  AIDER_RUNTIME,
  AIDER_TERMINAL_COLUMNS,
  type AiderArgsInput,
  AiderSecretInArgvError,
  assertNoSecretInSetEnv,
  buildAiderArgs,
  DEFAULT_AIDER_COMMAND,
} from "./command.js";
export {
  type AiderDiffCollector,
  type AiderDiffCollectorOptions,
  type AiderDiffDiagnostics,
  type AiderGitExecutor,
  type AiderGitRepoState,
  type AiderGitResult,
  createAiderDiffCollector,
  DEFAULT_AIDER_GIT_TIMEOUT_MS,
  DEFAULT_AIDER_MAX_DIFF_BYTES,
  executeAiderGitCommand,
  toAiderPathspec,
} from "./git-diff.js";
export {
  type AiderEventMapper,
  type AiderEventMapperOptions,
  type AiderStreamOutcome,
  couldBecomeMarkerPrefix,
  createAiderEventMapper,
} from "./mapper.js";
export {
  type AiderLine,
  type AiderLineKind,
  parseEditFormat,
  parseTokenCount,
  scanAiderLine,
} from "./scanner.js";
