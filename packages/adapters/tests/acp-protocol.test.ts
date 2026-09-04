/**
 * T8.5a ACP 协议层单测（一）：JSON-RPC 信封（编解码往返 / 单行分类 / 畸形输入）
 * 与入站载荷的宽容解析（parse.ts）。分帧边界（半包/粘包/超长）在
 * acp-connection.test.ts 经假流驱动覆盖——行切分复用 events/jsonl.ts 的行解码器，
 * 其自身边界另有 events.test.ts 钉住，此处只验"ACP 消息经该管道往返不失真"。
 */

import { describe, expect, it } from "vitest";
import {
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  ACP_SESSION_UPDATE_TYPES,
  ACP_STOP_REASONS,
  buildAcpError,
  buildAcpNotification,
  buildAcpRequest,
  buildAcpResult,
  classifyAcpLine,
  encodeAcpMessage,
  isAcpSessionUpdateType,
  isAcpStopReason,
  parseInitializeResult,
  parseNewSessionResult,
  parsePermissionRequest,
  parsePromptResult,
  parseSessionNotification,
  parseToolCall,
} from "../src/index.js";

describe("JSON-RPC 编解码往返", () => {
  it("请求：encode → classify 还原 method / id / params", () => {
    const frame = encodeAcpMessage(
      buildAcpRequest(7, "session/prompt", { sessionId: "s-1", prompt: [] }),
    );
    expect(frame.endsWith("\n")).toBe(true);
    // 帧正文无裸换行（NDJSON 分帧的前提，规范 MUST NOT contain embedded newlines）
    expect(frame.slice(0, -1)).not.toContain("\n");
    const message = classifyAcpLine(frame.slice(0, -1));
    expect(message).toEqual({
      kind: "request",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [] },
    });
  });

  it("通知：无 id，params 可缺省（字段整个省略而非 undefined）", () => {
    const notification = buildAcpNotification("session/cancel", { sessionId: "s-1" });
    expect(classifyAcpLine(JSON.stringify(notification))).toEqual({
      kind: "notification",
      method: "session/cancel",
      params: { sessionId: "s-1" },
    });
    const bare = buildAcpNotification("ping");
    expect("params" in bare).toBe(false);
  });

  it("响应：成功带 result（undefined 升格 {}），错误带 code/message/data", () => {
    const ok = classifyAcpLine(JSON.stringify(buildAcpResult(3, { stopReason: "end_turn" })));
    expect(ok).toEqual({ kind: "response", id: 3, result: { stopReason: "end_turn" } });
    expect(buildAcpResult(4, undefined).result).toEqual({});

    const fail = classifyAcpLine(
      JSON.stringify(buildAcpError(5, ACP_JSON_RPC_METHOD_NOT_FOUND, "未知方法", { hint: "x" })),
    );
    expect(fail).toEqual({
      kind: "response",
      id: 5,
      error: { code: ACP_JSON_RPC_METHOD_NOT_FOUND, message: "未知方法", data: { hint: "x" } },
    });
  });

  it("中文与多字节内容经帧编码往返不失真", () => {
    const text = "任务：把 α→β 的迁移写完（含 emoji 🎯）";
    const frame = encodeAcpMessage(buildAcpRequest("req-中", "session/prompt", { text }));
    const message = classifyAcpLine(frame.trimEnd());
    expect(message?.kind).toBe("request");
    if (message?.kind === "request") {
      expect(message.id).toBe("req-中");
      expect((message.params as { text: string }).text).toBe(text);
    }
  });
});

