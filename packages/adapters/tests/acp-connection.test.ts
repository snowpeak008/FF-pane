/**
 * T8.5a ACP 协议层单测（二）：AcpConnection 双工通道——PassThrough 假流驱动，
 * 零真机、零 spawn。覆盖：握手版本协商 / id 关联与超时 / 未决请求 reject /
 * 流式通知顺序（含乱序容错）/ 权限请求往返 / cancel 语义（规范 MUST：未决权限
 * 请求以 cancelled 回执）/ 分帧边界（半包/粘包/超长）/ 畸形输入不抛到顶层 /
 * 未知方法回错误。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  AcpClientHandler,
  AcpConnection,
  AcpDiagnostic,
  AcpPermissionDecision,
  AcpPermissionRequestView,
  AcpSessionNotificationView,
} from "../src/index.js";
import {
  ACP_JSON_RPC_INTERNAL_ERROR,
  ACP_JSON_RPC_INVALID_PARAMS,
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  AcpConnectionClosedError,
  AcpHandshakeError,
  AcpRemoteError,
  AcpTimeoutError,
  createAcpConnection,
} from "../src/index.js";

/** 让读取循环 / 微任务队列排空（PassThrough 的 data 投递跨一个宏任务）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly connection: AcpConnection;
  /** Agent 视角：FF-pane 写到它 stdin 的帧（逐行，已去行尾）。 */
  readonly sentLines: () => string[];
  /** Agent 视角：向它的 stdout 写数据（可写半包）。 */
  readonly emit: (chunk: string) => void;
  /** 模拟 Agent 进程退出（stdout 结束）。 */
  readonly endStdout: () => void;
  readonly updates: AcpSessionNotificationView[];
  readonly diagnostics: AcpDiagnostic[];
  readonly permissionRequests: AcpPermissionRequestView[];
}

