/**
 * T8.6b iFlow 适配器测试：假进程句柄 + fixture wire 回放驱动，零真机零 spawn。
 *
 * 四层覆盖：
 * 1. **fixture 回放**（`fixtures/iflow/real-acp-*.wire.jsonl` 真读）：假 Agent 的
 *    控制面响应与 session/update 通知**逐行取自 fixture 原文**（`<<< ` 行），经真
 *    AcpConnection 解析 → 真 mapper 映射——成功流 / 权限 allow / 权限 reject /
 *    取消 / load / noauth 六份全回放；
 * 2. **坑位防线**：审批拒绝无 failed 事件 → 权限桥自记账（denied 事件 + end_turn
 *    改判 failed）；session/new 默认 yolo → set_mode 纪律闸（切失败即本轮失败，
 *    prompt 不发）；恒选 `*_once`（proceed_always 在场也不选）；
 * 3. **命令/环境组装**：ACP 单通道参数面、受管 HOME 双变量替换、IFLOW_MODEL_NAME
 *    预占（反 .env 劫持）、静态 settings 内容与落盘、env 清洗面 IFLOW_ 前缀；
 * 4. **适配器本体**：能力六项、resume cwd 快速失败零 spawn、spawn 失败如实收尾。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePermissionRequest } from "../src/acp/index.js";
import type {
  AgentEvent,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
} from "../src/index.js";
import {
  buildIFlowAcpArgs,
  buildIFlowEnv,
  commandFromIFlowTitle,
  createIFlowAdapter,
  IFLOW_CAPABILITIES,
  IFLOW_MANAGED_SETTINGS_JSON,
  IFLOW_NOAUTH_MESSAGE,
  IFLOW_RUNTIME,
  isApiKeyEnvName,
  pickIFlowPermissionOption,
  toIFlowPermissionPayload,
} from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/iflow/", import.meta.url));
const CWD = "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-iflow-probe\\work";

/* ------------------------------------------------------------------ *
 * fixture wire 装载：`<<< ` 行按 JSON 解析（非 JSON 行是 banner，保留原文），
 * 拆出控制面响应 / 通知 / 权限请求，供假 Agent 逐行回放。
 * ------------------------------------------------------------------ */

interface WireFixture {
  /** 非 JSON banner 行原文（initialize 响应前发出，验证非 JSON 容忍）。 */
  readonly banners: readonly string[];
  /** initialize 响应的 result。 */
  readonly initResult: Record<string, unknown>;
  /** session/new 或 session/load 响应的 result（noauth 形态为 error）。 */
  readonly sessionResult?: Record<string, unknown>;
  readonly sessionError?: Record<string, unknown>;
  /** session/set_mode 响应的 result（fixture 无该帧时缺席，假 Agent 合成）。 */
  readonly setModeResult?: Record<string, unknown>;
  /** prompt 期的逐行事件：通知与权限请求按 fixture 顺序排列。 */
  readonly promptFeed: readonly (
    | { readonly kind: "update"; readonly params: Record<string, unknown> }
    | { readonly kind: "permission"; readonly params: Record<string, unknown> }
  )[];
  /** prompt 响应的 result（{stopReason}；fixture 无 prompt 时缺席）。 */
  readonly promptResult?: Record<string, unknown>;
}