describe("单行分类：畸形输入不抛、空行忽略", () => {
  it("空行 / 纯空白返回 undefined（不占诊断通道）", () => {
    expect(classifyAcpLine("")).toBeUndefined();
    expect(classifyAcpLine("   \t")).toBeUndefined();
  });

  it.each([
    ["非 JSON 文本", "WARN: agent booting…", "JSON 解析失败"],
    ["顶层数组（批量请求不支持）", "[{}]", "顶层不是 JSON 对象"],
    ["顶层标量", "42", "顶层不是 JSON 对象"],
    ["既无 method 也无 result/error", '{"jsonrpc":"2.0","id":1}', "不是 JSON-RPC 消息"],
    ["请求 id 非法（对象）", '{"method":"m","id":{}}', "id 非法"],
    ["响应 id 为 null（无从关联）", '{"jsonrpc":"2.0","id":null,"result":{}}', "无从关联"],
  ])("%s → invalid 且原文保留", (_label, line, reasonPart) => {
    const message = classifyAcpLine(line);
    expect(message?.kind).toBe("invalid");
    if (message?.kind === "invalid") {
      expect(message.raw).toBe(line);
      expect(message.reason).toContain(reasonPart);
    }
  });

  it("截断的 JSON（半包被强制上交的形态）归 invalid 不抛", () => {
    const truncated = '{"jsonrpc":"2.0","id":1,"result":{"stopRea';
    expect(() => classifyAcpLine(truncated)).not.toThrow();
    expect(classifyAcpLine(truncated)?.kind).toBe("invalid");
  });
});

