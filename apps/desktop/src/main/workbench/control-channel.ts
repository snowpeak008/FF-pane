/**
 * 工作台控制通道（T10.6'，T10.7 扩展工具调用）。
 *
 * 本地 IPC，禁止 HTTP / TCP 端口：
 * - Windows：命名管道 `\\.\pipe\ff-pane-wb-<随机>`
 * - 其它平台：临时目录里的 Unix socket
 *
 * 管道名经环境变量 FF_PANE_WB_PIPE 传给 CLI（hook 与 sidecar 继承）。
 * 协议：按行 JSON。每条请求带 FF_PANE_WINDOW_TOKEN，主进程 resolveCaller。
 * 令牌无效则拒绝并断开。令牌永不写入日志。
 *
 * 请求：
 * {"v":1,"type":"hook","token":"...","event":"Stop"|"PermissionRequest"|"UserPromptSubmit"|"SessionStart"|"Notification","hookEvent"?:string}
 * {"v":1,"type":"tool","token":"...","name":"ffpane_whoami","arguments":{}}
 *
 * 限流仍是每条连接 30 条/秒。hook 与工具调用各自新建连接，这个上限挡不住跨连接的突发。
 * 工具调用另有按窗口每秒 30 次的计数（见 mcp-tools）。单条上限提到 1MB，以便 256KB 的 brief 能通过。
 *
 * 响应：{"v":1,"ok":true} 或 {"v":1,"ok":false,"error":"unauthorized"|"oversize"|"rate"|"malformed"|"unsupported"}
 */

import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FF_PANE_WB_PIPE_ENV, resolveCaller, type WindowTokenRegistry } from "@ff-pane/core";
import type { HookSignal } from "./idle-deliver";

export const WB_CONTROL_PROTOCOL_VERSION = 1;
export const DEFAULT_CONTROL_MAX_REQUEST_BYTES = 16 * 1024;
/** 工作台工具通道：256KB brief + JSON 转义余量。 */
export const WORKBENCH_TOOL_MAX_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_MAX_PER_SECOND = 30;

export { FF_PANE_WB_PIPE_ENV };

export type ControlRejectError = "unauthorized" | "oversize" | "rate" | "malformed" | "unsupported";

