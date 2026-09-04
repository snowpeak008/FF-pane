/**
 * ACP 的 JSON-RPC 2.0 信封层（T8.5a）：消息类型、编码、单行分类。
 *
 * **分帧是 NDJSON（换行分隔的 JSON），不是 LSP 式 Content-Length 头。**
 * 依据（两处独立印证）：① 官方规范 Transports 节明文
 * "Messages are delimited by newlines (`\n`), and MUST NOT contain embedded
 * newlines"（agentclientprotocol.com/protocol/transports，stdio 传输）；
 * ② 仓内证据 grok-build.md §2——grok 的 `--output-format streaming-json`
 * 本就是其 ACP session update 的 NDJSON 投影。字节流 → 行的切分复用
 * events/jsonl.ts 的 createLineDecoder（半包缓冲 / 粘包拆分 / 超长防护 /
 * 跨 chunk 多字节字符，T2.x 起被四家适配器实测钉住），本层不再造一套。
 *
 * 与 apps/desktop/src/mcp/protocol.ts（T6.6 自研 MCP 服务端）的关系：同一款式
 * （手写 JSON-RPC、逐行收发、错误码常量），但方向相反——MCP 那边 FF-pane 是
 * **服务端**（收请求回响应），这里 FF-pane 是 ACP **Client**（双工：发请求也收
 * Agent 反向的请求/通知），故 id 关联、未决表、超时归本包 connection.ts。
 * 批量请求（JSON-RPC batch）双方都用不到，刻意不做。
 */

/** JSON-RPC 2.0 的 id：字符串或数字（null 仅见于响应侧的"无从关联"，见下）。 */
export type AcpJsonRpcId = string | number;

