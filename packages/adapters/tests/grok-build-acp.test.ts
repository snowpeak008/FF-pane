/**
 * T8.5b Grok Build ACP 模式测试：假进程句柄 + 脚本化假 Agent 驱动，零真机零 spawn。
 *
 * 三层覆盖：
 * 1. **全链路回放**：initialize 握手 → session/new → prompt 轮次 → session/update
 *    流式映射（text / file_change 带 diff / command 带退出码）→ end 语义
 *    （cancelled 不是成功、denied 改判、session_start 开轮即得）；
 * 2. **权限往返**：session/request_permission → 统一 permission_request 事件 →
 *    respondPermission 回执 → wire 上选对 optionId（once 优先、fail-closed 拒绝
 *    无法映射的工具）；
 * 3. **降级链**：握手失败 → auto 降级 headless 重跑（降级前零事件）+ 实例级缓存
 *    （第二轮直接 headless）；显式 acp 不降级；能力声明随选路条件式切换。
 *
 * 纯 wire 断言的辅助函数（acpUpdateToNativeRecord / toGrokAcpPermissionPayload /
 * pickAcpPermissionOption）另有直调用例。
 */

import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
} from "../src/index.js";
import {
  acpUpdateToNativeRecord,
  createGrokBuildAdapter,
  GROK_BUILD_ACP_CAPABILITIES,
  GROK_BUILD_CAPABILITIES,
  parseSessionNotification,
  pickAcpPermissionOption,
  toGrokAcpPermissionPayload,
} from "../src/index.js";

const SESSION_ID = "01a06e95-c754-7072-a0d2-f23ff14389fc";
const CWD = "C:/Users/USER/proj";

/** 假 Agent 的行为脚本：按收到的方法回应（返回 undefined = 不回应，悬着）。 */
interface FakeAgentScript {
  /** initialize 的响应 result；"garbage" = 回一行非协议文本（模拟旧版 grok）。 */
  readonly initialize?: Record<string, unknown> | "garbage" | "silent";
  /** session/new 的响应（error 形态用 { __error: {...} }）。 */
  readonly newSession?: Record<string, unknown>;
  /** authenticate 是否成功（登记调用）。 */
  readonly authenticateOk?: boolean;
  /** session/load 的响应。 */
  readonly loadSession?: Record<string, unknown>;
  /**
   * 收到 session/prompt 后的驱动函数：经 emit 发通知/请求，返回 prompt 的
   * result（或 error）。permission 请求的回执会回调 onPermissionResponse。
   */
  readonly onPrompt?: (agent: FakeAgent) => Promise<Record<string, unknown>>;
  /** 收到 session/cancel 通知时回调（cancel 优雅取消用例驱动 prompt 落定）。 */
  readonly onCancel?: (agent: FakeAgent) => void;
}

interface FakeAgent {
  /** 向适配器 stdout 写一帧。 */
  emit(message: Record<string, unknown>): void;
  /** 发一条 session/update 通知。 */
  update(update: Record<string, unknown>): void;
  /** 发权限请求并等回执（返回 outcome 对象）。 */
  requestPermission(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 收到的全部入站帧（适配器 → Agent）。 */
  readonly received: Record<string, unknown>[];
  readonly authenticateCalls: string[];
}

interface FakeProcess {
  readonly handle: AgentProcessHandle;
  readonly agent: FakeAgent;
  readonly killed: () => boolean;
}

/** 造一个由脚本驱动的假 grok agent stdio 进程。 */
function createFakeAcpProcess(script: FakeAgentScript): FakeProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.end();
  const stdin = new PassThrough({ encoding: "utf8" });
  const received: Record<string, unknown>[] = [];
  const authenticateCalls: string[] = [];
  const permissionWaiters = new Map<string | number, (outcome: Record<string, unknown>) => void>();
  let permissionSeq = 100;
  let killed = false;
  let resolveExit!: (exit: AgentProcessExit) => void;
  const exitPromise = new Promise<AgentProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  function emit(message: Record<string, unknown>): void {
    if (!killed) {
      stdout.write(`${JSON.stringify(message)}\n`);
    }
  }

