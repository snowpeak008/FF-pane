/** Grok Build 适配器（T7.3 + T8.5b ACP）barrel：命令行组装、事件映射、diff 渲染、ACP 轮次、适配器本体。 */

export {
  acpUpdateToNativeRecord,
  GROK_ACP_CANCEL_GRACE_MS,
  GROK_ACP_CANCELLED_MESSAGE,
  GROK_ACP_CLIENT_INFO,
  GROK_ACP_UNMAPPED_TOOL_NOTE,
  type GrokAcpAttempt,
  type GrokAcpAttemptOutcome,
  GrokAcpProtocolError,
  type GrokAcpTurnConfig,
  pickAcpPermissionOption,
  startGrokAcpAttempt,
  toGrokAcpPermissionPayload,
} from "./acp-turn.js";
export {
  createGrokBuildAdapter,
  GROK_BUILD_ACP_CAPABILITIES,
  GROK_BUILD_CAPABILITIES,
  GROK_TRANSPORTS,
  type GrokBuildAdapter,
  type GrokBuildAdapterOptions,
  type GrokBuildTurn,
  type GrokTransport,
} from "./adapter.js";
export {
  buildGrokAcpArgs,
  buildGrokArgs,
  DEFAULT_GROK_COMMAND,
  DEFAULT_GROK_PERMISSION_MODE,
  GROK_BUILD_RUNTIME,
  GROK_PERMISSION_MODES,
  type GrokAcpArgsInput,
  type GrokArgsInput,
  type GrokPermissionMode,
} from "./command.js";
export {
  firstDiffPath,
  type GrokDiffInput,
  renderGrokDiff,
  renderGrokDiffFromContent,
} from "./diff.js";
export {
  createGrokEventMapper,
  type GrokEventMapper,
  type GrokEventMapperOptions,
  type GrokStreamOutcome,
} from "./mapper.js";