function makeHarness(options?: {
  decide?: (request: AcpPermissionRequestView) => Promise<AcpPermissionDecision>;
  requestTimeoutMs?: number;
}): Harness {
  const stdin = new PassThrough({ encoding: "utf8" });
  const stdout = new PassThrough();
  const updates: AcpSessionNotificationView[] = [];
  const diagnostics: AcpDiagnostic[] = [];
  const permissionRequests: AcpPermissionRequestView[] = [];
  let written = "";
  stdin.on("data", (chunk: string) => {
    written += chunk;
  });

  const handler: AcpClientHandler = {
    onSessionUpdate(notification) {
      updates.push(notification);
    },
    async onPermissionRequest(request) {
      permissionRequests.push(request);
      if (options?.decide !== undefined) {
        return options.decide(request);
      }
      // 缺省：永不作答（cancel 语义用例需要请求悬着）
      return new Promise<AcpPermissionDecision>(() => {});
    },
  };

  const connection = createAcpConnection({
    writable: stdin,
    readable: stdout,
    handler,
    ...(options?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  return {
    connection,
    sentLines: () =>
      written
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line),
    emit: (chunk) => {
      stdout.write(chunk);
    },
    endStdout: () => {
      stdout.end();
    },
    updates,
    diagnostics,
    permissionRequests,
  };
}

/** 取 FF-pane 最近发出的请求（解析后），供 Agent 端按 id 回响应。 */
function lastSent(harness: Harness): Record<string, unknown> {
  const lines = harness.sentLines();
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("FF-pane 尚未发出任何帧");
  }
  return JSON.parse(last) as Record<string, unknown>;
}

async function respondTo(
  harness: Harness,
  matcher: { method: string },
  result: unknown,
): Promise<void> {
  await settle();
  const request = harness
    .sentLines()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .findLast((message) => message["method"] === matcher.method);
  if (request === undefined) {
    throw new Error(`未找到已发出的 ${matcher.method} 请求`);
  }
  harness.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request["id"], result })}\n`);
  await settle();
}

describe("握手：版本协商", () => {
  it("initialize 发 protocolVersion=1 + clientInfo；同版响应成功返回视图", async () => {
    const harness = makeHarness();
    const initializing = harness.connection.initialize({
      clientInfo: { name: "ff-pane", version: "0.9.0" },
    });
    await settle();
    const sent = lastSent(harness);
    expect(sent["method"]).toBe("initialize");
    expect(sent["params"]).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "ff-pane", version: "0.9.0" },
    });

    await respondTo(
      harness,
      { method: "initialize" },
      {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "login" }],
      },
    );
    const view = await initializing;
    expect(view.protocolVersion).toBe(1);
    expect(view.loadSession).toBe(true);
    expect(view.authMethods).toEqual([{ id: "login" }]);
  });

  it("Agent 回不同版本 → AcpHandshakeError（规范：不支持即断开）", async () => {
    const harness = makeHarness();
    const initializing = harness.connection.initialize();
    // 拒绝断言先附着再触发响应（避免 unhandled rejection 窗口）
    const assertions = Promise.all([
      expect(initializing).rejects.toBeInstanceOf(AcpHandshakeError),
      expect(initializing).rejects.toThrow("协议版本谈不拢"),
    ]);
    await respondTo(harness, { method: "initialize" }, { protocolVersion: 2 });
    await assertions;
  });

  it("响应缺 protocolVersion → AcpHandshakeError（不是合法 Agent）", async () => {
    const harness = makeHarness();
    const initializing = harness.connection.initialize();
    const assertion = expect(initializing).rejects.toBeInstanceOf(AcpHandshakeError);
    await respondTo(harness, { method: "initialize" }, { hello: true });
    await assertion;
  });
});

describe("id 关联与超时", () => {
  it("两个并发请求各自按 id 回配（乱序响应）", async () => {
    const harness = makeHarness();
    const first = harness.connection.newSession({ cwd: "C:\\proj-a" });
    const second = harness.connection.newSession({ cwd: "C:\\proj-b" });
    await settle();
    const [reqA, reqB] = harness
      .sentLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(reqA?.["id"]).not.toBe(reqB?.["id"]);
    // 后发的先回（乱序）
    harness.emit(
      `${JSON.stringify({ jsonrpc: "2.0", id: reqB?.["id"], result: { sessionId: "s-b" } })}\n`,
    );
    harness.emit(
      `${JSON.stringify({ jsonrpc: "2.0", id: reqA?.["id"], result: { sessionId: "s-a" } })}\n`,
    );
    await settle();
    expect((await first).sessionId).toBe("s-a");
    expect((await second).sessionId).toBe("s-b");
  });

  it("控制面请求超时 → AcpTimeoutError；迟到响应进诊断通道不影响其他请求", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ requestTimeoutMs: 50 });
      const authenticating = harness.connection.authenticate("login");
      const rejected = expect(authenticating).rejects.toBeInstanceOf(AcpTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await rejected;

      // 迟到的响应：无主，进诊断
      const request = lastSent(harness);
      harness.emit(`${JSON.stringify({ jsonrpc: "2.0", id: request["id"], result: {} })}\n`);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.diagnostics.some((entry) => entry.reason.includes("无主响应"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompt 缺省不限时（模型轮次时长归编排层看门狗）", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ requestTimeoutMs: 50 });
      const prompting = harness.connection.prompt({
        sessionId: "s-1",
        prompt: [{ type: "text", text: "长任务" }],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // 未超时——现在补响应，正常返回
      const request = lastSent(harness);
      harness.emit(
        `${JSON.stringify({ jsonrpc: "2.0", id: request["id"], result: { stopReason: "end_turn" } })}\n`,
      );
      await vi.advanceTimersByTimeAsync(1);
      expect((await prompting).stopReason).toBe("end_turn");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Agent 回错误响应 → AcpRemoteError（code 原样，如 -32000 auth_required）", async () => {
    const harness = makeHarness();
    const creating = harness.connection.newSession({ cwd: "C:\\proj" });
    const thrownPromise = creating.catch((error: unknown) => error);
    await settle();
    const request = lastSent(harness);
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request["id"],
        error: { code: -32000, message: "Authentication required" },
      })}\n`,
    );
    await settle();
    const thrown = await thrownPromise;
    expect(thrown).toBeInstanceOf(AcpRemoteError);
    expect((thrown as AcpRemoteError).code).toBe(-32000);
  });
});

describe("未决请求 reject（连接关闭）", () => {
  it("stdout 结束：全部未决请求以 AcpConnectionClosedError reject，closed 置真", async () => {
    const harness = makeHarness();
    const one = harness.connection.newSession({ cwd: "C:\\proj" });
    const two = harness.connection.prompt({ sessionId: "s-1", prompt: [] });
    const assertions = Promise.all([
      expect(one).rejects.toBeInstanceOf(AcpConnectionClosedError),
      expect(two).rejects.toBeInstanceOf(AcpConnectionClosedError),
    ]);
    await settle();
    harness.endStdout();
    await settle();
    await assertions;
    expect(harness.connection.closed).toBe(true);
    // 关闭后再发起：立即拒绝
    await expect(harness.connection.authenticate("x")).rejects.toBeInstanceOf(
      AcpConnectionClosedError,
    );
  });

  it("显式 close：同样全部 reject，幂等", async () => {
    const harness = makeHarness();
    const pending = harness.connection.newSession({ cwd: "C:\\proj" });
    const assertion = expect(pending).rejects.toThrow("测试收尾");
    await settle();
    harness.connection.close("测试收尾");
    harness.connection.close("重复关闭无害");
    await assertion;
  });
});