  const agent: FakeAgent = {
    emit,
    update(update) {
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: SESSION_ID, update },
      });
    },
    requestPermission(params) {
      permissionSeq += 1;
      const id = permissionSeq;
      return new Promise((resolve) => {
        permissionWaiters.set(id, resolve);
        emit({ jsonrpc: "2.0", id, method: "session/request_permission", params });
      });
    },
    received,
    authenticateCalls,
  };

  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim() === "") {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      void dispatch(message);
    }
  });

  async function dispatch(message: Record<string, unknown>): Promise<void> {
    const id = message["id"] as string | number | undefined;
    const method = message["method"] as string | undefined;
    if (method === undefined && id !== undefined) {
      // 权限请求的回执
      const waiter = permissionWaiters.get(id);
      if (waiter !== undefined) {
        permissionWaiters.delete(id);
        waiter((message["result"] as Record<string, unknown>) ?? {});
      }
      return;
    }
    switch (method) {
      case "initialize": {
        const spec = script.initialize ?? {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "xai.api_key" }],
        };
        if (spec === "silent") {
          return;
        }
        if (spec === "garbage") {
          stdout.write("error: unrecognized subcommand 'agent'\n");
          stdout.end();
          return;
        }
        emit({ jsonrpc: "2.0", id, result: spec });
        return;
      }
      case "authenticate": {
        const params = message["params"] as Record<string, unknown>;
        authenticateCalls.push(String(params["methodId"]));
        emit({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      case "session/new": {
        const spec = script.newSession ?? { sessionId: SESSION_ID };
        // authenticate 之后的重试恒成功（authenticateOk 语义）
        if (spec["__error"] !== undefined && authenticateCalls.length === 0) {
          emit({ jsonrpc: "2.0", id, error: spec["__error"] });
          return;
        }
        if (spec["__error"] !== undefined && script.authenticateOk !== true) {
          emit({ jsonrpc: "2.0", id, error: spec["__error"] });
          return;
        }
        emit({ jsonrpc: "2.0", id, result: { sessionId: SESSION_ID } });
        return;
      }
      case "session/load": {
        emit({ jsonrpc: "2.0", id, result: script.loadSession ?? {} });
        return;
      }
      case "session/prompt": {
        const result = await (script.onPrompt?.(agent) ??
          Promise.resolve({ stopReason: "end_turn" }));
        if (result["__error"] !== undefined) {
          emit({ jsonrpc: "2.0", id, error: result["__error"] });
          return;
        }
        emit({ jsonrpc: "2.0", id, result });
        return;
      }
      case "session/cancel": {
        script.onCancel?.(agent);
        return;
      }
      default:
        return;
    }
  }

  const handle: AgentProcessHandle = {
    pid: 4242,
    stdout,
    stderr,
    stdin,
    exitPromise,
    resolvedCommand: "grok",
    viaCmdShim: false,
    strippedEnvNames: [],
    kill: async (): Promise<AgentProcessExit> => {
      if (!killed) {
        killed = true;
        stdout.end();
        resolveExit({ kind: "killed", exitCode: null, signal: null, error: null, errorCode: null });
      }
      return exitPromise;
    },
  };

  return { handle, agent, killed: () => killed };
}

/** spawn 记录 + 按次分发假进程（第一次 ACP，降级用例的第二次给 headless 假进程）。 */
function createSpawnRig(processes: readonly FakeProcess[]): {
  spawn: (spec: AgentProcessSpec) => AgentProcessHandle;
  specs: AgentProcessSpec[];
} {
  const specs: AgentProcessSpec[] = [];
  return {
    specs,
    spawn: (spec) => {
      const next = processes[specs.length];
      specs.push(spec);
      if (next === undefined) {
        throw new Error(`spawn 次数超出预置假进程数（第 ${specs.length} 次）`);
      }
      return next.handle;
    },
  };
}

/** headless 假进程：stdout 直接给 NDJSON 全文后结束（降级用例消费）。 */
function createFakeHeadlessProcess(ndjson: string): FakeProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.end();
  stdout.end(ndjson);
  let killed = false;
  const exit: AgentProcessExit = {
    kind: "exited",
    exitCode: 0,
    signal: null,
    error: null,
    errorCode: null,
  };
  const handle: AgentProcessHandle = {
    pid: 4243,
    stdout,
    stderr,
    stdin: null,
    exitPromise: Promise.resolve(exit),
    resolvedCommand: "grok",
    viaCmdShim: false,
    strippedEnvNames: [],
    kill: async () => {
      killed = true;
      return exit;
    },
  };
  return {
    handle,
    agent: undefined as never,
    killed: () => killed,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

function only<K extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
}

