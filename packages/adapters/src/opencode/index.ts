/**
 * OpenCode 适配器（W2.6）barrel。
 *
 * 分层：sse（行协议）→ mapper（事件语义）→ client（端点组装）→ server（进程
 * 生命周期）→ adapter（turn 模型）。前三层是纯逻辑，可脱离真实 OpenCode 测试。
 */

export {
  createOpenCodeAdapter,
  DEFAULT_ABORT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  OPENCODE_CLI_FALLBACK_CAPABILITIES,
  OPENCODE_SERVER_CAPABILITIES,
  type OpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from "./adapter.js";
export {
  type CreateSessionInput,
  createOpenCodeClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type FetchLike,
  OPENCODE_BASIC_AUTH_USER,
  type OpenCodeClient,
  type OpenCodeClientOptions,
  OpenCodeHttpError,
  type OpenCodePermissionReply,
  type OpenCodeSession,
  type PromptInput,
} from "./client.js";
export {
  createOpenCodeEventMapper,
  OPENCODE_RUNTIME,
  type OpenCodeEventMapper,
  type OpenCodeMapperOptions,
  type OpenCodeModelRef,
  parseOpenCodeModel,
} from "./mapper.js";
export {
  isAbsolutePath,
  isSamePath,
  normalizeOpenCodePath,
  type PathRootSplit,
  splitPathRoot,
} from "./paths.js";
export {
  createOpenCodeServer,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  type OpenCodeServer,
  OpenCodeServerError,
  type OpenCodeServerOptions,
  type OpenCodeServerRequest,
  type OpenCodeServerState,
  type OpenCodeServerStatus,
} from "./server.js";
export {
  createSseDecoder,
  decodeSseMessages,
  readSseJsonRecords,
  type SseDecoder,
  type SseMessage,
} from "./sse.js";
