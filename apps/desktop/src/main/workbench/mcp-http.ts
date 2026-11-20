/**
 * 工作台 MCP 的 HTTP 服务（T11.19 第二部分）：主进程里共用一个，代替每个窗口一个 electron 小进程。
 *
 * - 地址 `http://127.0.0.1:<随机端口>/mcp`，只听本机回环；主进程重启端口会变，窗口续接时照常重新生成配置。
 * - MCP Streamable HTTP，不开会话（不发 Mcp-Session-Id），GET / DELETE 回 405。
 * - 请求头 `Host` 只认 `127.0.0.1:<端口>` / `localhost:<端口>`，带 `Origin` 的一律拒（防 DNS 重绑定）。
 * - 认证：`Authorization: Bearer <窗口令牌>`，和控制通道同一套令牌；无效回 401。令牌不进日志。
 * - 协议处理复用 `mcp/protocol.ts`；工具执行由调用方接到控制通道同一段分发代码，这里不做授权。
 * - 工具调用回 SSE，每 15 秒发一行注释加一条进度通知（请求带了 progressToken 才发通知）：
 *   注释保连接，通知让 Claude 重新计时（Claude 走 HTTP 时 300 秒没有结果或进度就掐断，注释行不算，计划 §3.4）。
 *   请求没带 progressToken 时只发注释，靠 Claude 配置里的 `"timeout": 600000` 兜底。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveCaller, type WindowTokenRegistry } from "@ff-pane/core";
import {
  handleMcpMessage,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpToolDefinition,
  type McpToolResult,
} from "../../mcp/protocol";

export const WORKBENCH_MCP_HTTP_PATH = "/mcp";
/** 长调用的保活间隔。 */
export const MCP_HTTP_KEEPALIVE_MS = 15_000;
/** 和控制通道一样：256KB brief 加 JSON 转义余量。 */
export const MCP_HTTP_MAX_BODY_BYTES = 1024 * 1024;

export const MCP_HTTP_UNAUTHORIZED_TEXT =
  "窗口令牌无效或已作废（窗口可能已经重启或关闭）。请重启该窗口后再试。";

export type McpHttpScreen =
  | { readonly ok: true; readonly windowId: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** 只看请求行和头，决定放不放行。纯函数。 */
export function screenMcpHttpRequest(
  input: {
    readonly method: string;
    readonly path: string;
    readonly host: string | undefined;
    readonly origin: string | undefined;
    readonly authorization: string | undefined;
  },
  port: number,
  resolveToken: (token: string) => string | null,
): McpHttpScreen {
  const path = input.path.split("?")[0] ?? "";
  if (path !== WORKBENCH_MCP_HTTP_PATH) {
    return { ok: false, status: 404, reason: "not-found" };
  }
  const host = (input.host ?? "").trim().toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, reason: "bad-host" };
  }
  if (input.origin !== undefined && input.origin.trim() !== "") {
    return { ok: false, status: 403, reason: "origin" };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(input.authorization ?? "");
  const windowId = match?.[1] !== undefined ? resolveToken(match[1]) : null;
  if (windowId === null) {
    return { ok: false, status: 401, reason: "unauthorized" };
  }
  if (input.method !== "POST") {
    return { ok: false, status: 405, reason: "method" };
  }
  return { ok: true, windowId };
}

/** 一次保活：注释行，加上（有 progressToken 时）一条进度通知。beat 从 1 起，逐次加一。 */
export function keepaliveFrames(beat: number, progressToken: string | number | undefined): string {
  const comment = `: keepalive ${beat}\n\n`;
  if (progressToken === undefined) {
    return comment;
  }
  const note = {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress: beat },
  };
  return `${comment}event: message\ndata: ${JSON.stringify(note)}\n\n`;
}