/** 真机录制的 ACP 事件形态（fixtures real-acp-success.jsonl 的骨架，字段名逐一同源）。 */
const WRITE_TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "call_write_1",
  title: "write",
  rawInput: { file_path: `${CWD}/hello.txt`, content: "hello" },
  _meta: { "x.ai/tool": { name: "write", kind: "write" } },
};

const WRITE_TOOL_DONE = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call_write_1",
  status: "completed",
  content: [{ type: "diff", path: `${CWD}/hello.txt`, oldText: "", newText: "hello" }],
};

const BASH_TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "call_bash_1",
  title: "run_terminal_command",
  rawInput: { command: "node -v", description: "check" },
  _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
};

const BASH_TOOL_DONE = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call_bash_1",
  status: "completed",
  content: [{ type: "content", content: { type: "text", text: "v24.15.0\r\n" } }],
  rawOutput: {
    type: "Bash",
    output_for_prompt: "exit: 0\nv24.15.0\n",
    exit_code: 0,
    command: "node -v",
    current_dir: CWD,
  },
};

describe("grok-build ACP 模式：全链路回放", () => {
  it("握手 → 会话 → 流式映射 → end：session_start 开轮即得，diff/退出码/文本齐全", async () => {
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        agent.update(WRITE_TOOL_CALL);
        agent.update(WRITE_TOOL_DONE);
        agent.update(BASH_TOOL_CALL);
        agent.update(BASH_TOOL_DONE);
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Created " },
        });
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello.txt." },
        });
        return {
          stopReason: "end_turn",
          _meta: { usage: { inputTokens: 812, outputTokens: 45, totalTokens: 857 } },
        };
      },
    });
    const rig = createSpawnRig([fake]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "做事" });

    // command 本身经 Windows PATH 解析可能是绝对路径，只钉参数面
    expect(turn.commandLine.slice(1)).toEqual(["agent", "--no-leader", "stdio"]);
    const events = await collect(turn.events);

    // session_start 开轮即得（headless 的 §7.3 坑 5 在 ACP 模式不存在），先于一切产出
    const startIndex = events.findIndex((event) => event.kind === "session_start");
    const start = only(events, "session_start");
    expect(start).toHaveLength(1);
    expect(start[0]?.native).toEqual({ nativeSessionId: SESSION_ID, cwd: CWD });
    expect(startIndex).toBeLessThan(events.findIndex((event) => event.kind === "file_change"));

    const changes = only(events, "file_change");
    expect(changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello"))).toBe(
      true,
    );
    const commands = only(events, "command");
    expect(commands.some((c) => c.status === "completed" && c.exitCode === 0)).toBe(true);
    const texts = only(events, "text").filter((t) => t.channel === "answer");
    expect(texts.map((t) => t.content).join("")).toBe("Created hello.txt.");
    expect(texts.at(-1)?.final).toBe(true);

    const end = only(events, "end");
    expect(end).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("end");
    expect(end[0]).toMatchObject({ reason: "completed" });
    expect(end[0]?.usage).toEqual({ inputTokens: 812, outputTokens: 45, totalTokens: 857 });
    // 协议层已给终局：进程是被主动收掉的，退出码不混进 end
    expect(end[0]?.exitCode).toBeUndefined();
    // 权限拦截前提：ACP 路径不带 --always-approve，且 stdin 是管道
    expect(rig.specs[0]?.args).not.toContain("--always-approve");
    expect(rig.specs[0]?.stdin).toBe("pipe");
    expect(fake.killed()).toBe(true);
  });

  it("initialize 发 clientInfo；-m 与 --reasoning-effort 落在 agent 层参数", async () => {
    const fake = createFakeAcpProcess({});
    const rig = createSpawnRig([fake]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn, reasoningEffort: "low" });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "x", model: "grok-4.6" });
    await collect(turn.events);
    expect(rig.specs[0]?.args).toEqual([
      "agent",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "low",
      "--no-leader",
      "stdio",
    ]);
    const init = fake.agent.received.find((m) => m["method"] === "initialize");
    expect(init?.["params"]).toMatchObject({
      protocolVersion: 1,
      clientInfo: { name: "ff-pane" },
    });
  });

  it("stopReason=cancelled 不是成功：end.reason=cancelled 且措辞是 ACP 口径", async () => {
    const fake = createFakeAcpProcess({
      onPrompt: async () => ({ stopReason: "cancelled" }),
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    const end = only(events, "end")[0];
    expect(end).toMatchObject({ reason: "cancelled" });
    expect(end?.message).toContain("FF-pane 权限层");
    expect(end?.message).not.toContain("--always-approve");
  });

  it("被拒的写入改判 denied 并计入阻断：end_turn 收尾仍报 failed（证据纪律）", async () => {
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        agent.update(WRITE_TOOL_CALL);
        agent.update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_write_1",
          status: "failed",
          // ACP 模式的实录拒绝措辞（real-acp-deny.jsonl）：与 headless 的
          // 「User cancelled」不同，是第四条 DENIAL_MARKER 钉住的那句
          content: [
            {
              type: "content",
              content: { type: "text", text: "User rejected the execution for tool `write`" },
            },
          ],
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(only(events, "file_change")[0]).toMatchObject({ status: "denied" });
    expect(only(events, "end")[0]).toMatchObject({ reason: "failed" });
  });

  it("session/new 回 -32000 且 Agent 声明 xai.api_key → authenticate 一次后重试成功", async () => {
    const fake = createFakeAcpProcess({
      newSession: { __error: { code: -32000, message: "Authentication required" } },
      authenticateOk: true,
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(fake.agent.authenticateCalls).toEqual(["xai.api_key"]);
    expect(only(events, "session_start")).toHaveLength(1);
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
  });

  it("resume：经 session/load 恢复同一 sessionId（不发 session/new）", async () => {
    const fake = createFakeAcpProcess({});
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const events = await collect(
      adapter.startTurn({
        cwd: CWD,
        prompt: "续",
        resume: { nativeSessionId: SESSION_ID as never, cwd: CWD },
      }).events,
    );
    const methods = fake.agent.received.map((m) => m["method"]);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(only(events, "session_start")[0]?.native?.nativeSessionId).toBe(SESSION_ID);
  });

  it("resume 绑定 cwd 不一致 → 启动前快速失败（两模式同规），不 spawn", async () => {
    const rig = createSpawnRig([]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn });
    const events = await collect(
      adapter.startTurn({
        cwd: "C:/repo-a",
        prompt: "x",
        resume: { nativeSessionId: "s-1" as never, cwd: "C:/repo-b" },
      }).events,
    );
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    expect(rig.specs).toHaveLength(0);
  });
});

describe("grok-build ACP 模式：权限往返", () => {
  const PERMISSION_PARAMS = {
    sessionId: SESSION_ID,
    toolCall: {
      toolCallId: "call_write_1",
      kind: "edit",
      title: `Write \`${CWD}/hello.txt\``,
      rawInput: { variant: "Write", file_path: `${CWD}/hello.txt`, content: "hello" },
      _meta: { "x.ai/tool": { name: "write", kind: "write" } },
    },
    // 真机实录的选项面（real-acp-success.jsonl 第 19 行）：always 在前 once 在后
    options: [
      { optionId: "allow-edits-session", name: "Yes, allow all edits", kind: "allow_always" },
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "reject-once", name: "No", kind: "reject_once" },
    ],
  };

  it("请求 → permission_request 事件（payload/diff/toolName）→ allow 回执选 allow_once", async () => {
    let outcome: Record<string, unknown> | undefined;
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        outcome = await agent.requestPermission({
          ...PERMISSION_PARAMS,
          toolCall: {
            ...PERMISSION_PARAMS.toolCall,
            content: [{ type: "diff", path: `${CWD}/hello.txt`, oldText: "", newText: "hello" }],
          },
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "x" });

    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
      if (event.kind === "permission_request") {
        // 回执凭据在事件出流前已登记（先登记再上浮）
        await turn.respondPermission?.(event.nativeRequestId, "allow");
      }
    }
    const request = only(events, "permission_request")[0];
    expect(request).toMatchObject({
      payload: { kind: "write_path", path: `${CWD}/hello.txt` },
      toolName: "write",
    });
    expect(request?.diff).toContain("+hello");
    // once 优先：不选 allow_always（会把逐次裁决升格成会话级豁免）
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
  });

  it("deny 回执选 reject_once", async () => {
    let outcome: Record<string, unknown> | undefined;
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        outcome = await agent.requestPermission(PERMISSION_PARAMS);
        return { stopReason: "cancelled" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "x" });
    for await (const event of turn.events) {
      if (event.kind === "permission_request") {
        await turn.respondPermission?.(event.nativeRequestId, "deny");
      }
    }
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  it("无法映射为信封语义的工具（spawn_subagent）fail-closed 自动拒绝，不上浮", async () => {
    let outcome: Record<string, unknown> | undefined;
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        outcome = await agent.requestPermission({
          sessionId: SESSION_ID,
          toolCall: {
            toolCallId: "call_sub_1",
            title: "spawn_subagent",
            rawInput: { task: "explore" },
            _meta: { "x.ai/tool": { name: "spawn_subagent", kind: "other" } },
          },
          options: PERMISSION_PARAMS.options,
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(only(events, "permission_request")).toHaveLength(0);
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(only(events, "raw").some((event) => (event.note ?? "").includes("fail-closed"))).toBe(
      true,
    );
  });

  it("同类 once 缺席退回 always 类选项时留档 raw（pickWithAudit 退路留档，T8.5b 验收 §2-1）", async () => {
    let outcome: Record<string, unknown> | undefined;
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        outcome = await agent.requestPermission({
          ...PERMISSION_PARAMS,
          // 真机选项面恒含 once（fixture 实证），此为将来 grok 改选项面的防御形态
          options: [
            { optionId: "allow-edits-session", name: "Yes, allow all", kind: "allow_always" },
            { optionId: "reject-once", name: "No", kind: "reject_once" },
          ],
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "x" });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
      if (event.kind === "permission_request") {
        await turn.respondPermission?.(event.nativeRequestId, "allow");
      }
    }
    // 退路生效：选了 always 类选项，但留下了 raw 证据（不静默豁免）
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "allow-edits-session" },
    });
    expect(only(events, "raw").some((event) => (event.note ?? "").includes("留档备查"))).toBe(true);
  });

  it("重复回执 / 未知凭据 → GrokAcpProtocolError", async () => {
    const fake = createFakeAcpProcess({
      onPrompt: async (agent) => {
        await agent.requestPermission(PERMISSION_PARAMS);
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "x" });
    for await (const event of turn.events) {
      if (event.kind === "permission_request") {
        await turn.respondPermission?.(event.nativeRequestId, "allow");
        await expect(turn.respondPermission?.(event.nativeRequestId, "allow")).rejects.toThrow(
          "不属本轮或已回执过",
        );
      }
    }
    await expect(turn.respondPermission?.("ghost-1", "allow")).rejects.toThrow(
      "不属本轮或已回执过",
    );
  });
});

