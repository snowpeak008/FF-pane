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
 * {"v":1,"type":"<T10.7 扩展>","token":"..."}
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
    meta?: { readonly hookEvent?: string },
  ) => void;
  /**
   * T10.7：hook 以外的请求类型。未提供或返回 unsupported 时拒绝该条，不断开
   * （令牌已经核验过）。返回 ok 则把 result 放进响应。
   */
  readonly onRequest?: (
    context: WorkbenchControlRequestContext,
  ) =>
    | { readonly ok: true; readonly result?: unknown }
    | { readonly ok: false; readonly error: string };
  /** 只接收固定短句。实现不得把请求正文或令牌传进来。 */
  readonly log?: (message: string) => void;
  readonly maxRequestBytes?: number;
  readonly maxPerSecond?: number;
}

export interface WorkbenchControlServer {
  readonly address: string;
  close(): Promise<void>;
}

export function mapHookEvent(event: string, hookEvent?: string): HookSignal | "ignore" {
  if (event === "Stop" || event === "stop") {
    return "stop";
  }
  if (event === "PermissionRequest" || event === "permission-request") {
    return "permission-request";
  }
  if (event === "UserPromptSubmit" || event === "user-prompt-submit") {
    return "user-prompt-submit";
  }
  if (event === "SessionStart" || event === "session-start") {
    return "session-start";
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
        const signal = mapHookEvent(event, hookEvent);
        if (signal !== "ignore") {
          options.onHook(windowId, signal, hookEvent !== undefined ? { hookEvent } : undefined);
        }
        log("accepted");
        if (!socket.destroyed) {
          socket.write(responseLine(true));
        }
        return;
      }
      if (options.onRequest !== undefined) {
        const decided = options.onRequest({ windowId, type, body });
        if (decided.ok) {
          log("accepted");
          if (!socket.destroyed) {
            socket.write(responseLine(true, undefined, decided.result));
          }
          return;
        }
        log("unsupported");
        if (!socket.destroyed) {
          socket.write(responseLine(false, "unsupported"));
        }
        return;
      }
      log("unsupported");
      if (!socket.destroyed) {
        socket.write(responseLine(false, "unsupported"));
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
