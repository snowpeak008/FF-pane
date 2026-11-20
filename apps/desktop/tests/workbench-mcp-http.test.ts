/**
 * T11.19 第二部分：工作台 MCP 改成主进程里共用一个 HTTP 服务。
 * 鉴权、Host / Origin、协议、长调用保活、每种运行时的接法和生成的配置。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createWindowTokenRegistry } from "@ff-pane/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PtyManager } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { releaseWindowHooks } from "../src/main/workbench/hook-launch";
import { launchCliWindow } from "../src/main/workbench/launch-cli";
import {
  createWorkbenchMcpHttpServer,
  keepaliveFrames,
  MCP_HTTP_UNAUTHORIZED_TEXT,
  progressTokenOf,
  screenMcpHttpRequest,
} from "../src/main/workbench/mcp-http";
import {
  buildWorkbenchClaudeHttpEntry,
  buildWorkbenchCodexHttpOverrides,
} from "../src/main/workbench/mcp-server-spec";
import {
  WorkbenchMcpTempRegistry,
  writeWorkbenchClaudeMcpFile,
} from "../src/main/workbench/mcp-temp";
import {
  WORKBENCH_MCP_TRANSPORT_BY_RUNTIME,
  workbenchMcpTransportFor,
} from "../src/main/workbench/mcp-transport";
import type { LaunchCliRoute } from "../src/main/workbench/resolve-config";
import type { McpToolResult } from "../src/mcp/protocol";
import { workbenchToolCallTimeoutMs } from "../src/mcp/workbench-server";
import { WORKBENCH_MCP_TOOLS } from "../src/mcp/workbench-tools";

describe("screenMcpHttpRequest", () => {
  const resolve = (token: string): string | null => (token === "good" ? "win-1" : null);
  const base = {
    method: "POST",
    path: "/mcp",
    host: "127.0.0.1:4100",
    origin: undefined,
    authorization: "Bearer good",
  };

  it("令牌对、Host 对：放行并认出窗口", () => {
    expect(screenMcpHttpRequest(base, 4100, resolve)).toEqual({ ok: true, windowId: "win-1" });
    expect(screenMcpHttpRequest({ ...base, host: "localhost:4100" }, 4100, resolve).ok).toBe(true);
  });

  it("没令牌、令牌错、作废了：401", () => {
    for (const authorization of [undefined, "", "Bearer bad", "Basic good", "Bearer"]) {
      const screen = screenMcpHttpRequest({ ...base, authorization }, 4100, resolve);
      expect(screen).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("Host 不是本机这个端口、带了 Origin：403（防 DNS 重绑定）", () => {
    for (const host of [undefined, "evil.example:4100", "127.0.0.1:4101", "127.0.0.1"]) {
      expect(screenMcpHttpRequest({ ...base, host }, 4100, resolve)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    expect(
      screenMcpHttpRequest({ ...base, origin: "http://evil.example" }, 4100, resolve),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("别的路径 404；GET / DELETE 405", () => {
    expect(screenMcpHttpRequest({ ...base, path: "/other" }, 4100, resolve)).toMatchObject({
      status: 404,
    });
    expect(screenMcpHttpRequest({ ...base, method: "GET" }, 4100, resolve)).toMatchObject({
      status: 405,
    });
    expect(screenMcpHttpRequest({ ...base, method: "DELETE" }, 4100, resolve)).toMatchObject({
      status: 405,
    });
  });
});

describe("保活", () => {
  it("每次一行注释；带 progressToken 时再加一条进度通知，progress 逐次加一", () => {
    expect(keepaliveFrames(1, undefined)).toBe(": keepalive 1\n\n");
    const frames = keepaliveFrames(3, "tok-7");
    expect(frames.startsWith(": keepalive 3\n\n")).toBe(true);
    const data = frames.split("data: ")[1]?.trim() ?? "";
    expect(JSON.parse(data)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "tok-7", progress: 3 },
    });
  });

  it("progressToken 只认字符串或数字", () => {
    const call = (meta: unknown) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "x", _meta: meta },
    });
    expect(progressTokenOf(call({ progressToken: 2 }))).toBe(2);
    expect(progressTokenOf(call({ progressToken: "a" }))).toBe("a");
    expect(progressTokenOf(call({ progressToken: {} }))).toBeUndefined();
    expect(progressTokenOf(call(undefined))).toBeUndefined();
  });

  it("长调用的超时照 stdio 小进程：等事件按等待时长 + 20 秒，重启类 90 秒，其余 20 秒", () => {
    expect(workbenchToolCallTimeoutMs("ffpane_wait_events", { timeoutSec: 540 })).toBe(560_000);
    expect(workbenchToolCallTimeoutMs("ffpane_restart_window", {})).toBe(90_000);
    expect(workbenchToolCallTimeoutMs("ffpane_whoami", {})).toBe(20_000);
  });
});

describe("接法表", () => {
  it("默认 Claude、Codex 走 HTTP，Grok、Cursor 走小进程", () => {
    expect(WORKBENCH_MCP_TRANSPORT_BY_RUNTIME).toEqual({
      "claude-code": "http",
      codex: "http",
      grok: "stdio",
      cursor: "stdio",
    });
    expect(workbenchMcpTransportFor("claude-code", {})).toBe("http");
    expect(workbenchMcpTransportFor("codex", {})).toBe("http");
    expect(workbenchMcpTransportFor("grok", {})).toBe("stdio");
    expect(workbenchMcpTransportFor("cursor", {})).toBe("stdio");
  });

  it("FF_PANE_MCP_TRANSPORT=stdio 全部退回小进程", () => {
    for (const runtime of ["claude-code", "codex", "grok", "cursor"] as const) {
      expect(workbenchMcpTransportFor(runtime, { FF_PANE_MCP_TRANSPORT: "stdio" })).toBe("stdio");
    }
  });
});

describe("生成的配置", () => {
  it("Claude：type http、令牌只写占位符、timeout 600 秒", () => {
    expect(buildWorkbenchClaudeHttpEntry("http://127.0.0.1:5000/mcp")).toEqual({
      type: "http",
      url: "http://127.0.0.1:5000/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 就是要写字面量占位符，由 Claude 展开
      headers: { Authorization: "Bearer ${FF_PANE_WINDOW_TOKEN}" },
      timeout: 600_000,
    });
  });

  it("Codex：-c 只有地址、环境变量名和 600 秒", () => {
    expect(buildWorkbenchCodexHttpOverrides("http://127.0.0.1:5000/mcp")).toEqual({
      "mcp_servers.ffpane-workbench.url": '"http://127.0.0.1:5000/mcp"',
      "mcp_servers.ffpane-workbench.bearer_token_env_var": '"FF_PANE_WINDOW_TOKEN"',
      "mcp_servers.ffpane-workbench.tool_timeout_sec": "600",
    });
  });

  it("Claude 临时文件：stdio 条目照旧，HTTP 条目并进去", async () => {
    const file = writeWorkbenchClaudeMcpFile(
      { "ffpane-knowledge": { command: "node", args: ["k.js"] } },
      { httpServers: { "ffpane-workbench": buildWorkbenchClaudeHttpEntry("http://x/mcp") } },
    );
    try {
      const body = JSON.parse(readFileSync(file.path, "utf8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(body.mcpServers["ffpane-knowledge"]).toMatchObject({ type: "stdio", command: "node" });
      expect(body.mcpServers["ffpane-workbench"]).toMatchObject({
        type: "http",
        url: "http://x/mcp",
      });
    } finally {
      await file.remove();
    }
  });
});

describe("HTTP 服务", () => {
  const tokens = createWindowTokenRegistry();
  const token = tokens.issue("win-http");
  let server: Awaited<ReturnType<typeof createWorkbenchMcpHttpServer>>;
  const calls: { windowId: string; name: string }[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    server = await createWorkbenchMcpHttpServer({
      tokens,
      name: "ffpane-workbench",
      version: "1.0.0",
      tools: WORKBENCH_MCP_TOOLS,
      keepaliveMs: 25,
      log: (message) => logs.push(message),
      execute: async (windowId, name): Promise<McpToolResult> => {
        calls.push({ windowId, name });
        if (name === "ffpane_wait_events") {
          await new Promise((resolve) => setTimeout(resolve, 140));
          return { text: "events" };
        }
        return { text: `hi ${windowId}` };
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it("只听本机回环，地址带随机端口", () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    expect(server.port).toBeGreaterThan(0);
  });

  it("initialize、tools/list 回 JSON，不开会话", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(
      ((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe("2025-06-18");
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain("ffpane_wait_events");
  });

  it("不认识的方法（Claude、Grok 先发的 server/discover）回 -32601", async () => {
    const response = await post({ jsonrpc: "2.0", id: 3, method: "server/discover" });
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("通知回 202，不带正文", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("tools/call 只收 JSON 的客户端：回 JSON，按令牌认出窗口", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ffpane_whoami", arguments: {} },
      },
      { Accept: "application/json" },
    );
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]?.text).toBe("hi win-http");
    expect(calls.at(-1)).toEqual({ windowId: "win-http", name: "ffpane_whoami" });
  });

  it("长调用回 SSE：期间每次一行注释加一条进度通知，最后是结果", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "ffpane_wait_events",
        arguments: { timeoutSec: 30 },
        _meta: { progressToken: 5 },
      },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const comments = text.match(/^: keepalive \d+$/gm) ?? [];
    expect(comments.length).toBeGreaterThanOrEqual(2);
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const progress = events.filter((event) => event["method"] === "notifications/progress");
    expect(progress.length).toBe(comments.length);
    expect(progress.map((event) => (event["params"] as { progress: number }).progress)).toEqual(
      progress.map((_event, index) => index + 1),
    );
    const final = events.at(-1) as { id: number; result: { content: { text: string }[] } };
    expect(final.id).toBe(5);
    expect(final.result.content[0]?.text).toBe("events");
  });

  it("没带 progressToken：只发注释", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "ffpane_wait_events", arguments: { timeoutSec: 30 } },
    });
    const text = await response.text();
    expect(text).toMatch(/^: keepalive 1$/m);
    expect(text).not.toContain("notifications/progress");
  });

  it("令牌作废后回 401，文字叫它重启窗口；工具不执行", async () => {
    const other = tokens.issue("win-gone");
    tokens.revoke("win-gone");
    const before = calls.length;
    const response = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ffpane_whoami" } },
      { Authorization: `Bearer ${other}` },
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      MCP_HTTP_UNAUTHORIZED_TEXT,
    );
    expect(calls.length).toBe(before);
    expect(logs).toContain("unauthorized");
    expect(logs.join("\n")).not.toContain(other);
  });

  it("带 Origin 的拒绝；GET 405", async () => {
    const withOrigin = await post(
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      {
        Origin: "http://evil.example",
      },
    );
    expect(withOrigin.status).toBe(403);
    const get = await fetch(server.url, { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });

  it("坏 JSON 回 400", async () => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(response.status).toBe(400);
  });
});

describe("开窗时的接法", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "ffpane-mcp-http-launch-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-mcp-http-proj-"));
  let restorePath: () => void = () => undefined;

  const writeShim = (name: string): void => {
    const bin = join(fakeBin, "node_modules", name, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, `${name}.js`), "process.exit(0)\n", "utf8");
    writeFileSync(
      join(fakeBin, `${name}.cmd`),
      [
        "@ECHO off",
        "SETLOCAL",
        "CALL :find_dp0",
        `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
        `endLocal & "%_prog%"  "%dp0%\\node_modules\\${name}\\bin\\${name}.js" %*`,
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        "",
      ].join("\r\n"),
      "utf8",
    );
  };

  beforeAll(() => {
    writeShim("claude");
    writeShim("codex");
    const key = Object.keys(process.env).find((item) => item.toUpperCase() === "PATH") ?? "PATH";
    const previous = process.env[key];
    process.env[key] = previous === undefined ? fakeBin : `${fakeBin}${delimiter}${previous}`;
    restorePath = () => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    };
  });

  afterAll(() => {
    restorePath();
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const route: LaunchCliRoute = {
    connectionMode: "local_cli",
    configId: "cfg" as LaunchCliRoute["configId"],
    configName: "默认配置",
    model: "sonnet",
  };

  const launch = async (kind: "claude" | "codex", windowId: string, url?: string) => {
    const captured: { env: Record<string, string>; args: string[] }[] = [];
    const manager = {
      aliveCount: () => 0,
      create: (input: { env: Record<string, string>; direct: { args: readonly string[] } }) => {
        captured.push({ env: { ...input.env }, args: [...input.direct.args] });
        return { id: `term-${windowId}` };
      },
    } as unknown as PtyManager;
    const mcpRegistry = new WorkbenchMcpTempRegistry();
    await launchCliWindow(
      {
        windowId,
        projectId: "proj" as never,
        projectRoot,
        kind,
        route,
        cols: 80,
        rows: 24,
        role: "worker",
        permission: "edit",
      },
      {
        manager,
        getProvider: async () => undefined,
        revealSecret: async () => undefined,
        getMaxWorkbenchWindows: async () => 8,
        isKnowledgeToolEnabled: async () => false,
        getKnowledgeToolSettings: async () => undefined,
        indexDbFile: join(projectRoot, "index.db"),
        moduleDir: join(fakeBin, "out-main"),
        mcpRegistry,
        clampMax: (value: unknown) => (typeof value === "number" ? value : 8),
        limitErrorPrefix: "limit",
        tokenRegistry: createWindowTokenRegistry(),
        authRegistry: createWorkbenchAuthRegistry(),
        controlPipe: "\\\\.\\pipe\\ff-pane-wb-http-test",
        ...(url !== undefined ? { workbenchMcpUrl: url } : {}),
      },
    );
    releaseWindowHooks(windowId);
    const first = captured[0];
    if (first === undefined) {
      throw new Error("not launched");
    }
    return { ...first, release: () => mcpRegistry.release(windowId) };
  };

  const claudeMcp = (args: readonly string[]) => {
    const path = args[args.indexOf("--mcp-config") + 1] ?? "";
    return JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
  };

  it("Claude：工作台条目是 HTTP，不开小进程；令牌只在进程环境，文件里没有", async () => {
    const run = await launch("claude", "win-claude-http", "http://127.0.0.1:5123/mcp");
    try {
      const entry = claudeMcp(run.args).mcpServers["ffpane-workbench"];
      expect(entry).toEqual(buildWorkbenchClaudeHttpEntry("http://127.0.0.1:5123/mcp"));
      const token = run.env["FF_PANE_WINDOW_TOKEN"] ?? "";
      expect(token.length).toBeGreaterThan(10);
      const path = run.args[run.args.indexOf("--mcp-config") + 1] ?? "";
      expect(readFileSync(path, "utf8")).not.toContain(token);
      expect(run.args).toContain("--strict-mcp-config");
      expect(run.args.join("\n")).not.toContain(token);
    } finally {
      await run.release();
    }
  });

  it("Codex：-c 给地址和环境变量名，没有小进程的 command", async () => {
    const run = await launch("codex", "win-codex-http", "http://127.0.0.1:5123/mcp");
    const joined = run.args.join("\n");
    expect(joined).toContain('mcp_servers.ffpane-workbench.url="http://127.0.0.1:5123/mcp"');
    expect(joined).toContain(
      'mcp_servers.ffpane-workbench.bearer_token_env_var="FF_PANE_WINDOW_TOKEN"',
    );
    expect(joined).toContain("mcp_servers.ffpane-workbench.tool_timeout_sec=600");
    expect(joined).not.toContain("mcp_servers.ffpane-workbench.command");
    expect(joined).not.toContain(run.env["FF_PANE_WINDOW_TOKEN"] ?? "<none>");
  });

  it("服务没起来（没有地址）或 FF_PANE_MCP_TRANSPORT=stdio：照旧开小进程", async () => {
    const noUrl = await launch("claude", "win-claude-nourl");
    try {
      expect(claudeMcp(noUrl.args).mcpServers["ffpane-workbench"]).toMatchObject({ type: "stdio" });
    } finally {
      await noUrl.release();
    }
    process.env["FF_PANE_MCP_TRANSPORT"] = "stdio";
    try {
      const forced = await launch("claude", "win-claude-forced", "http://127.0.0.1:5123/mcp");
      try {
        expect(claudeMcp(forced.args).mcpServers["ffpane-workbench"]).toMatchObject({
          type: "stdio",
        });
      } finally {
        await forced.release();
      }
      const codex = await launch("codex", "win-codex-forced", "http://127.0.0.1:5123/mcp");
      expect(codex.args.join("\n")).toContain("mcp_servers.ffpane-workbench.command");
      expect(codex.args.join("\n")).not.toContain("mcp_servers.ffpane-workbench.url");
    } finally {
      delete process.env["FF_PANE_MCP_TRANSPORT"];
    }
  });
});