describe("流式通知顺序与乱序容错", () => {
  it("session/update 按到达序回调；先流后回（通知先于响应）不丢不乱", async () => {
    const harness = makeHarness();
    const prompting = harness.connection.prompt({ sessionId: "s-1", prompt: [] });
    await settle();
    const request = lastSent(harness);
    // Agent 先流两条 update，再回 prompt 响应
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一" } },
        },
      })}\n`,
    );
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "跑命令",
            kind: "execute",
          },
        },
      })}\n`,
    );
    harness.emit(
      `${JSON.stringify({ jsonrpc: "2.0", id: request["id"], result: { stopReason: "end_turn" } })}\n`,
    );
    await settle();
    expect((await prompting).stopReason).toBe("end_turn");
    expect(harness.updates.map((entry) => entry.update.kind)).toEqual([
      "agent_message_chunk",
      "tool_call",
    ]);
  });

  it("会话未建立前到达的 update 也照常上交（乱序容错：通知不依赖未决表）", async () => {
    const harness = makeHarness();
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-early",
          update: { sessionUpdate: "plan", entries: [{ content: "早到的计划" }] },
        },
      })}\n`,
    );
    await settle();
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]?.sessionId).toBe("s-early");
  });

  it("update 参数非法（缺 sessionId）进诊断通道，流不中断", async () => {
    const harness = makeHarness();
    harness.emit(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: {} } })}\n`,
    );
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "后续正常" },
          },
        },
      })}\n`,
    );
    await settle();
    expect(
      harness.diagnostics.some((entry) => entry.reason.includes("session/update 参数非法")),
    ).toBe(true);
    expect(harness.updates).toHaveLength(1);
  });
});

describe("权限请求往返", () => {
  const PERMISSION_FRAME = {
    jsonrpc: "2.0",
    id: "perm-1",
    method: "session/request_permission",
    params: {
      sessionId: "s-1",
      toolCall: { toolCallId: "tc-1", title: "写文件", kind: "edit" },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
    },
  };

  it("selected：handler 裁决 → outcome.selected + optionId 回写", async () => {
    const harness = makeHarness({
      decide: async () => ({ kind: "selected", optionId: "allow" }),
    });
    harness.emit(`${JSON.stringify(PERMISSION_FRAME)}\n`);
    await settle();
    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]?.options.map((option) => option.optionId)).toEqual([
      "allow",
      "deny",
    ]);
    const response = lastSent(harness);
    expect(response).toMatchObject({
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  it("handler 抛错：回 internal error 响应，连接不受影响", async () => {
    const harness = makeHarness({
      decide: async () => {
        throw new Error("裁决层炸了");
      },
    });
    harness.emit(`${JSON.stringify(PERMISSION_FRAME)}\n`);
    await settle();
    const response = lastSent(harness);
    expect(response).toMatchObject({
      id: "perm-1",
      error: { code: ACP_JSON_RPC_INTERNAL_ERROR },
    });
    expect(harness.connection.closed).toBe(false);
  });

  it("参数非法（无 options）：回 invalid params，不进 handler", async () => {
    const harness = makeHarness();
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "perm-bad",
        method: "session/request_permission",
        params: { sessionId: "s-1", toolCall: { toolCallId: "tc-1" }, options: [] },
      })}\n`,
    );
    await settle();
    expect(harness.permissionRequests).toHaveLength(0);
    expect(lastSent(harness)).toMatchObject({
      id: "perm-bad",
      error: { code: ACP_JSON_RPC_INVALID_PARAMS },
    });
  });
});