describe("grok-build ACP 模式：优雅取消", () => {
  it("cancel → session/cancel 通知 → prompt 以 cancelled 落定 → end(cancelled)，进程收掉", async () => {
    let settlePrompt!: (result: Record<string, unknown>) => void;
    const fake = createFakeAcpProcess({
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "干活中" },
        });
        return new Promise((resolve) => {
          settlePrompt = resolve;
        });
      },
      onCancel: () => {
        // grok 收到 cancel 通知后优雅收工：prompt 以 stopReason=cancelled 落定
        settlePrompt({ stopReason: "cancelled" });
      },
    });
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "长任务" });

    const collected = collect(turn.events);
    // 等第一条流式产出（保证 prompt 已在飞）再取消
    await new Promise((resolve) => setTimeout(resolve, 20));
    await turn.cancel();
    const events = await collected;

    const cancelFrame = fake.agent.received.find((m) => m["method"] === "session/cancel");
    expect(cancelFrame).toMatchObject({ params: { sessionId: SESSION_ID } });
    expect(cancelFrame?.["id"]).toBeUndefined();
    expect(only(events, "end")[0]).toMatchObject({ reason: "cancelled" });
    expect(fake.killed()).toBe(true);
  });

  it("cancel 后 grok 不响应（宽限超时）→ 树杀兜底仍以 cancelled 收尾", async () => {
    const fake = createFakeAcpProcess({
      onPrompt: () => new Promise(() => {}), // 永不落定
      onCancel: () => {}, // 装死
    });
    const adapter = createGrokBuildAdapter({
      spawn: createSpawnRig([fake]).spawn,
      acpCancelGraceMs: 30,
    });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "挂死" });
    const collected = collect(turn.events);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await turn.cancel();
    const events = await collected;
    expect(only(events, "end")[0]).toMatchObject({ reason: "cancelled" });
    expect(fake.killed()).toBe(true);
  });
});