async function loadWire(name: string): Promise<WireFixture> {
  const text = await readFile(join(FIXTURE_ROOT, name), "utf8");
  const banners: string[] = [];
  let initResult: Record<string, unknown> | undefined;
  let sessionResult: Record<string, unknown> | undefined;
  let sessionError: Record<string, unknown> | undefined;
  let setModeResult: Record<string, unknown> | undefined;
  let promptResult: Record<string, unknown> | undefined;
  const promptFeed: (
    | { kind: "update"; params: Record<string, unknown> }
    | { kind: "permission"; params: Record<string, unknown> }
  )[] = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("<<< ")) {
      continue;
    }
    const body = line.slice(4);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      banners.push(body);
      continue;
    }
    const method = parsed["method"];
    if (method === "session/update") {
      promptFeed.push({ kind: "update", params: parsed["params"] as Record<string, unknown> });
      continue;
    }
    if (method === "session/request_permission") {
      promptFeed.push({ kind: "permission", params: parsed["params"] as Record<string, unknown> });
      continue;
    }
    const result = parsed["result"] as Record<string, unknown> | undefined;
    const error = parsed["error"] as Record<string, unknown> | undefined;
    if (result !== undefined && result["protocolVersion"] !== undefined) {
      initResult = result;
      continue;
    }
    if (result !== undefined && result["stopReason"] !== undefined) {
      promptResult = result;
      continue;
    }
    if (result !== undefined && result["success"] !== undefined) {
      setModeResult = result;
      continue;
    }
    if (result !== undefined && result["sessionId"] !== undefined) {
      sessionResult = result;
      continue;
    }
    if (error !== undefined) {
      sessionError = error;
    }
  }
  if (initResult === undefined) {
    throw new Error(`fixture ${name} 缺 initialize 响应`);
  }
  return {
    banners,
    initResult,
    ...(sessionResult === undefined ? {} : { sessionResult }),
    ...(sessionError === undefined ? {} : { sessionError }),
    ...(setModeResult === undefined ? {} : { setModeResult }),
    promptFeed,
    ...(promptResult === undefined ? {} : { promptResult }),
  };
}

/* ------------------------------------------------------------------ *
 * 假 iflow --experimental-acp 进程：按 fixture wire 回放。
 * ------------------------------------------------------------------ */

interface FakeProcess {
  readonly handle: AgentProcessHandle;
  /** 适配器 → Agent 的全部入站帧。 */
  readonly received: Record<string, unknown>[];
  readonly killed: () => boolean;
}

interface FakeAgentOptions {
  readonly wire: WireFixture;
  /** 覆盖 set_mode 的响应为错误（纪律闸失败用例）。 */
  readonly setModeError?: Record<string, unknown>;
  /** 收到 session/cancel 通知时是否以 cancelled 落定 prompt。 */
  readonly cancelSettlesPrompt?: boolean;
}

function createFakeIFlowProcess(options: FakeAgentOptions): FakeProcess {
  const { wire } = options;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.end();
  const stdin = new PassThrough({ encoding: "utf8" });
  const received: Record<string, unknown>[] = [];
  let killed = false;
  let promptId: unknown;
  let resolveExit!: (exit: AgentProcessExit) => void;
  const exitPromise = new Promise<AgentProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  function emitRaw(line: string): void {
    if (!killed) {
      stdout.write(`${line}\n`);
    }
  }
  function emit(message: Record<string, unknown>): void {
    emitRaw(JSON.stringify(message));
  }

  const permissionWaiters = new Map<unknown, (outcome: unknown) => void>();

  /** prompt 期回放：逐条发通知；遇权限请求则发出并等回执再继续。 */
  async function feedPrompt(): Promise<void> {
    let permissionSeq = 0;
    for (const entry of wire.promptFeed) {
      if (entry.kind === "update") {
        emit({ jsonrpc: "2.0", method: "session/update", params: entry.params });
        continue;
      }
      // fixture 的权限请求 id 固定为 0；多条时递增防撞
      const id = permissionSeq;
      permissionSeq += 1;
      await new Promise<unknown>((resolve) => {
        permissionWaiters.set(id, resolve);
        emit({ jsonrpc: "2.0", id, method: "session/request_permission", params: entry.params });
      });
    }
    if (wire.promptResult !== undefined) {
      emit({ jsonrpc: "2.0", id: promptId, result: wire.promptResult });
    }
    // promptResult 缺席 = 挂住（取消用例由 session/cancel 落定）
  }

  function dispatch(message: Record<string, unknown>): void {
    const id = message["id"];
    const method = message["method"];
    if (method === undefined && id !== undefined) {
      const waiter = permissionWaiters.get(id);
      if (waiter !== undefined) {
        permissionWaiters.delete(id);
        waiter(message["result"]);
      }
      return;
    }
    switch (method) {
      case "initialize":
        for (const banner of wire.banners) {
          emitRaw(banner);
        }
        emit({ jsonrpc: "2.0", id, result: wire.initResult });
        return;
      case "session/new":
      case "session/load":
        if (wire.sessionError !== undefined) {
          emit({ jsonrpc: "2.0", id, error: wire.sessionError });
          return;
        }
        emit({ jsonrpc: "2.0", id, result: wire.sessionResult ?? {} });
        return;
      case "session/set_mode":
        if (options.setModeError !== undefined) {
          emit({ jsonrpc: "2.0", id, error: options.setModeError });
          return;
        }
        emit({ jsonrpc: "2.0", id, result: wire.setModeResult ?? { success: true } });
        return;
      case "session/prompt":
        promptId = id;
        void feedPrompt();
        return;
      case "session/cancel":
        if (options.cancelSettlesPrompt === true && promptId !== undefined) {
          emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        }
        return;
      default:
        return;
    }
  }

  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim() !== "") {
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        dispatch(message);
      }
    }
  });

  const handle: AgentProcessHandle = {
    pid: 4242,
    stdout,
    stderr,
    stdin,
    exitPromise,
    resolvedCommand: "iflow",
    viaCmdShim: true,
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
  return { handle, received, killed: () => killed };
}

