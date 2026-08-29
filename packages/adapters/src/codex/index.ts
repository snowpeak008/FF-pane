/** Codex CLI 适配器（W2.3）barrel：命令行组装、事件映射、git diff 自补、适配器本体。 */

export {
  CODEX_CAPABILITIES,
  type CodexAdapter,
  type CodexAdapterOptions,
  type CodexTurn,
  createCodexAdapter,
} from "./adapter.js";
export {
  buildCodexArgs,
  CODEX_RUNTIME,
  CODEX_SANDBOX_POLICIES,
  type CodexArgsInput,
  type CodexSandboxPolicy,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_SANDBOX_POLICY,
} from "./command.js";
export {
  type CodexDiffCollector,
  type CodexDiffCollectorOptions,
  type CodexDiffDiagnostics,
  type CodexGitExecutor,
  type CodexGitRepoState,
  type CodexGitResult,
  createCodexDiffCollector,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_MAX_DIFF_BYTES,
  executeCodexGitCommand,
  toGitPathspec,
} from "./git-diff.js";
export {
  CODEX_SANDBOX_ERROR_EXIT_CODE,
  type CodexEventMapper,
  type CodexEventMapperOptions,
  type CodexStreamOutcome,
  createCodexEventMapper,
} from "./mapper.js";
