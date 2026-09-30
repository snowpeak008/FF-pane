/**
 * T10.6'：控制通道。合法令牌通过，非法/吊销拒绝，超大拒绝，日志不含令牌。
 */

import net from "node:net";
import { createWindowTokenRegistry } from "@ff-pane/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkbenchControlServer,
  type WorkbenchControlServer,
} from "../src/main/workbench/control-channel";
import type { HookSignal } from "../src/main/workbench/idle-deliver";
import { sendHookReport } from "../src/mcp/workbench-hook";

const open: WorkbenchControlServer[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const server = open.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
});

function start(options?: {
  readonly maxRequestBytes?: number;
  readonly maxPerSecond?: number;
  readonly onRequest?: Parameters<typeof createWorkbenchControlServer>[0]["onRequest"];
}): Promise<{
  readonly server: WorkbenchControlServer;
  readonly logs: string[];
  readonly hooks: { windowId: string; signal: HookSignal }[];
  readonly registry: ReturnType<typeof createWindowTokenRegistry>;
}> {
  const registry = createWindowTokenRegistry();
  const logs: string[] = [];
  const hooks: { windowId: string; signal: HookSignal }[] = [];
  return createWorkbenchControlServer({
    tokens: registry,
    onHook: (windowId, signal) => {
      hooks.push({ windowId, signal });
    },
    log: (message) => {
      logs.push(message);
    },
    ...(options?.onRequest !== undefined ? { onRequest: options.onRequest } : {}),
    ...(options?.maxRequestBytes !== undefined ? { maxRequestBytes: options.maxRequestBytes } : {}),
    ...(options?.maxPerSecond !== undefined ? { maxPerSecond: options.maxPerSecond } : {}),
  }).then((server) => {
    open.push(server);
    return { server, logs, hooks, registry };
  });
}

function exchange(address: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("exchange timed out"));
    }, 2_000);
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.end(payload);
  });
}

describe("workbench control channel", () => {
  it("地址是命名管道或 Unix socket，不是 TCP", async () => {
    const { server } = await start();
    if (process.platform === "win32") {
      expect(server.address).toMatch(/^\\\\\.\\pipe\\ff-pane-wb-[0-9a-f]+$/);
    } else {
      expect(server.address).toMatch(/ff-pane-wb-[0-9a-f]+\.sock$/);
    }
    expect(server.address).not.toMatch(/:\d+$/);
    expect(server.address.toLowerCase()).not.toContain("http");
  });

  it("合法令牌通过，非法与已吊销令牌拒绝并断开", async () => {
    const { server, hooks, registry, logs } = await start();
    const token = registry.issue("win-1");
    const ok = await exchange(
      server.address,
      `${JSON.stringify({ v: 1, type: "hook", token, event: "Stop" })}\n`,
    );
    expect(JSON.parse(ok)).toEqual({ v: 1, ok: true });
    expect(hooks).toEqual([{ windowId: "win-1", signal: "stop" }]);

    const denied = await exchange(
      server.address,
      `${JSON.stringify({ v: 1, type: "hook", token: "not-a-token", event: "Stop" })}\n`,
    );
    expect(JSON.parse(denied)).toEqual({ v: 1, ok: false, error: "unauthorized" });
    expect(hooks).toHaveLength(1);

    registry.revoke("win-1");
    const revoked = await exchange(
      server.address,
      `${JSON.stringify({ v: 1, type: "hook", token, event: "Stop" })}\n`,
    );
    expect(JSON.parse(revoked)).toEqual({ v: 1, ok: false, error: "unauthorized" });
    expect(hooks).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(token);
    expect(denied).not.toContain(token);
    expect(revoked).not.toContain(token);
  });

  it("超大请求拒绝且不把令牌写进日志", async () => {
    const { server, hooks, registry, logs } = await start({ maxRequestBytes: 64 });
    const token = registry.issue("win-1");
    const huge = `${token}${"x".repeat(200)}`;
    const raw = await exchange(server.address, huge);
    expect(raw).toContain("oversize");
    expect(hooks).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(token);
    expect(raw).not.toContain(token);
  });

  it("hook 脚本客户端能上报，日志与响应都不含令牌", async () => {
    const { server, hooks, registry, logs } = await start();
    const token = registry.issue("win-9");
    await sendHookReport(server.address, token, "PermissionRequest");
    expect(hooks).toEqual([{ windowId: "win-9", signal: "permission-request" }]);
    expect(logs.join("\n")).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("超过每秒条数上限则拒绝并断开", async () => {
    const { server, hooks, registry } = await start({ maxPerSecond: 2 });
    const token = registry.issue("win-1");
    const line = `${JSON.stringify({ v: 1, type: "hook", token, event: "Stop" })}\n`;
    const raw = await exchange(server.address, `${line}${line}${line}`);
    expect(raw).toContain('"error":"rate"');
    expect(hooks.length).toBeLessThanOrEqual(2);
    expect(raw).not.toContain(token);
  });

  it("未注册的请求类型可交给 onRequest，供 T10.7 扩展", async () => {
    const seen: string[] = [];
    const { server, registry, logs } = await start({
      onRequest: (context) => {
        seen.push(`${context.windowId}:${context.type}`);
        return { ok: true, result: { accepted: context.type } };
      },
    });
    const token = registry.issue("win-2");
    const raw = await exchange(
      server.address,
      `${JSON.stringify({ v: 1, type: "tool", token, name: "ffpane_read_inbox" })}\n`,
    );
    expect(JSON.parse(raw)).toEqual({ v: 1, ok: true, result: { accepted: "tool" } });
    expect(seen).toEqual(["win-2:tool"]);
    expect(raw).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });
});