describe("grok-build ACP 模式：降级链与能力声明条件式", () => {
  /** 最小 headless 成功流（降级用例的第二个进程消费）。 */
  const HEADLESS_NDJSON = [
    JSON.stringify({ type: "text", data: "headless 答复" }),
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: SESSION_ID }),
  ].join("\n");

  it("auto：握手失败（旧版 grok 吐非协议文本）→ 降级 headless 重跑本轮 + 留档；缓存后第二轮直走 headless", async () => {
    const acp = createFakeAcpProcess({ initialize: "garbage" });
    const headless1 = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const headless2 = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([acp, headless1, headless2]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn, acpHandshakeTimeoutMs: 200 });

    expect(adapter.capabilities()).toEqual(GROK_BUILD_ACP_CAPABILITIES); // 探测前按首选路径报
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);

    // 降级留档在 headless 事件之前，且降级前零业务事件
    expect(events[0]?.kind).toBe("raw");
    expect((events[0] as { note?: string }).note).toContain("降级现行 streaming-json");
    expect(only(events, "text")[0]?.content).toBe("headless 答复");
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
    // headless 进程带 --always-approve 与 --prompt-file（现行模式逐字不变）
    expect(rig.specs[1]?.args).toContain("--always-approve");
    expect(rig.specs[1]?.args).toContain("--prompt-file");

    // 探测结果缓存：能力声明切回 headless 口径，第二轮不再试 ACP
    expect(adapter.capabilities()).toEqual(GROK_BUILD_CAPABILITIES);
    const second = await collect(adapter.startTurn({ cwd: CWD, prompt: "y" }).events);
    expect(rig.specs).toHaveLength(3);
    expect(rig.specs[2]?.args).toContain("--prompt-file");
    expect(only(second, "end")[0]).toMatchObject({ reason: "completed" });
    expect(
      second.some((event) => event.kind === "raw" && (event.note ?? "").includes("降级")),
    ).toBe(false);
  });

  it("auto：Agent 回不同协议版本 → AcpHandshakeError 走同一降级链（close + 收进程）", async () => {
    const acp = createFakeAcpProcess({ initialize: { protocolVersion: 2 } });
    const headless = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([acp, headless]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect((events[0] as { note?: string }).note).toContain("协议版本谈不拢");
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
    expect(acp.killed()).toBe(true); // 握手失败即收进程（T8.5a 验收 §2-3 接线）
  });

  it("auto：resume 而 Agent 无 loadSession 能力 → 降级 headless 以 -r 恢复（互通实测背书）", async () => {
    const acp = createFakeAcpProcess({
      initialize: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    const headless = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([acp, headless]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn });
    const events = await collect(
      adapter.startTurn({
        cwd: CWD,
        prompt: "续",
        resume: { nativeSessionId: SESSION_ID as never, cwd: CWD },
      }).events,
    );
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
    const headlessArgs = rig.specs[1]?.args ?? [];
    expect(headlessArgs).toContain("-r");
    expect(headlessArgs).toContain(SESSION_ID);
  });

  it("auto：initialize 静默超时（Agent 不回帧）→ 同一降级链降级 headless（T8.5b 验收 §2-3 缺口①）", async () => {
    const acp = createFakeAcpProcess({ initialize: "silent" });
    const headless = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([acp, headless]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn, acpHandshakeTimeoutMs: 30 });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(events[0]?.kind).toBe("raw");
    expect((events[0] as { note?: string }).note).toContain("降级现行 streaming-json");
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
    expect(acp.killed()).toBe(true); // 静默超时同样 close + 收进程
    expect(rig.specs).toHaveLength(2);
  });

  it("auto：spawn 直接失败（stdin 为 null 的恒抛写口）→ 同一降级链降级 headless（缺口②）", async () => {
    // spawn 失败的句柄形态：stdin null、stdout 空结束、exitPromise 即刻 spawn-failed
    const stdout = new PassThrough();
    stdout.end();
    const stderr = new PassThrough();
    stderr.end();
    const exit: AgentProcessExit = {
      kind: "spawn-failed",
      exitCode: null,
      signal: null,
      error: "spawn grok ENOENT",
      errorCode: "ENOENT",
    };
    let killed = false;
    const failedHandle: AgentProcessHandle = {
      pid: undefined,
      stdout,
      stderr,
      stdin: null,
      exitPromise: Promise.resolve(exit),
      resolvedCommand: "grok",
      viaCmdShim: false,
      strippedEnvNames: [],
      kill: async () => {
        killed = true;
        return exit;
      },
    };
    const headless = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([
      { handle: failedHandle, agent: undefined as never, killed: () => killed },
      headless,
    ]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(events[0]?.kind).toBe("raw");
    expect((events[0] as { note?: string }).note).toContain("降级现行 streaming-json");
    expect((events[0] as { note?: string }).note).toContain("stdin 不可用");
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
    expect(rig.specs).toHaveLength(2);
  });

  it("显式 transport=acp：握手失败不降级，如实 end(failed)", async () => {
    const acp = createFakeAcpProcess({ initialize: "garbage" });
    const rig = createSpawnRig([acp]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn, transport: "acp" });
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    expect((events[0] as { message?: string }).message).toContain("显式要求 ACP");
    expect(rig.specs).toHaveLength(1); // 没有第二次 spawn
    expect(adapter.capabilities()).toEqual(GROK_BUILD_ACP_CAPABILITIES); // 显式模式声明不漂移
  });

  it("显式 transport=streaming-json：恒走 headless，能力声明为现行口径", async () => {
    const headless = createFakeHeadlessProcess(HEADLESS_NDJSON);
    const rig = createSpawnRig([headless]);
    const adapter = createGrokBuildAdapter({ spawn: rig.spawn, transport: "streaming-json" });
    expect(adapter.capabilities()).toEqual(GROK_BUILD_CAPABILITIES);
    const events = await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(rig.specs[0]?.args).toContain("--prompt-file");
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
  });

  it("auto：ACP 成功后能力声明保持 ACP 口径（探测缓存的另一半）", async () => {
    const fake = createFakeAcpProcess({});
    const adapter = createGrokBuildAdapter({ spawn: createSpawnRig([fake]).spawn });
    await collect(adapter.startTurn({ cwd: CWD, prompt: "x" }).events);
    expect(adapter.capabilities()).toEqual(GROK_BUILD_ACP_CAPABILITIES);
  });
});