/** 出站请求（FF-pane → Agent，期待响应）。 */
export interface AcpOutgoingRequest {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

/** 出站通知（无 id，不期待响应；session/cancel 走这条）。 */
export interface AcpOutgoingNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC 错误对象。 */
export interface AcpJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 出站响应（回给 Agent 发来的请求，如 session/request_permission 的回执）。 */
export interface AcpOutgoingResponse {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId | null;
  readonly result?: unknown;
  readonly error?: AcpJsonRpcError;
}

// JSON-RPC 2.0 标准错误码（与 mcp/protocol.ts 同值；ACP schema ErrorCode 收录同一批）
export const ACP_JSON_RPC_PARSE_ERROR = -32700;
export const ACP_JSON_RPC_INVALID_REQUEST = -32600;
export const ACP_JSON_RPC_METHOD_NOT_FOUND = -32601;
export const ACP_JSON_RPC_INVALID_PARAMS = -32602;
export const ACP_JSON_RPC_INTERNAL_ERROR = -32603;

// ACP 专属错误码（schema-v1.21.0 ErrorCode 的保留区段 -32000~-32099 + -32800）
/** 认证未完成就调 session/new 等方法时 Agent 回的错误。 */
export const ACP_ERROR_AUTH_REQUIRED = -32000;
/** 资源（如文件）不存在。 */
export const ACP_ERROR_RESOURCE_NOT_FOUND = -32002;
/** 请求被取消（取消请求或资源约束/关停导致方法执行中止）。 */
export const ACP_ERROR_REQUEST_CANCELLED = -32800;

/** 判断是否为 JSON 对象（排除 null 与数组；与 events/jsonl.ts 的 isJsonObject 同义）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 合法的消息 id（规范：字符串或数字；null 不做出站 id、入站见 classify 注释）。 */
function isValidId(value: unknown): value is AcpJsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

/** 编码一条出站消息为一帧（JSON + 换行；JSON.stringify 保证正文无裸换行符）。 */
export function encodeAcpMessage(
  message: AcpOutgoingRequest | AcpOutgoingNotification | AcpOutgoingResponse,
): string {
  return `${JSON.stringify(message)}\n`;
}

/** 构造出站请求。params 为 undefined 时整个字段省略（JSON-RPC 允许缺省）。 */
export function buildAcpRequest(
  id: AcpJsonRpcId,
  method: string,
  params?: unknown,
): AcpOutgoingRequest {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/** 构造出站通知。 */
export function buildAcpNotification(method: string, params?: unknown): AcpOutgoingNotification {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

/** 构造成功响应。result 恒在场（JSON-RPC 要求成功响应必含 result，空结果用 {}）。 */
export function buildAcpResult(id: AcpJsonRpcId, result: unknown): AcpOutgoingResponse {
  return { jsonrpc: "2.0", id, result: result === undefined ? {} : result };
}

/** 构造错误响应。 */
export function buildAcpError(
  id: AcpJsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): AcpOutgoingResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** 分类结果：入站请求（Agent → FF-pane，要回执）。 */
export interface AcpIncomingRequest {
  readonly kind: "request";
  readonly id: AcpJsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

/** 分类结果：入站通知（session/update 等，不回包）。 */
export interface AcpIncomingNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

/** 分类结果：入站响应（关联此前发出的请求）。 */
export interface AcpIncomingResponse {
  readonly kind: "response";
  readonly id: AcpJsonRpcId;
  readonly result?: unknown;
  readonly error?: AcpJsonRpcError;
}

/** 分类结果：畸形消息（进诊断通道，不抛、不回包，原文保留）。 */
export interface AcpInvalidMessage {
  readonly kind: "invalid";
  readonly raw: string;
  readonly reason: string;
}

/** 一行输入的分类结果（空行返回 undefined，忽略）。 */
export type AcpClassifiedMessage =
  | AcpIncomingRequest
  | AcpIncomingNotification
  | AcpIncomingResponse
  | AcpInvalidMessage;

function invalid(raw: string, reason: string): AcpInvalidMessage {
  return { kind: "invalid", raw, reason };
}

function classifyError(value: Record<string, unknown>): AcpJsonRpcError | undefined {
  const error = value["error"];
  if (!isObject(error)) {
    return undefined;
  }
  const code = error["code"];
  const message = error["message"];
  return {
    code: typeof code === "number" ? code : ACP_JSON_RPC_INTERNAL_ERROR,
    message: typeof message === "string" ? message : "（Agent 未给出错误描述）",
    ...(error["data"] === undefined ? {} : { data: error["data"] }),
  };
}

/**
 * 解析并分类一行输入。
 *
 * 畸形形态一律归 invalid（调用方进诊断通道），**不回包**：解析失败拿不到 id，
 * 回 id:null 的错误 Agent 也无从关联；且双工通道上两端互回错误响应容易形成
 * 回声噪声。这与 mcp/protocol.ts（服务端，规范建议回 parse error）刻意不同——
 * 客户端侧的畸形输入是对端的缺陷证据，留档比回执有用。
 *
 * id 为 null 的"响应"也归 invalid：那是对端表示"无从关联你的请求"（JSON-RPC
 * 对未知 id 的约定），本端未决表里不可能有 null 键，只能留档。
 */
export function classifyAcpLine(line: string): AcpClassifiedMessage | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (thrown) {
    return invalid(
      line,
      `JSON 解析失败：${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  if (!isObject(parsed)) {
    return invalid(line, "顶层不是 JSON 对象（批量请求不支持，ACP 双方都用不到）");
  }

  const method = parsed["method"];
  const id = parsed["id"];
  if (typeof method === "string") {
    if (id === undefined) {
      return { kind: "notification", method, params: parsed["params"] };
    }
    if (!isValidId(id)) {
      return invalid(line, `请求的 id 非法（须为字符串或数字）：${String(id)}`);
    }
    return { kind: "request", id, method, params: parsed["params"] };
  }

  if ("result" in parsed || "error" in parsed) {
    if (!isValidId(id)) {
      return invalid(line, "响应的 id 无从关联（缺失或为 null）");
    }
    const error = classifyError(parsed);
    return {
      kind: "response",
      id,
      ...(error === undefined ? { result: parsed["result"] } : { error }),
    };
  }

  return invalid(line, "既无 method 也无 result/error，不是 JSON-RPC 消息");
}
