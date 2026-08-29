/**
 * Claude Code 适配器（W2.4）barrel。
 *
 * 对外主入口是 createClaudeCodeAdapter；映射器、参数组装、控制协议三个纯模块
 * 一并导出：它们无 I/O，既是本适配器的实现，也是 fixture 回放测试与后续
 * 权限层（W2.7）复用的协议知识来源。
 */

export {
  CLAUDE_CODE_EXIT_GRACE_MS,
  CLAUDE_CODE_INTERRUPT_TIMEOUT_MS,
  CLAUDE_CODE_STDERR_TAIL_LIMIT,
  type ClaudeCodeAdapterOptions,
  ClaudeCodeProtocolError,
  createClaudeCodeAdapter,
  type SpawnAgentProcessFn,
} from "./adapter.js";
export {
  buildClaudeCodeArgs,
  CLAUDE_CODE_BASE_ARGS,
  CLAUDE_CODE_DEFAULT_COMMAND,
  CLAUDE_CODE_HIDDEN_ARGS,
  CLAUDE_CODE_PERMISSION_PROMPT_ARGS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_SETTING_SOURCES,
  type ClaudeCodeCliOptions,
  type ClaudeCodeTurnArgs,
  type ClaudePermissionMode,
  type ClaudeSettingSource,
} from "./args.js";
export {
  buildInterruptRequest,
  buildPermissionResponse,
  buildUserMessage,
  CLAUDE_DENY_MESSAGE,
  CLAUDE_UNMAPPED_TOOL_DENY_MESSAGE,
  type ClaudeCanUseToolRequest,
  type ClaudeControlReceipt,
  type ClaudeStdinMessage,
  parseCanUseToolRequest,
  parseControlReceipt,
  serializeStdinLine,
} from "./control.js";
export { formatStructuredPatch } from "./diff.js";
export {
  type ClaudeCodeMapperOptions,
  type ClaudeCodeMapperState,
  createClaudeCodeMapperState,
  mapClaudeCodeRecord,
  toPermissionPayload,
} from "./mapper.js";
export {
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_RUNTIME,
  CLAUDE_COMMAND_TOOLS,
  CLAUDE_FILE_TOOLS,
  CLAUDE_INTERRUPT_RECEIPT_CAPABILITY,
  CLAUDE_NETWORK_TOOLS,
  CLAUDE_READ_TOOLS,
} from "./native.js";