describe("grok-build ACP fixture 回放（真机录制 real-acp-*.jsonl，grok 1.0.13）", () => {
  /** 取 fixture 里的 session/update 通知，走「逆投影 → 现行 mapper」同一条链。 */
  async function replayAcpFixture(fixture: string): Promise<AgentEvent[]> {
    const text = await readFile(
      new URL(`../fixtures/grok-build/${fixture}`, import.meta.url),
      "utf8",
    );
    const { createGrokEventMapper } = await import("../src/index.js");
    const mapper = createGrokEventMapper({ cwd: "C:/Users/USER/AppData/Local/Temp" });
    const events: AgentEvent[] = [];
    let lineNumber = 0;
    let stopReason: string | undefined;
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      lineNumber += 1;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message["method"] === "session/update") {
        const view = parseSessionNotification(message["params"]);
        if (view !== undefined) {
          events.push(
            ...mapper.map({
              ok: true,
              lineNumber,
              raw: line,
              value: acpUpdateToNativeRecord(view.update),
            }),
          );
        }
      }
      const result = message["result"] as Record<string, unknown> | undefined;
      if (typeof result?.["stopReason"] === "string" && message["id"] === 3) {
        stopReason = result["stopReason"] as string;
      }
    }
    if (stopReason !== undefined) {
      events.push(
        ...mapper.map({
          ok: true,
          lineNumber: lineNumber + 1,
          raw: "",
          value: { type: "end", stopReason },
        }),
      );
    }
    events.push(
      ...mapper.finalize({ cancelled: false, spawnFailed: false, exitCode: null, error: null }),
    );
    return events;
  }

  it("success：写文件 diff / 命令退出码 / 文本增量 / end=completed（词汇与 headless 投影同源）", async () => {
    const events = await replayAcpFixture("real-acp-success.jsonl");
    const changes = only(events, "file_change");
    expect(changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello"))).toBe(
      true,
    );
    const commands = only(events, "command");
    expect(commands.some((c) => c.status === "completed" && c.exitCode === 0)).toBe(true);
    const texts = only(events, "text").filter((t) => t.channel === "answer");
    expect(texts.map((t) => t.content).join("")).toBe(
      "Created hello.txt and checked the Node version.",
    );
    expect(only(events, "end")[0]).toMatchObject({ reason: "completed" });
  });

  it("deny：拒绝措辞「User rejected the execution」改判 denied，end=cancelled 不是成功", async () => {
    const events = await replayAcpFixture("real-acp-deny.jsonl");
    const changes = only(events, "file_change");
    expect(changes.some((c) => c.status === "denied")).toBe(true);
    expect(changes.some((c) => c.status === "completed")).toBe(false);
    expect(only(events, "end")[0]).toMatchObject({ reason: "cancelled" });
  });

  it("cancel：session/cancel 后 prompt 以 cancelled 落定（优雅取消的真机证据）", async () => {
    const events = await replayAcpFixture("real-acp-cancel.jsonl");
    // 取消前已完成的命令仍是有效证据
    expect(only(events, "command").some((c) => c.status === "completed")).toBe(true);
    expect(only(events, "end")[0]).toMatchObject({ reason: "cancelled" });
  });
});