export interface WorkbenchControlRequestContext {
  readonly windowId: string;
  readonly type: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface WorkbenchControlServerOptions {
  readonly tokens: WindowTokenRegistry;
  readonly onHook: (
    windowId: string,
    signal: HookSignal,
    meta?: {
      readonly hookEvent?: string;
      readonly toolUseId?: string;
      readonly toolDigest?: string;
      readonly sessionId?: string;
      readonly releasePermissions?: boolean;
    },
  ) => void;
  /**
   * T10.7：hook 以外的请求类型。未提供或返回 unsupported 时拒绝该条，不断开
   * （令牌已经核验过）。返回 ok 则把 result 放进响应。
   */
  readonly onRequest?: (
    context: WorkbenchControlRequestContext,
  ) =>
    | { readonly ok: true; readonly result?: unknown }
    | { readonly ok: false; readonly error: string }
    | Promise<
        | { readonly ok: true; readonly result?: unknown }
        | { readonly ok: false; readonly error: string }
      >;
  /** 只接收固定短句。实现不得把请求正文或令牌传进来。 */
  readonly log?: (message: string) => void;
  readonly maxRequestBytes?: number;
  readonly maxPerSecond?: number;
}

export interface WorkbenchControlServer {
  readonly address: string;
  close(): Promise<void>;
}

const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_DIGEST = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 只接受短 id。其它字段（工具参数、正文）不读取。 */
function readToolUseId(value: unknown): string | undefined {
  return typeof value === "string" && TOOL_USE_ID.test(value) ? value : undefined;
}

function readToolDigest(value: unknown): string | undefined {
  return typeof value === "string" && TOOL_DIGEST.test(value) ? value : undefined;
}

function readSessionId(value: unknown): string | undefined {
  return typeof value === "string" && SESSION_ID.test(value) ? value : undefined;
}

export function mapHookEvent(event: string, hookEvent?: string): HookSignal | "ignore" {
  if (
    event === "Stop" ||
    event === "stop" ||
    event === "StopFailure" ||
    event === "stop_failure" ||
    event === "StopCancelled" ||
    event === "stop_cancelled"
  ) {
    return "stop";
  }
  if (
    event === "PermissionRequest" ||
    event === "permission-request" ||
    event === "PermissionDenied" ||
    event === "permission_denied"
  ) {
    return "permission-request";
  }
  if (event === "UserPromptSubmit" || event === "user-prompt-submit") {
    return "user-prompt-submit";
  }
  if (event === "SessionStart" || event === "session-start") {
    return "session-start";
  }
  if (event === "PostToolUse" || event === "post-tool-use") {
    return "post-tool-use";
  }
  if (event === "PostToolUseFailure" || event === "post-tool-use-failure") {
    return "post-tool-use-failure";
  }
  if (event === "Notification") {
    const kind = (hookEvent ?? "").toLowerCase();
    if (kind.includes("permission") || kind.includes("elicitation")) {
      return "permission-request";
    }
    return "ignore";
  }
  return "ignore";
}

function allocateAddress(): string {
  const id = randomBytes(9).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ff-pane-wb-${id}`;
  }
  return join(tmpdir(), `ff-pane-wb-${id}.sock`);
}

function responseLine(ok: boolean, error?: string, result?: unknown): string {
  if (ok) {
    return result === undefined
      ? `${JSON.stringify({ v: WB_CONTROL_PROTOCOL_VERSION, ok: true })}\n`
      : `${JSON.stringify({ v: WB_CONTROL_PROTOCOL_VERSION, ok: true, result })}\n`;
  }
  return `${JSON.stringify({ v: WB_CONTROL_PROTOCOL_VERSION, ok: false, error: error ?? "unsupported" })}\n`;
}

export function createWorkbenchControlServer(
  options: WorkbenchControlServerOptions,
): Promise<WorkbenchControlServer> {
  const maxBytes = options.maxRequestBytes ?? DEFAULT_CONTROL_MAX_REQUEST_BYTES;
  const maxPerSecond = options.maxPerSecond ?? DEFAULT_CONTROL_MAX_PER_SECOND;
  const log = (message: string): void => {
    options.log?.(message);
  };
  const address = allocateAddress();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let windowStart = Date.now();
    let count = 0;
    let closed = false;

    const destroy = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      sockets.delete(socket);
      socket.destroy();
    };

    const fail = (error: ControlRejectError, disconnect: boolean): void => {
      log(error);
      if (!socket.destroyed) {
        socket.write(responseLine(false, error));
      }
      if (disconnect) {
        closed = true;
        sockets.delete(socket);
        socket.end();
      }
    };

    socket.on("data", (chunk) => {
      if (closed) {
        return;
      }
      buffer += chunk.toString("utf8");
      if (buffer.length > maxBytes) {
        buffer = "";
        fail("oversize", true);
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") {
          const now = Date.now();
          if (now - windowStart >= 1000) {
            windowStart = now;
            count = 0;
          }
          count += 1;
          if (count > maxPerSecond) {
            fail("rate", true);
            return;
          }
          handleLine(line);
          if (closed) {
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {
      destroy();
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });

    const handleLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("malformed", true);
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("malformed", true);
        return;
      }
      const body = parsed as Record<string, unknown>;
      const token = typeof body["token"] === "string" ? body["token"] : "";
      const windowId = resolveCaller(options.tokens, token);
      if (windowId === null) {
        fail("unauthorized", true);
        return;
      }
      const type = typeof body["type"] === "string" ? body["type"] : "";
      if (type === "hook") {
        const event = typeof body["event"] === "string" ? body["event"] : "";
        const hookEvent = typeof body["hookEvent"] === "string" ? body["hookEvent"] : undefined;
        const toolUseId = readToolUseId(body["toolUseId"]);
        const toolDigest = readToolDigest(body["toolDigest"]);
        const sessionId = readSessionId(body["sessionId"]);
        const releasePermissions = body["releasePermissions"] === true;
        const signal = mapHookEvent(event, hookEvent);
        if (signal !== "ignore") {
          const meta =
            hookEvent !== undefined ||
            toolUseId !== undefined ||
            toolDigest !== undefined ||
            sessionId !== undefined ||
            releasePermissions
              ? {
                  ...(hookEvent !== undefined ? { hookEvent } : {}),
                  ...(toolUseId !== undefined ? { toolUseId } : {}),
                  ...(toolDigest !== undefined ? { toolDigest } : {}),
                  ...(sessionId !== undefined ? { sessionId } : {}),
                  ...(releasePermissions ? { releasePermissions: true } : {}),
                }
              : undefined;
          options.onHook(windowId, signal, meta);
        }
        log("accepted");
        if (!socket.destroyed) {
          socket.write(responseLine(true));
        }
        return;
      }
      if (options.onRequest !== undefined) {
        const decided = options.onRequest({ windowId, type, body });
        if (decided instanceof Promise) {
          void decided
            .then((resolved) => {
              writeDecision(resolved);
            })
            .catch(() => {
              writeDecision({ ok: false, error: "unsupported" });
            });
          return;
        }
        writeDecision(decided);
        return;
      }
      log("unsupported");
      if (!socket.destroyed) {
        socket.write(responseLine(false, "unsupported"));
      }

      function writeDecision(
        resolved:
          | { readonly ok: true; readonly result?: unknown }
          | { readonly ok: false; readonly error: string },
      ): void {
        if (resolved.ok) {
          log("accepted");
          if (!socket.destroyed) {
            socket.write(responseLine(true, undefined, resolved.result));
          }
          return;
        }
        log("unsupported");
        if (!socket.destroyed) {
          socket.write(responseLine(false, "unsupported"));
        }
      }
    };
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(address, () => {
      server.off("error", onError);
      resolve({
        address,
        async close() {
          for (const socket of sockets) {
            socket.destroy();
          }
          sockets.clear();
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
          if (process.platform !== "win32") {
            try {
              unlinkSync(address);
            } catch {
              // 已经不在
            }
          }
        },
      });
    });
  });
}
