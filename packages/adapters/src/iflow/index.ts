/** iFlow 适配器 barrel（T8.6b）。 */

export {
  IFLOW_ACP_CANCEL_GRACE_MS,
  IFLOW_ACP_CLIENT_CAPABILITIES,
  IFLOW_ACP_CLIENT_INFO,
  IFLOW_ACP_UNMAPPED_TOOL_NOTE,
  IFLOW_NOAUTH_MESSAGE,
  IFlowAcpProtocolError,
  type IFlowAcpTurn,
  type IFlowAcpTurnConfig,
  pickIFlowPermissionOption,
  startIFlowAcpTurn,
  toIFlowPermissionPayload,
} from "./acp-turn.js";
export {
  createIFlowAdapter,
  IFLOW_CAPABILITIES,
  type IFlowAdapter,
  type IFlowAdapterOptions,
  type IFlowTurn,
} from "./adapter.js";
export {
  buildIFlowAcpArgs,
  buildIFlowEnv,
  DEFAULT_IFLOW_ACP_MODE,
  DEFAULT_IFLOW_COMMAND,
  IFLOW_ACP_MODES,
  IFLOW_DISPLAY_NAME,
  IFLOW_MANAGED_SETTINGS_JSON,
  IFLOW_RUNTIME,
  type IFlowAcpMode,
  type IFlowEnvInput,
} from "./command.js";
export {
  commandFromIFlowTitle,
  createIFlowEventMapper,
  type IFlowEventMapper,
  type IFlowStreamOutcome,
  iflowSessionStart,
} from "./mapper.js";
