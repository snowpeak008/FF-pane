/**
 * 最小 MCP 服务端协议层（T6.6，设计文档 §8.3.5 路径二）。
 *
 * **为什么手写而不引 @modelcontextprotocol/sdk**：本服务端的工具面只有一个只读检索工具，
 * 用到的协议面就是 initialize / tools/list / tools/call / ping 四个方法，没有 resources、
 * prompts、sampling、订阅、进度通知。为这四个方法引一条生产依赖及其传递依赖并进打包体积，
 * 与本仓既有取舍一致地不划算（自研 RAG 管道而不引 LangChain、手写 HTML 扫描器而不引 jsdom，
 * 见技术选型 §7 / T6.1 报告）。协议面一旦扩大（resources / 双向通知），再换 SDK 不迟。
 *
 * **传输恒为 stdio**：JSON-RPC 2.0 逐行收发。不监听端口、不建连接、不产生任何网络流量，
 * 因此与用户的 VPN、系统代理、防火墙完全无关——这不是顺带的好处，而是选 stdio 的主要原因。
 *
 * 本模块是**纯逻辑**：不碰 stdin/stdout、不认识 SQLite，工具执行经 {@link McpToolExecutor}
 * 注入。故整套协议行为（版本协商、未知方法、坏参数、通知不回包）可以不起进程地单测。
 */

/** JSON-RPC 2.0 的 id：字符串、数字或 null。通知（notification）无 id。 */
export type JsonRpcId = string | number | null;

/** 收到的一条 JSON-RPC 消息（请求或通知）。 */
export interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** 回出去的一条 JSON-RPC 响应。 */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/** JSON-RPC 错误对象。 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** JSON-RPC 2.0 标准错误码（只列本服务端会产出的几个）。 */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * 本服务端认识的协议版本，**新的在前**。
 *
 * 版本协商按 MCP 约定：客户端报什么版本，我们认识就原样回它；不认识就回我们最新的，
 * 由客户端决定还谈不谈。刻意保留 2024-11-05——codex 与 claude 的版本各自演进，
 * 少认一个老版本就等于对某个 CLI 版本静默不可用。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** 缺省协议版本（客户端没报或报了不认识的版本时回它）。 */
export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** MCP 工具声明（tools/list 的条目形状）。 */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（object 类型）。 */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 工具执行结果：文本内容 + 是否为「工具自身出错」。 */
export interface McpToolResult {
  /** 回给模型看的文本。 */
  readonly text: string;
  /**
   * 工具执行失败（如检索抛错）。
   * 按 MCP 约定这类失败**不走 JSON-RPC error**，而是正常结果加 isError——
   * 模型要能看见失败原因并自己调整，走协议错误它就只知道"调用没成功"。
   */
  readonly isError?: boolean;
}

/** 工具执行器（由宿主注入；本层不认识 SQLite）。 */
export type McpToolExecutor = (
  name: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<McpToolResult>;

/** 服务端装配参数。 */
export interface McpServerOptions {
  /** 服务端自报的名字（serverInfo.name）。 */
  readonly name: string;
  /** 服务端自报的版本（serverInfo.version）。 */
  readonly version: string;
  /** 全部工具声明。**本服务端只会给出只读检索一个**（§8.3.5）。 */
  readonly tools: readonly McpToolDefinition[];
  /** 工具执行器。 */
  readonly execute: McpToolExecutor;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 取出 params 里的对象；非对象一律当空表（宽进，坏参数交由各方法自己判）。 */
function paramsObject(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

/**
 * 处理一条已解析的消息。
 *
 * 返回 `null` 表示**不该回包**——通知（无 id）按 JSON-RPC 规定无响应。
 * `notifications/initialized` 正是走这条路径：回了反而是协议错误。
 */
export async function handleMcpMessage(
  message: JsonRpcMessage,
  options: McpServerOptions,
): Promise<JsonRpcResponse | null> {
  const method = typeof message.method === "string" ? message.method : undefined;
  // 无 id = 通知：无论认不认识这个方法，都不回包
  const isNotification = message.id === undefined;
  const id: JsonRpcId = message.id ?? null;

  if (method === undefined) {
    return isNotification ? null : fail(id, JSON_RPC_INVALID_REQUEST, "缺少 method");
  }

  if (isNotification) {
    return null;
  }

  switch (method) {
    case "initialize": {
      const requested = paramsObject(message.params)["protocolVersion"];
      const version =
        typeof requested === "string" &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : PREFERRED_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        // 只声明 tools：本服务端没有 resources / prompts / 日志订阅，声明了就是撒谎
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.name, version: options.version },
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: options.tools });

    case "tools/call": {
      const params = paramsObject(message.params);
      const name = params["name"];
      if (typeof name !== "string" || name.length === 0) {
        return fail(id, JSON_RPC_INVALID_PARAMS, "tools/call 缺少 name");
      }
      if (!options.tools.some((tool) => tool.name === name)) {
        return fail(id, JSON_RPC_INVALID_PARAMS, `未知工具：${name}`);
      }
      const args = paramsObject(params["arguments"]);
      let result: McpToolResult;
      try {
        result = await options.execute(name, args);
      } catch (thrown) {
        // 工具抛错走 isError 结果而非协议错误（见 McpToolResult.isError 注释）
        result = {
          text: `检索失败：${thrown instanceof Error ? thrown.message : String(thrown)}`,
          isError: true,
        };
      }
      return ok(id, {
        content: [{ type: "text", text: result.text }],
        ...(result.isError === true ? { isError: true } : {}),
      });
    }

    default:
      return fail(id, JSON_RPC_METHOD_NOT_FOUND, `未知方法：${method}`);
  }
}

/**
 * 解析一行输入并处理。返回 `null` 同样表示不回包。
 * 空行忽略（客户端的换行心跳不该被当成解析错误刷屏）。
 */
export async function handleMcpLine(
  line: string,
  options: McpServerOptions,
): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 解析失败拿不到 id，按 JSON-RPC 规定回 id: null
    return fail(null, JSON_RPC_PARSE_ERROR, "JSON 解析失败");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(null, JSON_RPC_INVALID_REQUEST, "请求必须是 JSON 对象");
  }
  return handleMcpMessage(parsed as JsonRpcMessage, options);
}