describe("入站载荷宽容解析", () => {
  it("initialize：协商版本 + loadSession 能力 + authMethods；缺版本即 undefined", () => {
    const view = parseInitializeResult({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "grok-login" }, "非对象条目被滤掉"],
    });
    expect(view).toMatchObject({
      protocolVersion: 1,
      loadSession: true,
      authMethods: [{ id: "grok-login" }],
    });
    // 能力缺省全 false（规范默认值）
    expect(parseInitializeResult({ protocolVersion: 1 })?.loadSession).toBe(false);
    expect(parseInitializeResult({})).toBeUndefined();
    expect(parseInitializeResult({ protocolVersion: "1" })).toBeUndefined();
    expect(parseInitializeResult(null)).toBeUndefined();
  });

  it("session/new：sessionId 必有；prompt：stopReason 必有（未知字面量原样保留）", () => {
    expect(parseNewSessionResult({ sessionId: "s-9" })).toMatchObject({ sessionId: "s-9" });
    expect(parseNewSessionResult({})).toBeUndefined();
    expect(parsePromptResult({ stopReason: "end_turn" })).toMatchObject({
      stopReason: "end_turn",
    });
    expect(parsePromptResult({ stopReason: "future_reason" })?.stopReason).toBe("future_reason");
    expect(parsePromptResult({})).toBeUndefined();
  });

  it("session/update 三种 chunk：content 建型、messageId 可选、raw 透传", () => {
    const view = parseSessionNotification({
      sessionId: "s-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "你好" },
        messageId: "m-1",
      },
    });
    expect(view?.update).toMatchObject({
      kind: "agent_message_chunk",
      content: { type: "text", text: "你好" },
      messageId: "m-1",
    });
    expect(view?.raw).toMatchObject({ sessionId: "s-1" });
  });

  it("tool_call / tool_call_update：diff 内容与位置建型，缺 toolCallId 降级 opaque", () => {
    const view = parseSessionNotification({
      sessionId: "s-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        kind: "edit",
        content: [
          { type: "diff", path: "C:\\proj\\a.ts", oldText: "old", newText: "new" },
          { type: "content", content: { type: "text", text: "done" } },
          { type: "terminal", terminalId: "t-1" },
        ],
        locations: [{ path: "C:\\proj\\a.ts", line: 3 }, { noPath: true }],
      },
    });
    expect(view?.update.kind).toBe("tool_call_update");
    if (view?.update.kind !== "tool_call_update") {
      return;
    }
    const toolCall = view.update.toolCall;
    expect(toolCall.toolCallId).toBe("tc-1");
    expect(toolCall.status).toBe("completed");
    expect(toolCall.toolKind).toBe("edit");
    expect(toolCall.content).toEqual([
      expect.objectContaining({
        kind: "diff",
        path: "C:\\proj\\a.ts",
        oldText: "old",
        newText: "new",
      }),
      expect.objectContaining({
        kind: "content",
        content: expect.objectContaining({ text: "done" }),
      }),
      expect.objectContaining({ kind: "opaque", type: "terminal" }),
    ]);
    expect(toolCall.locations).toEqual([{ path: "C:\\proj\\a.ts", line: 3 }]);

    // 缺 toolCallId：降级 opaque，原文留档（不硬编码丢弃）
    const degraded = parseSessionNotification({
      sessionId: "s-1",
      update: { sessionUpdate: "tool_call", title: "无 id" },
    });
    expect(degraded?.update).toMatchObject({ kind: "opaque", sessionUpdate: "tool_call" });
  });

  it("plan：条目建型（缺字段给规范缺省）；规范后 4 种与未来扩展走 opaque 透传", () => {
    const plan = parseSessionNotification({
      sessionId: "s-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "写单测", priority: "high", status: "in_progress" },
          { content: "缺省字段" },
          "非对象滤掉",
        ],
      },
    });
    expect(plan?.update.kind).toBe("plan");
    if (plan?.update.kind === "plan") {
      expect(plan.update.entries).toEqual([
        expect.objectContaining({ content: "写单测", priority: "high", status: "in_progress" }),
        expect.objectContaining({ content: "缺省字段", priority: "medium", status: "pending" }),
      ]);
    }

    for (const sessionUpdate of [
      "available_commands_update",
      "current_mode_update",
      "someday_new",
    ]) {
      const view = parseSessionNotification({
        sessionId: "s-1",
        update: { sessionUpdate, anything: 1 },
      });
      expect(view?.update).toMatchObject({ kind: "opaque", sessionUpdate });
      if (view?.update.kind === "opaque") {
        expect(view.update.raw).toMatchObject({ anything: 1 });
      }
    }
  });

  it("session/update 缺 sessionId / update → undefined（无从路由）", () => {
    expect(parseSessionNotification({ update: {} })).toBeUndefined();
    expect(parseSessionNotification({ sessionId: "s-1" })).toBeUndefined();
    expect(parseSessionNotification("not-an-object")).toBeUndefined();
  });

  it("权限请求：options / toolCall / sessionId 三者齐才成型；选项缺 optionId 滤掉", () => {
    const view = parsePermissionRequest({
      sessionId: "s-1",
      toolCall: { toolCallId: "tc-1", title: "写文件" },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { name: "缺 id 滤掉", kind: "reject_once" },
        { optionId: "deny" },
      ],
    });
    expect(view).toMatchObject({
      sessionId: "s-1",
      toolCall: { toolCallId: "tc-1" },
    });
    expect(view?.options).toEqual([
      expect.objectContaining({ optionId: "allow", name: "允许", optionKind: "allow_once" }),
      // name / kind 缺省：name 回退 optionId，kind 回退 allow_once
      expect.objectContaining({ optionId: "deny", name: "deny", optionKind: "allow_once" }),
    ]);
    expect(
      parsePermissionRequest({ sessionId: "s-1", toolCall: { toolCallId: "t" }, options: [] }),
    ).toBeUndefined();
    expect(
      parsePermissionRequest({ sessionId: "s-1", options: [{ optionId: "a" }] }),
    ).toBeUndefined();
  });

  it("parseToolCall 单独暴露：非对象 / 缺 toolCallId → undefined", () => {
    expect(parseToolCall(null)).toBeUndefined();
    expect(parseToolCall({ title: "缺 id" })).toBeUndefined();
  });
});

describe("规范字面量集合（对照官方 schema-v1.21.0）", () => {
  it("StopReason 全集与守卫", () => {
    expect([...ACP_STOP_REASONS]).toEqual([
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]);
    expect(isAcpStopReason("cancelled")).toBe(true);
    expect(isAcpStopReason("completed")).toBe(false);
  });

  it("SessionUpdate 判别值全集（11 种）与守卫", () => {
    expect(ACP_SESSION_UPDATE_TYPES).toHaveLength(11);
    expect(isAcpSessionUpdateType("agent_message_chunk")).toBe(true);
    expect(isAcpSessionUpdateType("usage_update")).toBe(true);
    expect(isAcpSessionUpdateType("not_a_variant")).toBe(false);
  });
});
