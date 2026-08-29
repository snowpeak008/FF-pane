import { describe, expect, it } from "vitest";
import { createIpcClient, type IpcRendererLike } from "../src/shared-ipc/client";
import { IpcInvokeError } from "../src/shared-ipc/envelope";
import {
  type IpcMainLike,
  publishEvent,
  registerInvokeHandlers,
  type WebContentsLike,
} from "../src/shared-ipc/server";

type WireHandler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;
type WireListener = (...args: unknown[]) => void;

/** 用内存假线路把 server 装配与 client 工厂端到端接起来（不依赖 Electron）。 */
function createFakeWire(): {
  ipcMain: IpcMainLike;
  ipcRenderer: IpcRendererLike;
  webContents: WebContentsLike;
} {
  const invokeHandlers = new Map<string, WireHandler>();
  const eventListeners = new Map<string, Set<WireListener>>();

  const ipcMain: IpcMainLike = {
    handle(channel, handler) {
      invokeHandlers.set(channel, handler);
    },
  };

  const ipcRenderer: IpcRendererLike = {
    async invoke(channel, ...args) {
      const handler = invokeHandlers.get(channel);
      if (handler === undefined) {
        throw new Error(`未注册的通道：${channel}`);
      }
      return handler({ fakeEvent: true }, ...args);
    },
    on(channel, listener) {
      const listeners = eventListeners.get(channel) ?? new Set<WireListener>();
      listeners.add(listener);
      eventListeners.set(channel, listeners);
    },
    removeListener(channel, listener) {
      eventListeners.get(channel)?.delete(listener);
    },
  };

  const webContents: WebContentsLike = {
    send(channel, ...args) {
      for (const listener of eventListeners.get(channel) ?? []) {
        listener({ fakeEvent: true }, ...args);
      }
    },
  };

  return { ipcMain, ipcRenderer, webContents };
}

describe("IPC 客户端/服务端端到端（假线路）", () => {
  it("invoke 请求/响应往返：ping-pong 保持完整类型与数据", async () => {
    const { ipcMain, ipcRenderer } = createFakeWire();
    registerInvokeHandlers(ipcMain, {
      "app:ping": (request) => ({
        reply: "pong" as const,
        echoed: request.message,
        repliedAt: 12345,
      }),
    });

    const client = createIpcClient(ipcRenderer);
    const response = await client.invoke("app:ping", { message: "ping", sentAt: 1 });
    expect(response).toEqual({ reply: "pong", echoed: "ping", repliedAt: 12345 });
  });

  it("无请求体的通道可以不传参数", async () => {
    const { ipcMain, ipcRenderer } = createFakeWire();
    registerInvokeHandlers(ipcMain, {
      "app:get-info": () => ({
        name: "FF-pane",
        version: "0.1.0",
        runtime: { electron: "e", chrome: "c", node: "n" },
      }),
    });

    const client = createIpcClient(ipcRenderer);
    const info = await client.invoke("app:get-info");
    expect(info.name).toBe("FF-pane");
    expect(info.runtime.electron).toBe("e");
  });

  it("handler 抛错被包装为信封，客户端还原为 IpcInvokeError", async () => {
    const { ipcMain, ipcRenderer } = createFakeWire();
    registerInvokeHandlers(ipcMain, {
      "diagnostics:check-sqlite": () => {
        throw new Error("原生模块加载失败");
      },
    });

    const client = createIpcClient(ipcRenderer);
    const failure = client.invoke("diagnostics:check-sqlite");
    await expect(failure).rejects.toBeInstanceOf(IpcInvokeError);
    await expect(failure).rejects.toMatchObject({
      channel: "diagnostics:check-sqlite",
      remoteName: "Error",
    });
  });

  it("契约之外的 invoke 通道被客户端直接拦截（不触达传输层）", async () => {
    const { ipcRenderer } = createFakeWire();
    const client = createIpcClient(ipcRenderer);
    await expect(client.invoke("evil:channel" as never)).rejects.toThrowError(/未在契约中登记/);
  });

  it("契约之外的事件通道无法订阅", () => {
    const { ipcRenderer } = createFakeWire();
    const client = createIpcClient(ipcRenderer);
    expect(() => client.subscribe("evil:event" as never, () => undefined)).toThrowError(
      /未在契约中登记/,
    );
  });

  it("事件订阅收到推送载荷，取消订阅后不再接收", () => {
    const { ipcMain, ipcRenderer, webContents } = createFakeWire();
    registerInvokeHandlers(ipcMain, {
      "smoke:emit-event": (request) => {
        publishEvent(webContents, "smoke:event", { seq: request.seq, emittedAt: 99 });
        return { emitted: true as const };
      },
    });

    const client = createIpcClient(ipcRenderer);
    const received: number[] = [];
    const unsubscribe = client.subscribe("smoke:event", (payload) => {
      received.push(payload.seq);
    });

    publishEvent(webContents, "smoke:event", { seq: 1, emittedAt: 1 });
    publishEvent(webContents, "smoke:event", { seq: 2, emittedAt: 2 });
    expect(received).toEqual([1, 2]);

    unsubscribe();
    publishEvent(webContents, "smoke:event", { seq: 3, emittedAt: 3 });
    expect(received).toEqual([1, 2]);
  });

  it("registerInvokeHandlers 拒绝不符合命名规范的通道", () => {
    const { ipcMain } = createFakeWire();
    const illegalHandlers = { BadChannel: () => undefined } as never;
    expect(() => registerInvokeHandlers(ipcMain, illegalHandlers)).toThrowError(
      /不符合 <域>:<动作> 规范/,
    );
  });
});