/** 请求 `params._meta.progressToken`：只认字符串或数字。 */
export function progressTokenOf(message: JsonRpcMessage): string | number | undefined {
  const params = message.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const meta = (params as Record<string, unknown>)["_meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  const token = (meta as Record<string, unknown>)["progressToken"];
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

export interface WorkbenchMcpHttpServerOptions {
  readonly tokens: WindowTokenRegistry;
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpToolDefinition[];
  /** 已经认出是哪个窗口；工具名和参数原样交给控制通道那段分发代码。 */
  readonly execute: (
    windowId: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<McpToolResult>;
  /** 只接收固定短句，不含令牌和正文。 */
  readonly log?: (message: string) => void;
  readonly keepaliveMs?: number;
}

export interface WorkbenchMcpHttpServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function rpcError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string | "oversize"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        over = true;
        resolve("oversize");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

export function createWorkbenchMcpHttpServer(
  options: WorkbenchMcpHttpServerOptions,
): Promise<WorkbenchMcpHttpServer> {
  const keepaliveMs = options.keepaliveMs ?? MCP_HTTP_KEEPALIVE_MS;
  const log = (message: string): void => {
    options.log?.(message);
  };
  let port = 0;

  const protocolFor = (windowId: string) => ({
    name: options.name,
    version: options.version,
    tools: options.tools,
    execute: (name: string, args: Readonly<Record<string, unknown>>) =>
      options.execute(windowId, name, args),
  });

  const streamCall = async (
    res: ServerResponse,
    message: JsonRpcMessage,
    windowId: string,
  ): Promise<void> => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders();
    const progressToken = progressTokenOf(message);
    let beat = 0;
    let closedEarly = false;
    const timer = setInterval(() => {
      beat += 1;
      res.write(keepaliveFrames(beat, progressToken));
    }, keepaliveMs);
    res.on("close", () => {
      clearInterval(timer);
      if (!res.writableEnded) {
        closedEarly = true;
      }
    });
    const response = await handleMcpMessage(message, protocolFor(windowId));
    clearInterval(timer);
    if (closedEarly || res.destroyed) {
      log("client closed before the tool call returned");
      return;
    }
    res.end(response === null ? "" : `event: message\ndata: ${JSON.stringify(response)}\n\n`);
  };

  const handlePost = async (
    req: IncomingMessage,
    res: ServerResponse,
    windowId: string,
  ): Promise<void> => {
    const raw = await readBody(req, MCP_HTTP_MAX_BODY_BYTES);
    if (raw === "oversize") {
      log("oversize");
      sendJson(res, 413, rpcError(JSON_RPC_INVALID_REQUEST, "请求太大"));
      req.destroy();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(JSON_RPC_PARSE_ERROR, "JSON 解析失败"));
      return;
    }
    const batch = Array.isArray(parsed);
    const messages = (batch ? (parsed as unknown[]) : [parsed]).filter(
      (item): item is JsonRpcMessage =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
    if (messages.length === 0) {
      sendJson(res, 400, rpcError(JSON_RPC_INVALID_REQUEST, "请求必须是 JSON 对象"));
      return;
    }
    const requests = messages.filter(
      (message) => message.id !== undefined && typeof message.method === "string",
    );
    if (requests.length === 0) {
      // 只有通知（initialized、cancelled 等）或回包：都不用处理，照规定回 202，不带正文
      sendJson(res, 202);
      return;
    }
    const accept = String(req.headers.accept ?? "");
    const single = !batch && requests.length === 1 ? requests[0] : undefined;
    if (single?.method === "tools/call" && accept.includes("text/event-stream")) {
      await streamCall(res, single, windowId);
      return;
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await handleMcpMessage(message, protocolFor(windowId));
      if (response !== null) {
        responses.push(response);
      }
    }
    sendJson(res, 200, batch ? responses : responses[0]);
  };

  const server = createServer((req, res) => {
    const screen = screenMcpHttpRequest(
      {
        method: req.method ?? "",
        path: req.url ?? "",
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
      },
      port,
      (token) => resolveCaller(options.tokens, token),
    );
    if (!screen.ok) {
      if (screen.reason !== "method" && screen.reason !== "not-found") {
        log(screen.reason);
      }
      if (screen.status === 401) {
        sendJson(res, 401, rpcError(-32001, MCP_HTTP_UNAUTHORIZED_TEXT));
      } else if (screen.status === 405) {
        res.writeHead(405, { Allow: "POST" });
        res.end();
      } else {
        sendJson(res, screen.status);
      }
      req.resume();
      return;
    }
    handlePost(req, res, screen.windowId).catch(() => {
      log("request failed");
      if (!res.headersSent) {
        sendJson(res, 500);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}${WORKBENCH_MCP_HTTP_PATH}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