/** 从适配器 → Agent 的权限回执帧里取 optionId（回执 = 无 method、有 id 与 result）。 */
function permissionOptionId(received: readonly Record<string, unknown>[]): string | undefined {
  const outcome = received.find(
    (m) => m["method"] === undefined && m["result"] !== undefined && m["id"] !== undefined,
  );
  const result = outcome?.["result"];
  if (result === undefined || typeof result !== "object") {
    return undefined;
  }
  const inner = (result as Record<string, unknown>)["outcome"];
  return typeof inner === "object" && inner !== null
    ? ((inner as Record<string, unknown>)["optionId"] as string | undefined)
    : undefined;
}

/** spawn 记录接缝。 */
function rig(processes: readonly FakeProcess[]): {
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

/** 跑完一轮收集全部事件。onPermission 缺省 allow。 */
async function runTurn(
  wire: WireFixture,
  options: {
    readonly setModeError?: Record<string, unknown>;
    readonly cancelSettlesPrompt?: boolean;
    readonly onPermission?: "allow" | "deny";
    readonly resume?: { nativeSessionId: string; cwd: string };
    readonly cancelAfterFirstEvent?: boolean;
    readonly model?: string;
  } = {},
): Promise<{
  events: AgentEvent[];
  received: Record<string, unknown>[];
  specs: AgentProcessSpec[];
}> {
  const fake = createFakeIFlowProcess({
    wire,
    ...(options.setModeError === undefined ? {} : { setModeError: options.setModeError }),
    ...(options.cancelSettlesPrompt === undefined
      ? {}
      : { cancelSettlesPrompt: options.cancelSettlesPrompt }),
  });
  const { spawn, specs } = rig([fake]);
  const adapter = createIFlowAdapter({ spawn, acpControlTimeoutMs: 3_000 });
  const turn = adapter.startTurn({
    cwd: CWD,
    prompt: "Create hello-acp.txt with content hello, run node -v, then summarize.",
    ...(options.model === undefined ? {} : { model: options.model as never }),
    ...(options.resume === undefined ? {} : { resume: options.resume as never }),
  });
  const events: AgentEvent[] = [];
  let cancelled = false;
  for await (const event of turn.events) {
    events.push(event);
    if (event.kind === "permission_request") {
      await turn.respondPermission?.(event.nativeRequestId, options.onPermission ?? "allow");
    }
    if (options.cancelAfterFirstEvent === true && !cancelled && event.kind === "session_start") {
      cancelled = true;
      void turn.cancel();
    }
  }
  return { events, received: fake.received, specs };
}

/* ------------------------------------------------------------------ *
 * 命令 / 环境组装（纯函数）。
 * ------------------------------------------------------------------ */

describe("命令与环境组装", () => {
  it("ACP 单通道参数面恒为 --experimental-acp（模型/会话/模式全走协议）", () => {
    expect(buildIFlowAcpArgs()).toEqual(["--experimental-acp"]);
  });

  it("受管 HOME：USERPROFILE 与 HOME 双替换（settings 不受 IFLOW_HOME 影响，坑 5）", () => {
    const env = buildIFlowEnv({ managedHome: "C:\\data\\iflow-home" });
    expect(env["USERPROFILE"]).toBe("C:\\data\\iflow-home");
    expect(env["HOME"]).toBe("C:\\data\\iflow-home");
  });

  it("模型经 IFLOW_MODEL_NAME 预占下发（-m 会被项目 .env 压过，实测；预占即免疫劫持）", () => {
    const env = buildIFlowEnv({ model: "glm-5" as never });
    expect(env["IFLOW_MODEL_NAME"]).toBe("glm-5");
    // 缺席模型不塞空值
    expect(buildIFlowEnv({})["IFLOW_MODEL_NAME"]).toBeUndefined();
  });

  it("ctx.env 打底、显式项覆盖其上（密钥三件套经 ctx.env 下发）", () => {
    const env = buildIFlowEnv({
      ctxEnv: { IFLOW_API_KEY: "sk", IFLOW_MODEL_NAME: "from-ctx" },
      model: "glm-5" as never,
    });
    expect(env["IFLOW_API_KEY"]).toBe("sk");
    expect(env["IFLOW_MODEL_NAME"]).toBe("glm-5");
  });

  it("受管 settings 是一行静态常量：仅钉 selectedAuthType，三件套不落盘（§4.3）", () => {
    expect(JSON.parse(IFLOW_MANAGED_SETTINGS_JSON)).toEqual({
      selectedAuthType: "openai-compatible",
    });
    expect(IFLOW_MANAGED_SETTINGS_JSON).not.toContain("apiKey");
    expect(IFLOW_MANAGED_SETTINGS_JSON.endsWith("\n")).toBe(true);
  });

  it("env 清洗面：IFLOW_ 全前缀剥（含小写与数据目录劫持），CLI_TITLE 不误伤", () => {
    expect(isApiKeyEnvName("IFLOW_API_KEY")).toBe(true);
    expect(isApiKeyEnvName("iflow_model_name")).toBe(true);
    expect(isApiKeyEnvName("IFLOW_HOME")).toBe(true);
    expect(isApiKeyEnvName("IFLOW_CLI_SYSTEM_SETTINGS_PATH")).toBe(true);
    expect(isApiKeyEnvName("CLI_TITLE")).toBe(false);
  });

  it("命令 title 剥 cwd 描述后缀（命令原文只在 title——权限请求的 toolCall 无 args）", () => {
    expect(
      commandFromIFlowTitle(
        "node -v [current working directory C:\\Users\\USER\\work] (Check node)",
      ),
    ).toBe("node -v");
    expect(commandFromIFlowTitle("plain title")).toBe("plain title");
    expect(commandFromIFlowTitle(undefined)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 权限载荷与选项（消费 fixture 的权限请求原文）。
 * ------------------------------------------------------------------ */

describe("权限载荷映射与选项挑选", () => {
  it("edit 类（fixture 权限请求原文）→ write_path，diff 路径兜底", async () => {
    const wire = await loadWire("real-acp-permission-allow.wire.jsonl");
    const entry = wire.promptFeed.find((item) => item.kind === "permission");
    expect(entry).toBeDefined();
    const view = parsePermissionRequest(entry?.params);
    expect(view).toBeDefined();
    if (view === undefined) {
      return;
    }
    expect(toIFlowPermissionPayload(view.toolCall)).toEqual({
      kind: "write_path",
      path: "hello-perm.txt",
    });
    // 恒选 *_once：proceed_always（allow_always）在场也不选（会话级豁免绕权限层）
    expect(pickIFlowPermissionOption(view.options, "allow")?.optionId).toBe("proceed_once");
    expect(pickIFlowPermissionOption(view.options, "deny")?.optionId).toBe("cancel");
  });

  it("execute 类：args 与 content 皆空，命令原文从 title 剥出（真机形态）", () => {
    const view = parsePermissionRequest({
      sessionId: "s",
      options: [{ optionId: "proceed_once", name: "Allow", kind: "allow_once" }],
      toolCall: {
        toolCallId: "call_sh",
        status: "pending",
        title: "node -v [current working directory C:\\work] (check node)",
        content: [],
        locations: [],
        kind: "execute",
      },
    });
    expect(view).toBeDefined();
    if (view === undefined) {
      return;
    }
    expect(toIFlowPermissionPayload(view.toolCall)).toEqual({
      kind: "shell_command",
      command: "node -v",
    });
  });

  it("类目套不上信封语义 → undefined（调用方 fail-closed 拒绝）", () => {
    const view = parsePermissionRequest({
      sessionId: "s",
      options: [{ optionId: "cancel", name: "Reject", kind: "reject_once" }],
      toolCall: { toolCallId: "t", kind: "other", content: [], locations: [] },
    });
    expect(view).toBeDefined();
    if (view !== undefined) {
      expect(toIFlowPermissionPayload(view.toolCall)).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ *
 * fixture 回放：全链路。
 * ------------------------------------------------------------------ */

describe("fixture 回放（real-acp-*.wire.jsonl 经真连接与真映射器）", () => {
  it("成功流：session_start 开轮即得 → file_change 带 fileDiff → command 带输出 → 文本 → end completed", async () => {
    const wire = await loadWire("real-acp-success.wire.jsonl");
    const { events, received } = await runTurn(wire);

    // banner 非 JSON 行经诊断通道留档（不断流）
    expect(events.some((e) => e.kind === "raw" && (e.note ?? "").includes("ACP 诊断"))).toBe(true);

    // session_start 先于一切动作（sessionId 在 session/new 响应即得）
    const startIndex = events.findIndex((e) => e.kind === "session_start");
    const firstAction = events.findIndex((e) => e.kind === "file_change" || e.kind === "command");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(firstAction);
    const start = events[startIndex];
    expect(start?.kind === "session_start" && start.native?.nativeSessionId).toBe(
      "40afe15f-a533-44a9-a744-129432033038",
    );
    expect(start?.kind === "session_start" && start.native?.cwd).toBe(CWD);

    // 纪律闸：set_mode(default) 必须在 prompt 之前发出（默认 currentModeId=yolo）
    const methods = received.map((m) => m["method"]);
    expect(methods.indexOf("session/set_mode")).toBeGreaterThan(methods.indexOf("session/new"));
    expect(methods.indexOf("session/set_mode")).toBeLessThan(methods.indexOf("session/prompt"));
    const setMode = received.find((m) => m["method"] === "session/set_mode");
    const setModeParams = (setMode?.["params"] ?? {}) as Record<string, unknown>;
    expect(setModeParams["modeId"]).toBe("default");

    // 文件事件：add + fileDiff 统一 diff 原文（不自渲染）
    const change = events.find((e) => e.kind === "file_change" && e.status === "completed");
    expect(change?.kind === "file_change" && change.changeKind).toBe("add");
    expect(change?.kind === "file_change" && change.path).toContain("hello-acp.txt");
    expect(change?.kind === "file_change" && change.diff).toContain("+hello");

    // 命令事件：started（带 command 的 in_progress 帧）→ completed 带输出，exitCode 恒缺席
    const commands = events.filter((e) => e.kind === "command");
    expect(commands.map((c) => (c.kind === "command" ? c.status : ""))).toEqual([
      "started",
      "completed",
    ]);
    const done = commands[1];
    expect(done?.kind === "command" && done.command).toBe("node -v");
    expect(done?.kind === "command" && done.output).toContain("v24.15.0");
    expect(done?.kind === "command" && done.exitCode).toBeUndefined();

    // 文本：answer 增量 + finalize 补 final 收尾
    const texts = events.filter((e) => e.kind === "text" && e.channel === "answer");
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.at(-1)?.kind === "text" && texts.at(-1)).toMatchObject({ final: true });

    // end 恰一条且在最后：end_turn + 零阻断 → completed
    const last = events.at(-1);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
    expect(last?.kind === "end" && last.reason).toBe("completed");
  });

  it("权限 allow：permission_request 带 diff 预览 → 回执选 proceed_once → 工具落地 → completed", async () => {
    const wire = await loadWire("real-acp-permission-allow.wire.jsonl");
    const { events, received } = await runTurn(wire, { onPermission: "allow" });

    const request = events.find((e) => e.kind === "permission_request");
    expect(request?.kind === "permission_request" && request.payload).toEqual({
      kind: "write_path",
      path: "hello-perm.txt",
    });
    expect(request?.kind === "permission_request" && request.diff).toContain("+hello");
    expect(request?.kind === "permission_request" && request.reason).toBe(
      "Write to hello-perm.txt",
    );

    // wire 回执：恒选 *_once（fixture 录制时选了 proceed_always——本适配器纪律更严）
    expect(permissionOptionId(received)).toBe("proceed_once");

    const change = events.find((e) => e.kind === "file_change" && e.status === "completed");
    expect(change?.kind === "file_change" && change.diff).toContain("+hello");
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("completed");
  });

  it("权限 reject（坑 2 防线）：无 failed 事件也要记账——denied 事件 + end_turn 改判 failed", async () => {
    const wire = await loadWire("real-acp-permission-reject.wire.jsonl");
    const { events, received } = await runTurn(wire, { onPermission: "deny" });

    // wire 回执选 reject_once（optionId=cancel）
    expect(permissionOptionId(received)).toBe("cancel");

    // fixture 实证：拒绝后 wire 上零 tool_call 事件——denied 动作由权限桥合成
    const denied = events.find((e) => e.kind === "file_change" && e.status === "denied");
    expect(denied?.kind === "file_change" && denied.path).toBe("hello-perm.txt");

    // prompt 照样 end_turn（fixture 末行），但阻断记账把它改判 failed
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("failed");
    expect(end?.kind === "end" && end.message).toContain("hello-perm.txt");
    expect(end?.kind === "end" && end.message).toContain("权限桥记账");
  });

  it("优雅取消：session/cancel 通知 → prompt 以 stopReason=cancelled 落定 → end cancelled", async () => {
    const wire = await loadWire("real-acp-cancel.wire.jsonl");
    // fixture 的 prompt 无 result 行（被 cancel 落定），cancelSettlesPrompt 复现该时序
    const { events, received } = await runTurn(wire, {
      cancelSettlesPrompt: true,
      cancelAfterFirstEvent: true,
    });
    expect(received.some((m) => m["method"] === "session/cancel")).toBe(true);
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("cancelled");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });

  it("session/load 恢复：sessionId 取 resume 绑定（headless 建的会话可加载——两模式互通）", async () => {
    const wire = await loadWire("real-acp-load.wire.jsonl");
    // load fixture 无 prompt 段：合成一个空转 end_turn 收尾
    const withPrompt: WireFixture = { ...wire, promptResult: { stopReason: "end_turn" } };
    const resumeId = "session-988e2ab6-fcc6-45d7-954b-9a687c1513bd";
    const { events, received } = await runTurn(withPrompt, {
      resume: { nativeSessionId: resumeId, cwd: CWD },
    });
    const load = received.find((m) => m["method"] === "session/load");
    const loadParams = (load?.["params"] ?? {}) as Record<string, unknown>;
    expect(loadParams["sessionId"]).toBe(resumeId);
    expect(received.some((m) => m["method"] === "session/new")).toBe(false);
    const start = events.find((e) => e.kind === "session_start");
    expect(start?.kind === "session_start" && start.native?.nativeSessionId).toBe(resumeId);
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("completed");
  });

  it("未认证快速失败第一道闸：isAuthenticated=false 当场收，session/new 不发", async () => {
    const wire = await loadWire("real-acp-noauth.wire.jsonl");
    const { events, received } = await runTurn(wire);
    expect(received.some((m) => m["method"] === "session/new")).toBe(false);
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("failed");
    expect(end?.kind === "end" && end.message).toBe(IFLOW_NOAUTH_MESSAGE);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });

  it("noauth 兜底闸：initialize 撒谎报已认证时，session/new 的 -32000 仍收敛为 failed", async () => {
    const wire = await loadWire("real-acp-noauth.wire.jsonl");
    const lying: WireFixture = {
      ...wire,
      initResult: { ...wire.initResult, isAuthenticated: true },
    };
    const { events } = await runTurn(lying);
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("failed");
    expect(end?.kind === "end" && end.message).toContain("Authentication required");
  });

  it("set_mode 纪律闸失败即本轮失败（fail-closed：绝不带 yolo 跑），prompt 不发", async () => {
    const wire = await loadWire("real-acp-success.wire.jsonl");
    const { events, received } = await runTurn(wire, {
      setModeError: { code: -32601, message: "Method not found" },
    });
    expect(received.some((m) => m["method"] === "session/prompt")).toBe(false);
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("failed");
    expect(end?.kind === "end" && end.message).toContain("set_mode");
  });
});

/* ------------------------------------------------------------------ *
 * 适配器本体。
 * ------------------------------------------------------------------ */

describe("适配器本体", () => {
  let managedHome: string;

  beforeAll(async () => {
    managedHome = await mkdtemp(join(tmpdir(), "ff-pane-iflow-home-"));
  });

  afterAll(async () => {
    await rm(managedHome, { recursive: true, force: true });
  });

  it("能力六项声明（ACP 单通道；streaming 真增量未证实前如实报 partial）", () => {
    const adapter = createIFlowAdapter();
    expect(adapter.runtime).toBe(IFLOW_RUNTIME);
    expect(adapter.capabilities()).toEqual(IFLOW_CAPABILITIES);
    expect(IFLOW_CAPABILITIES).toEqual({
      nativeResume: "yes",
      streaming: "partial",
      fileChangeEvents: "yes",
      commandEvents: "partial",
      permissionForwarding: "yes",
      gracefulCancel: "yes",
    });
  });

  it("resume cwd 不一致：启动前快速失败，零 spawn", async () => {
    const { spawn, specs } = rig([]);
    const adapter = createIFlowAdapter({ spawn });
    const turn = adapter.startTurn({
      cwd: "C:\\proj-a",
      prompt: "hi",
      resume: { nativeSessionId: "session-x", cwd: "C:\\proj-b" } as never,
    });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(specs).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "end" && events[0].reason).toBe("failed");
    expect(events[0]?.kind === "end" && events[0].message).toContain("cwd");
  });

  it("受管 HOME：startTurn 落静态 settings + spec.env 双变量替换 + 模型预占", async () => {
    const wire = await loadWire("real-acp-success.wire.jsonl");
    const fake = createFakeIFlowProcess({ wire });
    const { spawn, specs } = rig([fake]);
    const adapter = createIFlowAdapter({ spawn, managedHome, acpControlTimeoutMs: 3_000 });
    const turn = adapter.startTurn({
      cwd: CWD,
      prompt: "p",
      model: "glm-5" as never,
      env: { IFLOW_API_KEY: "sk-managed", IFLOW_BASE_URL: "http://127.0.0.1:1/v1" },
    });
    for await (const event of turn.events) {
      void event;
    }
    const settingsPath = join(managedHome, ".iflow", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(IFLOW_MANAGED_SETTINGS_JSON);
    const env = specs[0]?.env ?? {};
    expect(env["USERPROFILE"]).toBe(managedHome);
    expect(env["HOME"]).toBe(managedHome);
    expect(env["IFLOW_MODEL_NAME"]).toBe("glm-5");
    expect(env["IFLOW_API_KEY"]).toBe("sk-managed");
    expect(specs[0]?.args).toEqual(["--experimental-acp"]);
    expect(specs[0]?.stdin).toBe("pipe");
  });

  it("spawn 失败（可执行缺失）：end failed 如实收尾——ACP 单通道无降级路径", async () => {
    const exit: AgentProcessExit = {
      kind: "spawn-failed",
      exitCode: null,
      signal: null,
      error: "ENOENT: iflow 不存在",
      errorCode: "ENOENT",
    };
    const dead = new PassThrough();
    dead.end();
    const deadErr = new PassThrough();
    deadErr.end();
    const handle: AgentProcessHandle = {
      pid: undefined,
      stdout: dead,
      stderr: deadErr,
      stdin: null,
      exitPromise: Promise.resolve(exit),
      resolvedCommand: "iflow",
      viaCmdShim: false,
      strippedEnvNames: [],
      kill: () => Promise.resolve(exit),
    };
    const adapter = createIFlowAdapter({ spawn: () => handle, acpControlTimeoutMs: 500 });
    const turn = adapter.startTurn({ cwd: CWD, prompt: "p" });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    const end = events.at(-1);
    expect(end?.kind === "end" && end.reason).toBe("failed");
    expect(end?.kind === "end" && end.message).toContain("stdin 不可用");
    expect(events.filter((e) => e.kind === "end")).toHaveLength(1);
  });
});
