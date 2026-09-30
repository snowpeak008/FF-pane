/** 工作台主进程模块（T10.4 CLI 启动）。 */

export {
  assertSecretAbsent,
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
  CLAUDE_INTERACTIVE_COMMAND,
  CODEX_INTERACTIVE_COMMAND,
} from "./cli-args";
export {
  assertTestCodexHomeIsolated,
  CodexSessionClaimer,
  collectCodexSessionScanDayDirs,
  cwdEquals,
  formatDayDir,
  isAutomatedTestEnv,
  isRealUserCodexPath,
  localDayParts,
  normalizeWorkbenchCwd,
  parseCodexRolloutSessionMeta,
  pickCodexSessionForClaim,
  readFileFirstLine,
  resolveCodexHome,
  shiftDayParts,
  utcDayParts,
} from "./codex-claim";
export {
  createWorkbenchCliLayer,
  releaseMcpForTerminalMetadata,
  type WorkbenchCliLayer,
} from "./handlers";
export {
  assertLaunchCliIpcSafe,
  launchCliWindow,
  MAX_INITIAL_PROMPT_CHARS,
  WorkbenchCliLaunchError,
  WorkbenchMcpTempRegistry,
} from "./launch-cli";
export {
  cleanupStaleWorkbenchMcpDirs,
  WORKBENCH_MCP_DIR_PREFIX,
  writeWorkbenchClaudeMcpFile,
} from "./mcp-temp";