describe("grok-build ACP 辅助函数（纯 wire 断言）", () => {
  it("acpUpdateToNativeRecord：chunk 文本提升为 data；tool_call 从 _meta 提升 kind/toolName", () => {
    const chunk = parseSessionNotification({
      sessionId: SESSION_ID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "片段" } },
    });
    expect(acpUpdateToNativeRecord(chunk?.update as never)).toMatchObject({
      type: "text",
      data: "片段",
    });

    const thought = parseSessionNotification({
      sessionId: SESSION_ID,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } },
    });
    expect(acpUpdateToNativeRecord(thought?.update as never)).toMatchObject({
      type: "thought",
      data: "想",
    });

    const toolCall = parseSessionNotification({
      sessionId: SESSION_ID,
      update: WRITE_TOOL_CALL,
    });
    expect(acpUpdateToNativeRecord(toolCall?.update as never)).toMatchObject({
      type: "tool_call",
      kind: "write",
      toolName: "write",
      toolCallId: "call_write_1",
    });

    const opaque = parseSessionNotification({
      sessionId: SESSION_ID,
      update: { sessionUpdate: "usage_update", tokens: 5 },
    });
    expect(acpUpdateToNativeRecord(opaque?.update as never)).toMatchObject({
      type: "usage_update",
      tokens: 5,
    });
  });

  it("toGrokAcpPermissionPayload：五类信封映射 + 套不上返回 undefined", () => {
    const write = {
      toolCallId: "t",
      rawInput: { file_path: "C:/p/a.txt" },
      content: [],
      locations: [],
      raw: { _meta: { "x.ai/tool": { kind: "write" } } },
    };
    expect(toGrokAcpPermissionPayload(write as never, CWD)).toEqual({
      kind: "write_path",
      path: "C:/p/a.txt",
    });
    const exec = {
      toolCallId: "t",
      rawInput: { command: "rm -rf x" },
      content: [],
      locations: [],
      raw: { _meta: { "x.ai/tool": { kind: "execute" } } },
    };
    expect(toGrokAcpPermissionPayload(exec as never, CWD)).toEqual({
      kind: "shell_command",
      command: "rm -rf x",
    });
    const read = {
      toolCallId: "t",
      toolKind: "read",
      rawInput: {},
      content: [],
      locations: [],
      raw: {},
    };
    expect(toGrokAcpPermissionPayload(read as never, CWD)).toEqual({
      kind: "read_path",
      path: CWD,
    });
    const fetch = {
      toolCallId: "t",
      toolKind: "fetch",
      rawInput: { url: "https://x.ai" },
      content: [],
      locations: [],
      raw: {},
    };
    expect(toGrokAcpPermissionPayload(fetch as never, CWD)).toEqual({
      kind: "network",
      target: "https://x.ai",
    });
    const subagent = {
      toolCallId: "t",
      toolKind: "other",
      rawInput: { task: "x" },
      content: [],
      locations: [],
      raw: {},
    };
    expect(toGrokAcpPermissionPayload(subagent as never, CWD)).toBeUndefined();
  });

  it("pickAcpPermissionOption：once 优先，缺 once 退同前缀，全缺 undefined", () => {
    const options = [
      { optionId: "aa", name: "", optionKind: "allow_always", raw: {} },
      { optionId: "ao", name: "", optionKind: "allow_once", raw: {} },
      { optionId: "ro", name: "", optionKind: "reject_once", raw: {} },
    ] as const;
    expect(pickAcpPermissionOption(options, "allow")?.optionId).toBe("ao");
    expect(pickAcpPermissionOption(options, "deny")?.optionId).toBe("ro");
    const onlyAlways = [{ optionId: "aa", name: "", optionKind: "allow_always", raw: {} }] as const;
    expect(pickAcpPermissionOption(onlyAlways, "allow")?.optionId).toBe("aa");
    expect(pickAcpPermissionOption(onlyAlways, "deny")).toBeUndefined();
  });
});
