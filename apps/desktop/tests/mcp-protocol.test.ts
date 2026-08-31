/**
 * MCP 协议层单测（T6.6）：纯逻辑，不起进程、不碰 SQLite。
 * 覆盖：版本协商三态、通知不回包、未知方法/坏参数、工具抛错走 isError 而非协议错误、
 * 解析失败回 id:null、只读工具面（tools/list 只有一个且没有任何写工具）。
 */

import { describe, expect, it, vi } from "vitest";
import {
  handleMcpLine,
  handleMcpMessage,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcResponse,
  type McpServerOptions,
  PREFERRED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/mcp/protocol";

const TOOL = {
  name: "knowledge_search",
  description: "search",
  inputSchema: { type: "object", properties: {}, required: [] },
};

/**
 * 断言"这一条必须回包"并取出 result。
 * 不用可选链：null 在这些用例里是失败而不是"跳过断言"，被可选链吞掉就等于测试失效。
 */
function resultOf<T>(response: JsonRpcResponse | null): T {
  if (response === null) {
    throw new Error("期望有响应，实际没有回包");
  }
  return response.result as T;
}

function makeOptions(overrides: Partial<McpServerOptions> = {}): McpServerOptions {
  return {
    name: "knowledge_search",
    version: "1.0.0",
    tools: [TOOL],
    execute: async () => ({ text: "ok" }),
    ...overrides,
  };
}

describe("initialize 版本协商", () => {
  it("客户端报的版本我们认识 → 原样回它", async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const response = await handleMcpMessage(
        { id: 1, method: "initialize", params: { protocolVersion: version } },
        makeOptions(),
      );
      expect(resultOf<{ protocolVersion: string }>(response).protocolVersion).toBe(version);
    }
  });

  it("客户端报了不认识的版本 → 回我们最新的，由客户端决定谈不谈", async () => {
    const response = await handleMcpMessage(
      { id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      makeOptions(),
    );
    expect(resultOf<{ protocolVersion: string }>(response).protocolVersion).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });

  it("客户端没报版本 → 回缺省版本", async () => {
    const response = await handleMcpMessage({ id: 1, method: "initialize" }, makeOptions());
    expect(resultOf<{ protocolVersion: string }>(response).protocolVersion).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });

  it("只声明 tools 能力（没有 resources/prompts，声明了就是撒谎）", async () => {
    const response = await handleMcpMessage({ id: 1, method: "initialize" }, makeOptions());
    const result = resultOf<{ capabilities: Record<string, unknown> }>(response);
    expect(Object.keys(result.capabilities)).toEqual(["tools"]);
  });
});

describe("通知（无 id）不回包", () => {
  it("notifications/initialized 不回包——回了反而是协议错误", async () => {
    expect(
      await handleMcpMessage({ method: "notifications/initialized" }, makeOptions()),
    ).toBeNull();
  });

  it("未知方法的通知同样不回包", async () => {
    expect(await handleMcpMessage({ method: "notifications/whatever" }, makeOptions())).toBeNull();
  });

  it("id 为 null 是请求而非通知（JSON-RPC 语义），照常回包", async () => {
    const response = await handleMcpMessage({ id: null, method: "ping" }, makeOptions());
    expect(response).toEqual({ jsonrpc: "2.0", id: null, result: {} });
  });
});

describe("tools/list", () => {
  it("只暴露一个只读检索工具，没有任何写工具", async () => {
    const response = await handleMcpMessage({ id: 2, method: "tools/list" }, makeOptions());
    const { tools } = resultOf<{ tools: { name: string }[] }>(response);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("knowledge_search");
    // 写操作物理不存在：没有任何以增删改语义命名的工具（§8.3.5）
    const names = tools.map((tool) => tool.name).join(" ");
    for (const forbidden of ["add", "create", "update", "delete", "remove", "write", "import"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("tools/call", () => {
  it("正常调用返回 text content", async () => {
    const execute = vi.fn(async () => ({ text: "命中 3 条" }));
    const response = await handleMcpMessage(
      {
        id: 3,
        method: "tools/call",
        params: { name: "knowledge_search", arguments: { query: "a" } },
      },
      makeOptions({ execute }),
    );
    expect(execute).toHaveBeenCalledWith("knowledge_search", { query: "a" });
    expect(response?.result).toEqual({ content: [{ type: "text", text: "命中 3 条" }] });
  });

  it("arguments 缺省时按空表传入（不报错）", async () => {
    const execute = vi.fn(async () => ({ text: "" }));
    await handleMcpMessage(
      { id: 3, method: "tools/call", params: { name: "knowledge_search" } },
      makeOptions({ execute }),
    );
    expect(execute).toHaveBeenCalledWith("knowledge_search", {});
  });

  it("工具执行抛错 → isError 结果而非协议错误（模型要看得见原因）", async () => {
    const response = await handleMcpMessage(
      { id: 4, method: "tools/call", params: { name: "knowledge_search", arguments: {} } },
      makeOptions({
        execute: async () => {
          throw new Error("库被锁住了");
        },
      }),
    );
    expect(response?.error).toBeUndefined();
    const result = resultOf<{ isError?: boolean; content: { text: string }[] }>(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("库被锁住了");
  });

  it("工具自报 isError 同样透传", async () => {
    const response = await handleMcpMessage(
      { id: 4, method: "tools/call", params: { name: "knowledge_search", arguments: {} } },
      makeOptions({ execute: async () => ({ text: "query 必填", isError: true }) }),
    );
    expect(resultOf<{ isError?: boolean }>(response).isError).toBe(true);
  });

  it("未知工具名 → invalid params（这是协议层错误，不该进工具执行）", async () => {
    const execute = vi.fn(async () => ({ text: "" }));
    const response = await handleMcpMessage(
      { id: 5, method: "tools/call", params: { name: "knowledge_delete" } },
      makeOptions({ execute }),
    );
    expect(response?.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect(execute).not.toHaveBeenCalled();
  });

  it("缺 name → invalid params", async () => {
    const response = await handleMcpMessage(
      { id: 5, method: "tools/call", params: {} },
      makeOptions(),
    );
    expect(response?.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });
});

describe("错误分支", () => {
  it("未知方法 → method not found", async () => {
    const response = await handleMcpMessage({ id: 6, method: "resources/list" }, makeOptions());
    expect(response?.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it("缺 method 的请求 → invalid request", async () => {
    const response = await handleMcpMessage({ id: 7 }, makeOptions());
    expect(response?.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });
});

describe("handleMcpLine", () => {
  it("空行忽略（换行心跳不该被当成解析错误刷屏）", async () => {
    expect(await handleMcpLine("   ", makeOptions())).toBeNull();
    expect(await handleMcpLine("", makeOptions())).toBeNull();
  });

  it("坏 JSON → parse error，且按规定回 id:null", async () => {
    const response = await handleMcpLine("{ 坏掉", makeOptions());
    expect(response?.error?.code).toBe(JSON_RPC_PARSE_ERROR);
    expect(response?.id).toBeNull();
  });

  it("合法 JSON 但不是对象 → invalid request", async () => {
    const response = await handleMcpLine("[1,2,3]", makeOptions());
    expect(response?.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  it("整行往返：ping", async () => {
    const response = await handleMcpLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
      makeOptions(),
    );
    expect(response).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });
});