describe("cancel 语义", () => {
  const PERMISSION_FRAME = {
    jsonrpc: "2.0",
    id: "perm-hang",
    method: "session/request_permission",
    params: {
      sessionId: "s-1",
      toolCall: { toolCallId: "tc-1", title: "危险操作" },
      options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
    },
  };

  it("cancel 发通知（无 id）+ 同会话未决权限请求立即以 cancelled 回执（规范 MUST）", async () => {
    const harness = makeHarness(); // 缺省 handler 永不作答——请求悬着
    harness.emit(`${JSON.stringify(PERMISSION_FRAME)}\n`);
    await settle();
    expect(harness.permissionRequests).toHaveLength(1);

    harness.connection.cancel("s-1");
    await settle();
    const frames = harness.sentLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    const cancelFrame = frames.find((frame) => frame["method"] === "session/cancel");
    expect(cancelFrame).toMatchObject({ params: { sessionId: "s-1" } });
    expect(cancelFrame?.["id"]).toBeUndefined();
    const permissionResponse = frames.find((frame) => frame["id"] === "perm-hang");
    expect(permissionResponse).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
  });

  it("别的会话的未决权限请求不受 cancel 波及", async () => {
    const harness = makeHarness();
    harness.emit(`${JSON.stringify(PERMISSION_FRAME)}\n`);
    await settle();
    harness.connection.cancel("s-other");
    await settle();
    const frames = harness.sentLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames.some((frame) => frame["id"] === "perm-hang")).toBe(false);
  });

  it("cancel 抢答后 handler 迟到的裁决被丢弃（不二次回写）", async () => {
    let resolveDecision: ((decision: AcpPermissionDecision) => void) | undefined;
    const harness = makeHarness({
      decide: () =>
        new Promise<AcpPermissionDecision>((resolve) => {
          resolveDecision = resolve;
        }),
    });
    harness.emit(`${JSON.stringify(PERMISSION_FRAME)}\n`);
    await settle();
    harness.connection.cancel("s-1");
    await settle();
    // 用户此刻才点了"允许"——已被 cancel 抢答，丢弃
    resolveDecision?.({ kind: "selected", optionId: "allow" });
    await settle();
    const responses = harness
      .sentLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame["id"] === "perm-hang");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
  });
});

describe("分帧边界（NDJSON 经 events 行解码器）", () => {
  it("半包：一帧被切成任意小块仍完整解析（真跨 chunk：字符间 await 宏任务）", async () => {
    const harness = makeHarness();
    const prompting = harness.connection.prompt({ sessionId: "s-1", prompt: [] });
    await settle();
    const request = lastSent(harness);
    const frame = `${JSON.stringify({
      jsonrpc: "2.0",
      id: request["id"],
      result: { stopReason: "end_turn" },
    })}\n`;
    // 每字符间 await 宏任务，强制 PassThrough 逐 chunk 投递——同步循环 write 会被
    // 流合并成一个 chunk，帧仍以整块到达，测不到跨 chunk 缓冲（T8.5a 验收 §2-1）。
    for (const char of frame) {
      harness.emit(char);
      await settle();
    }
    expect((await prompting).stopReason).toBe("end_turn");
  });

  it("粘包：三帧挤在一个 chunk 里逐条分发", async () => {
    const harness = makeHarness();
    const update = (text: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    harness.emit(`${update("一")}\n${update("二")}\n${update("三")}\n`);
    await settle();
    expect(
      harness.updates.map((entry) =>
        entry.update.kind === "agent_message_chunk" ? entry.update.content.text : "?",
      ),
    ).toEqual(["一", "二", "三"]);
  });

  it("超长行：被解码器强制切开的巨帧归 invalid 诊断，连接照常工作", async () => {
    const harness = makeHarness();
    // events 行解码器缺省 8 MiB 上限——用不带换行的长文本触发强制切行
    // （测试用小得多的载荷验证"切开后是 invalid 而非崩溃"的性质即可，
    //  完整上限行为归 events.test.ts）
    harness.emit(`{"jsonrpc":"2.0","method":"session/update","params":{"x":"${"填".repeat(64)}`);
    // 没有换行符——半行悬在解码器里；后续正常帧照常到达
    harness.emit("\n");
    await settle();
    expect(harness.diagnostics.length).toBeGreaterThan(0);
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "恢复" } },
        },
      })}\n`,
    );
    await settle();
    expect(harness.updates).toHaveLength(1);
  });
});

describe("畸形输入与未知方法", () => {
  it("非 JSON 行 / 顶层数组进诊断通道，不抛到顶层、连接不关", async () => {
    const harness = makeHarness();
    harness.emit("WARN: agent 的 stderr 串进来了\n");
    harness.emit("[1,2,3]\n");
    await settle();
    expect(harness.diagnostics).toHaveLength(2);
    expect(harness.connection.closed).toBe(false);
  });

  it("未知方法的请求回 method not found（fs/* 未声明能力即未实现）", async () => {
    const harness = makeHarness();
    harness.emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "fs-1",
        method: "fs/read_text_file",
        params: { path: "C:\\x" },
      })}\n`,
    );
    await settle();
    expect(lastSent(harness)).toMatchObject({
      id: "fs-1",
      error: { code: ACP_JSON_RPC_METHOD_NOT_FOUND },
    });
  });

  it("未知通知不回包（JSON-RPC 规定），只留诊断", async () => {
    const harness = makeHarness();
    const before = harness.sentLines().length;
    harness.emit(`${JSON.stringify({ jsonrpc: "2.0", method: "session/mystery", params: {} })}\n`);
    await settle();
    expect(harness.sentLines().length).toBe(before);
    expect(harness.diagnostics.some((entry) => entry.reason.includes("未知通知"))).toBe(true);
  });
});
