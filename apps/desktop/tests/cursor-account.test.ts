import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CursorLoginEvent } from "../src/shared-ipc/contracts";

vi.mock("electron", () => ({ shell: { openExternal: async () => undefined } }));

const {
  createCursorLoginController,
  findCursorLoginUrl,
  isCursorLoginUrl,
  parseCursorAboutJson,
  parseCursorStatusJson,
} = await import("../src/main/cursor-account");

describe("Cursor 账号输出解析（T11.18）", () => {
  it("status --format json：登录状态、邮箱、名字", () => {
    expect(
      parseCursorStatusJson(
        JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          hasAccessToken: true,
          userInfo: { email: "a@b.com", userId: 1, firstName: "Donna", lastName: "Green" },
        }),
      ),
    ).toEqual({ authenticated: true, email: "a@b.com", name: "Donna Green" });
    expect(parseCursorStatusJson('{"status":"unauthenticated","isAuthenticated":false}')).toEqual({
      authenticated: false,
    });
    expect(parseCursorStatusJson("Not logged in")).toBeUndefined();
  });

  it("about --format json：版本、档位、有没有新版", () => {
    expect(
      parseCursorAboutJson(
        JSON.stringify({
          cliVersion: "2026.11.05-86047df",
          latestStatus: "update_available",
          latestVersion: "2026.11.13-eacade1",
          subscriptionTier: "Free",
          userEmail: "a@b.com",
        }),
      ),
    ).toEqual({
      version: "2026.11.05-86047df",
      tier: "Free",
      latestVersion: "2026.11.13-eacade1",
      updateAvailable: true,
      email: "a@b.com",
    });
    expect(parseCursorAboutJson('{"cliVersion":"x","latestStatus":"up_to_date"}')).toEqual({
      version: "x",
      updateAvailable: false,
    });
  });

  it("登录链接：只认 https 的 cursor.com", () => {
    const output =
      "\u001b[2mWaiting for browser authentication...\u001b[0m\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=1-2&mode=login\n";
    expect(findCursorLoginUrl(output)).toBe(
      "https://cursor.com/loginDeepControl?challenge=abc&uuid=1-2&mode=login",
    );
    expect(findCursorLoginUrl("see https://evil.example/cursor.com/login")).toBeUndefined();
    expect(isCursorLoginUrl("https://www.cursor.com/x")).toBe(true);
    expect(isCursorLoginUrl("http://cursor.com/x")).toBe(false);
    expect(isCursorLoginUrl("https://cursor.com.evil.io/x")).toBe(false);
  });
});

function fakeChild(): ChildProcess & { readonly out: PassThrough } {
  const emitter = new EventEmitter() as ChildProcess & { out: PassThrough };
  const out = new PassThrough();
  Object.assign(emitter, { stdout: out, stderr: new PassThrough(), out, kill: vi.fn() });
  return emitter;
}

describe("软件里登录 Cursor（T11.18）", () => {
  it("认出链接发事件，退出码 0 时带上新状态结束", async () => {
    const child = fakeChild();
    const events: CursorLoginEvent[] = [];
    const login = createCursorLoginController({
      spawnLogin: () => child,
      publish: (event) => events.push(event),
      readStatus: async () => ({ installed: true, authenticated: true, email: "a@b.com" }),
    });
    expect(login.start()).toEqual({ ok: true });
    expect(login.start()).toEqual({ ok: false, error: "已经在登录了。" });
    child.out.write("navigate to this link: https://cursor.com/loginDeepControl?x=1\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([{ phase: "url", url: "https://cursor.com/loginDeepControl?x=1" }]);
    expect(login.currentUrl()).toBe("https://cursor.com/loginDeepControl?x=1");
    child.emit("close", 0);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({
      phase: "done",
      ok: true,
      status: { installed: true, authenticated: true, email: "a@b.com" },
    });
    expect(login.running()).toBe(false);
  });

  it("取消：结束进程，发「已取消」；非 0 退出带上输出", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const events: CursorLoginEvent[] = [];
    const login = createCursorLoginController({
      spawnLogin: () => children.shift(),
      publish: (event) => events.push(event),
      readStatus: async () => ({ installed: true }),
    });
    login.start();
    login.cancel();
    expect(first.kill).toHaveBeenCalled();
    first.emit("close", 1);
    expect(events).toEqual([{ phase: "done", ok: false, cancelled: true, error: "" }]);

    login.start();
    second.out.write("Error: network unreachable\n");
    await new Promise((resolve) => setImmediate(resolve));
    second.emit("close", 1);
    expect(events[1]).toEqual({ phase: "done", ok: false, error: "Error: network unreachable" });
  });

  it("没装 CLI 时直接报错；超时停下", async () => {
    const missing = createCursorLoginController({
      spawnLogin: () => undefined,
      publish: () => undefined,
      readStatus: async () => ({ installed: false }),
    });
    expect(missing.start()).toEqual({ ok: false, error: "没找到 Cursor CLI（cursor-agent）。" });

    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const events: CursorLoginEvent[] = [];
      const login = createCursorLoginController({
        spawnLogin: () => child,
        publish: (event) => events.push(event),
        readStatus: async () => ({ installed: true }),
        timeoutMs: 1000,
      });
      login.start();
      vi.advanceTimersByTime(1000);
      expect(child.kill).toHaveBeenCalled();
      expect(events).toEqual([
        { phase: "done", ok: false, error: "等了 10 分钟还没在浏览器里登录完，已停下。" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
