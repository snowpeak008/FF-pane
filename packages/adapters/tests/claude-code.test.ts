/**
 * W2.4 Claude Code 适配器测试：9 组真机 fixture 回放 + 双向控制协议（权限回执 /
 * interrupt）的组装与解析。
 *
 * 两条原则：
 * 1. **回放的是录制证据本身。** fixtures/claude-code/ 是 2.1.220 的真机录制，
 *    逐字节喂给适配器（按 97 字节奇数块切，顺带压行解码器的跨块半行路径）。
 * 2. **写回 stdin 的内容与录制的 client-input 逐字段比对。** 权限回执与 interrupt
 *    请求是"我们发给 CLI"的一侧，fixture 里存着当时真机用的两行，组装结果必须
 *    与之等价，否则协议改了自己却不知道。
 *
 * 假 stdin/stdout 经 options.spawn 注入：进程层（W2.1a）已有自己的测试，这里
 * 要验的是协议与映射，不重复跑真 CLI（真机冒烟在工单报告里另行执行）。
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { PassThrough, Writable } from "node:stream";
import type { NativeSessionId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import type {
  AdapterTurn,
  AgentEvent,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
  ClaudeCodeAdapterOptions,
  CommandEvent,
  EndEvent,
  FileChangeEvent,
  PermissionRequestEvent,
  TextEvent,
} from "../src/index.js";
import {
  ByteChunkQueue,
  buildInterruptRequest,
  buildPermissionResponse,
  buildUserMessage,
  CLAUDE_CODE_BASE_ARGS,
  CLAUDE_CODE_HIDDEN_ARGS,
  CLAUDE_CODE_PERMISSION_PROMPT_ARGS,
  ClaudeCodeProtocolError,
  createClaudeCodeAdapter,
  createClaudeCodeMapperState,
  formatStructuredPatch,
  isKnownRuntime,
  mapClaudeCodeRecord,
  parseJsonlLine,
  splitLines,
  toPermissionPayload,
} from "../src/index.js";

const FIXTURES = new URL("../fixtures/claude-code/", import.meta.url);

/** fixture 是只读证据，一律按字节读入。 */
function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

function fixtureLines(name: string): string[] {
  return splitLines(fixtureText(name)).filter((line) => line.trim() !== "");
}

function parseLine(line: string): Record<string, unknown> {
  const record = parseJsonlLine(line, 1);
  if (record === undefined || !record.ok) {
    throw new Error(`fixture 行不是 JSON：${line.slice(0, 80)}`);
  }
  return record.value;
}

/** 录制目录 a（fixture 01/02 的 cwd），resume 校验要用同一个值。 */
const RECORDED_CWD_A = "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-cc-rec\\a";
const RECORDED_CWD_C = "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-cc-rec\\c";
const RECORDED_SESSION_A = "9e228810-a71a-4268-88a7-d8b0b667b41f";

interface FakeProcess {
  readonly handle: AgentProcessHandle;
  /** 已写入 stdin 的整行（原文）。 */
  readonly stdinLines: string[];
  killCount: number;
  /** 往 stdout 推文本（自动补换行）。 */
  pushLines(lines: readonly string[]): void;
  /** 按固定块大小往 stdout 推字节（压跨块半行）。 */
  pushBytes(bytes: Uint8Array, chunkSize: number): void;
  /** stdout EOF（不动退出状态）。 */
  endStdout(): void;
  /** 模拟外部硬杀：stdout 戛然而止 + 进程消亡。 */
  hardKill(exitCode: number): void;
  /** stdin 写入满 count 行时兑现。 */
  waitForStdin(count: number): Promise<void>;
}

/**
 * 假 CLI 进程：stdout 走真的 ByteChunkQueue（与生产同一条背压路径），
 * stdin 收整行供断言；stdin 关闭即"进程退出"，模拟 CLI 收到 EOF 后自然收场。
 */
function createFakeProcess(autoExitCode = 0): FakeProcess {
  // stdout 走真的 PassThrough + ByteChunkQueue：分块与背压路径与生产完全同一条。
  const stdoutSource = new PassThrough();
  const stdout = new ByteChunkQueue(stdoutSource);

  const stdinLines: string[] = [];
  let waiters: { count: number; resolve: () => void }[] = [];
  let settled = false;
  let settleExit!: (exit: AgentProcessExit) => void;
  const exitPromise = new Promise<AgentProcessExit>((resolve) => {
    settleExit = resolve;
  });

  function settle(exit: AgentProcessExit): void {
    if (settled) {
      return;
    }
    settled = true;
    settleExit(exit);
  }

  function pushChunk(chunk: Buffer): void {
    if (!stdoutSource.writableEnded) {
      stdoutSource.write(chunk);
    }
  }

  function closeStdout(): void {
    if (!stdoutSource.writableEnded) {
      stdoutSource.end();
    }
  }

  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of splitLines(chunk.toString("utf8"))) {
        stdinLines.push(line);
      }
      const ready = waiters.filter((waiter) => stdinLines.length >= waiter.count);
      waiters = waiters.filter((waiter) => stdinLines.length < waiter.count);
      for (const waiter of ready) {
        waiter.resolve();
      }
      callback();
    },
    final(callback) {
      // CLI 收到 stdin EOF 后自然退出（与真机一致：录制时 stdin 就是文件重定向）。
      settle({
        kind: "exited",
        exitCode: autoExitCode,
        signal: null,
        error: null,
        errorCode: null,
      });
      closeStdout();
      callback();
    },
  });

  const fake: FakeProcess = {
    handle: {
      pid: 4242,
      stdout,
      stderr: new ByteChunkQueue(null),
      stdin,
      exitPromise,
      resolvedCommand: "C:\\fake\\claude.exe",
      viaCmdShim: false,
      strippedEnvNames: [],
      kill: async (): Promise<AgentProcessExit> => {
        fake.killCount += 1;
        settle({ kind: "killed", exitCode: 1, signal: null, error: null, errorCode: null });
        closeStdout();
        return exitPromise;
      },
    },
    stdinLines,
    killCount: 0,
    pushLines(lines: readonly string[]): void {
      pushChunk(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
    },
    pushBytes(bytes: Uint8Array, chunkSize: number): void {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        pushChunk(Buffer.from(bytes.subarray(offset, offset + chunkSize)));
      }
    },
    endStdout(): void {
      closeStdout();
    },
    hardKill(exitCode: number): void {
      settle({ kind: "killed", exitCode, signal: null, error: null, errorCode: null });
      closeStdout();
    },
    waitForStdin(count: number): Promise<void> {
      if (stdinLines.length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
  return fake;
}

interface Harness {
  readonly fake: FakeProcess;
  readonly turn: AdapterTurn;
  readonly spec: AgentProcessSpec;
}

function startTurn(
  options: ClaudeCodeAdapterOptions = {},
  ctx: { cwd?: string; prompt?: string; resume?: { id: string; cwd: string }; model?: string } = {},
  autoExitCode = 0,
): Harness {
  const fake = createFakeProcess(autoExitCode);
  let captured: AgentProcessSpec | undefined;
  const adapter = createClaudeCodeAdapter({
    ...options,
    spawn: (spec) => {
      captured = spec;
      return fake.handle;
    },
  });
  const cwd = ctx.cwd ?? RECORDED_CWD_A;
  const turn = adapter.startTurn({
    cwd,
    prompt: ctx.prompt ?? "做点什么",
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    ...(ctx.resume === undefined
      ? {}
      : {
          resume: { nativeSessionId: ctx.resume.id as NativeSessionId, cwd: ctx.resume.cwd },
        }),
  });
  if (captured === undefined) {
    throw new Error("适配器应同步 spawn 子进程");
  }
  return { fake, turn, spec: captured };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

/** 整条 fixture 回放：一次推完 + stdout EOF。 */
async function replay(
  fixture: string,
  options: ClaudeCodeAdapterOptions = {},
  ctx: Parameters<typeof startTurn>[1] = {},
): Promise<{ events: AgentEvent[]; harness: Harness }> {
  const harness = startTurn(options, ctx);
  harness.fake.pushBytes(fixtureBytes(fixture), 97);
  harness.fake.endStdout();
  return { events: await collect(harness.turn.events), harness };
}

function kindsOf(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.kind);
}

/** raw 是留档通道，断言主线时先滤掉。 */
function meaningful(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.kind !== "raw");
}

function endOf(events: readonly AgentEvent[]): EndEvent {
  const last = events.at(-1);
  if (last?.kind !== "end") {
    throw new Error(`事件流必须以 end 收尾，实际收尾为 ${last?.kind ?? "空流"}`);
  }
  if (events.filter((event) => event.kind === "end").length !== 1) {
    throw new Error("事件流必须恰好一条 end");
  }
  return last;
}

describe("启动参数与进程形态", () => {
  it("地基参数齐备：-p + 双向 stream-json + verbose + stdio 权限转发 + stdin 管道", async () => {
    const { harness } = await replay("01-basic-write-bash.jsonl");
    const args = harness.spec.args ?? [];
    expect(args.slice(0, CLAUDE_CODE_BASE_ARGS.length)).toStrictEqual([...CLAUDE_CODE_BASE_ARGS]);
    expect(args).toContain("--permission-prompt-tool");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(harness.spec.stdin).toBe("pipe");
    expect(harness.spec.cwd).toBe(RECORDED_CWD_A);
    expect(harness.spec.command).toBe("claude");
    // 未开 --include-partial-messages：文本走整块，避免与增量重复。
    expect(args).not.toContain("--include-partial-messages");
  });

  it("提示词经 stdin 的 user 消息下发，与录制的 client-input 首行等价", async () => {
    const prompt =
      "Create a file p.txt with content x using the Write tool. Then reply with one word: done";
    const { harness } = await replay(
      "04-permission-stdio.jsonl",
      {},
      { cwd: RECORDED_CWD_C, prompt },
    );
    const recorded = fixtureLines("04-permission-stdio.client-input.jsonl");
    expect(parseLine(harness.fake.stdinLines[0] ?? "")).toStrictEqual(parseLine(recorded[0] ?? ""));
  });

  it("可选参数按需下发，隐藏参数集中登记以便升级后复验", async () => {
    const { harness } = await replay(
      "01-basic-write-bash.jsonl",
      {
        allowedTools: ["Write", "Bash(git *)"],
        maxTurns: 8,
        maxBudgetUsd: 0.5,
        permissionMode: "acceptEdits",
        settingSources: ["user"],
        strictMcpConfig: true,
        appendSystemPrompt: "你是 Worker",
        extraArgs: ["--effort", "low"],
      },
      { model: "haiku" },
    );
    const args = [...(harness.spec.args ?? [])];
    expect(args).toStrictEqual([
      ...CLAUDE_CODE_BASE_ARGS,
      ...CLAUDE_CODE_PERMISSION_PROMPT_ARGS,
      "--model",
      "haiku",
      "--allowedTools",
      "Write",
      "Bash(git *)",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "8",
      "--max-budget-usd",
      "0.5",
      "--append-system-prompt",
      "你是 Worker",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--effort",
      "low",
    ]);
    expect(CLAUDE_CODE_HIDDEN_ARGS).toStrictEqual(["--permission-prompt-tool", "--max-turns"]);
  });

  it.runIf(process.platform === "win32")(
    "Windows 下显式给出归一化基底环境（PATH 键名大小写陷阱，见 adapter.ts windowsBaseEnv）",
    async () => {
      const { harness } = await replay("01-basic-write-bash.jsonl");
      const baseEnv = harness.spec.baseEnv;
      // 真实键名是 "Path"，拷进普通对象后 env["PATH"] 会是 undefined，
      // 进程层就扫不到 PATH。这里必须留下大写键，且不得出现大小写重复键。
      expect(baseEnv?.["PATH"]).toBe(process.env["PATH"]);
      expect(Object.keys(baseEnv ?? {}).filter((name) => /^path$/i.test(name))).toStrictEqual([
        "PATH",
      ]);
      expect(Object.keys(baseEnv ?? {}).filter((name) => /^pathext$/i.test(name))).toStrictEqual([
        "PATHEXT",
      ]);
    },
  );

  it("装配期参数非法即抛（maxTurns / maxBudgetUsd）", () => {
    expect(() => createClaudeCodeAdapter({ maxTurns: 0 })).toThrow(RangeError);
    expect(() => createClaudeCodeAdapter({ maxTurns: 1.5 })).toThrow(RangeError);
    expect(() => createClaudeCodeAdapter({ maxBudgetUsd: 0 })).toThrow(RangeError);
  });
});

describe("fixture 01：基础序列（Write + Bash + 文本总结）", () => {
  it("session_start → 文件修改 → 命令执行 → 文本 → end(completed)", async () => {
    const { events } = await replay("01-basic-write-bash.jsonl");
    expect(kindsOf(meaningful(events))).toStrictEqual([
      "session_start",
      "text",
      "file_change",
      "file_change",
      "text",
      "command",
      "command",
      "text",
      "text",
      "end",
    ]);
    // 8 条 thinking_tokens + 4 + 3 条 system 噪声全部走 raw，一条不丢。
    expect(events.filter((event) => event.kind === "raw")).toHaveLength(15);

    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native).toStrictEqual({
      nativeSessionId: RECORDED_SESSION_A,
      cwd: RECORDED_CWD_A,
    });
    expect(start.model).toBe("claude-haiku-4-5-20251001");

    const fileChanges = events.filter(
      (event): event is FileChangeEvent => event.kind === "file_change",
    );
    expect(fileChanges.map((event) => event.status)).toStrictEqual(["started", "completed"]);
    expect(fileChanges[1]).toStrictEqual({
      kind: "file_change",
      path: `${RECORDED_CWD_A}\\hello.txt`,
      changeKind: "add",
      status: "completed",
      actionId: "toolu_01UEqZdZWLfx82ALmfzD5NA1",
    });
    // Write 新建：structuredPatch 为空数组 → diff 如实缺席，不造假空 diff。
    expect(fileChanges[1]).not.toHaveProperty("diff");

    const commands = events.filter((event): event is CommandEvent => event.kind === "command");
    expect(commands.map((event) => event.status)).toStrictEqual(["started", "completed"]);
    expect(commands[1]).toStrictEqual({
      kind: "command",
      command: "cat hello.txt",
      status: "completed",
      exitCode: 0,
      output: "hello",
      actionId: "toolu_018R4fkp4ocHth5Y8ZGMNstT",
    });

    const end = endOf(events);
    expect(end.reason).toBe("completed");
    expect(end.usage).toStrictEqual({
      inputTokens: 35,
      outputTokens: 446,
      cachedInputTokens: 65980,
      costUsd: 0.07543100000000001,
    });
  });

  it("同一 message.id 的多行共享 messageId（消费方据此去重聚合）", async () => {
    const { events } = await replay("01-basic-write-bash.jsonl");
    const texts = events.filter((event): event is TextEvent => event.kind === "text");
    expect(texts.map((event) => event.channel)).toStrictEqual([
      "reasoning",
      "reasoning",
      "reasoning",
      "answer",
    ]);
    expect(texts.every((event) => event.final)).toBe(true);
    // 第 3、4 条是同一条 API 消息的 thinking 块与 text 块（fixture 第 23/24 行）。
    expect(texts[2]?.messageId).toBe("msg_011CeWmb3wSMez2dJGJ4ZrdV");
    expect(texts[3]?.messageId).toBe("msg_011CeWmb3wSMez2dJGJ4ZrdV");
    // 每个 tool_use / 文本块各自独立成事件，但 messageId 把它们收敛回一条消息。
    const fileStart = events.find(
      (event): event is FileChangeEvent =>
        event.kind === "file_change" && event.status === "started",
    );
    expect(fileStart?.actionId).toBe("toolu_01UEqZdZWLfx82ALmfzD5NA1");
  });
});

describe("fixture 02：原生会话恢复 + Edit 的 structuredPatch", () => {
  it("cwd 一致时下发 --resume，session_id 原样延续", async () => {
    const { events, harness } = await replay(
      "02-resume-edit.jsonl",
      {},
      { resume: { id: RECORDED_SESSION_A, cwd: RECORDED_CWD_A } },
    );
    const args = harness.spec.args ?? [];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(RECORDED_SESSION_A);

    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native?.nativeSessionId).toBe(RECORDED_SESSION_A);
    expect(endOf(events).reason).toBe("completed");
  });

  it("Edit 的 diff 由 structuredPatch 还原为 unified diff", async () => {
    const { events } = await replay("02-resume-edit.jsonl");
    const edit = events
      .filter((event): event is FileChangeEvent => event.kind === "file_change")
      .find((event) => event.status === "completed");
    expect(edit?.changeKind).toBe("update");
    expect(edit?.diff).toBe(
      [
        `--- ${RECORDED_CWD_A}\\hello.txt`,
        `+++ ${RECORDED_CWD_A}\\hello.txt`,
        "@@ -1,1 +1,1 @@",
        "-hello",
        "\\ No newline at end of file",
        "+hello world",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    // Read 工具不属六类事件，其调用与结果只留档（不伪装成 file_change）。
    expect(
      events.filter((event) => event.kind === "raw" && event.note?.includes("Read")),
    ).toHaveLength(2);
  });
});

describe("fixture 03：默认权限模式下被自动拒绝", () => {
  it("工具记 denied，且 result.permission_denials 非空时绝不记 completed", async () => {
    const { events } = await replay("03-permission-denied.jsonl");
    const fileChanges = events.filter(
      (event): event is FileChangeEvent => event.kind === "file_change",
    );
    expect(fileChanges.map((event) => event.status)).toStrictEqual(["started", "denied"]);
    expect(fileChanges[1]?.path).toBe(
      "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-cc-rec\\b\\test.txt",
    );

    const end = endOf(events);
    // CLI 自己报的是 subtype: "success" / is_error: false —— 只看 subtype 就会误判成功。
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("权限被拒 1 项");
    expect(end.message).toContain("Write");
  });
});

describe("fixture 04：stdio 权限转发闭环", () => {
  it("can_use_tool → PermissionRequestEvent；allow 回执与录制的 client-input 等价", async () => {
    const lines = fixtureLines("04-permission-stdio.jsonl");
    const harness = startTurn({}, { cwd: RECORDED_CWD_C });
    harness.fake.pushLines(lines.slice(0, 9));

    const events: AgentEvent[] = [];
    for await (const event of harness.turn.events) {
      events.push(event);
      if (event.kind === "permission_request") {
        await harness.turn.respondPermission?.(event.nativeRequestId, "allow");
        harness.fake.pushLines(lines.slice(9));
      }
    }

    const request = events.find(
      (event): event is PermissionRequestEvent => event.kind === "permission_request",
    );
    expect(request).toStrictEqual({
      kind: "permission_request",
      nativeRequestId: "ee857bcb-a95f-485f-84d5-dbb8cf2db2a6",
      payload: { kind: "write_path", path: `${RECORDED_CWD_C}\\p.txt` },
      reason: "p.txt",
      toolName: "Write",
    });

    const recorded = parseLine(fixtureLines("04-permission-stdio.client-input.jsonl")[1] ?? "");
    expect(parseLine(harness.fake.stdinLines[1] ?? "")).toStrictEqual(recorded);

    // 批准后任务继续：文件真被创建，末尾 end 为 completed。
    expect(kindsOf(meaningful(events))).toStrictEqual([
      "session_start",
      "text",
      "file_change",
      "permission_request",
      "file_change",
      "text",
      "text",
      "end",
    ]);
    expect(endOf(events).reason).toBe("completed");
  });

  it("deny 回执带说明；同一请求不可重复回执", async () => {
    const lines = fixtureLines("04-permission-stdio.jsonl");
    const harness = startTurn({}, { cwd: RECORDED_CWD_C });
    harness.fake.pushLines(lines.slice(0, 9));

    let requestId = "";
    for await (const event of harness.turn.events) {
      if (event.kind === "permission_request") {
        requestId = event.nativeRequestId;
        await harness.turn.respondPermission?.(requestId, "deny");
        // 拒绝后录制的"批准继续"序列不再适用，直接让 stdout 收口。
        harness.fake.endStdout();
      }
    }

    expect(parseLine(harness.fake.stdinLines[1] ?? "")).toStrictEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "deny", message: "The user denied this tool use in FF-pane." },
      },
    });
    await expect(harness.turn.respondPermission?.(requestId, "allow")).rejects.toBeInstanceOf(
      ClaudeCodeProtocolError,
    );
  });

  it("信封表达不了的工具 fail-closed 自动拒绝（不悬着、不伪装权限类别）", async () => {
    const harness = startTurn({}, { cwd: RECORDED_CWD_C });
    const init = fixtureLines("04-permission-stdio.jsonl")[0] ?? "";
    harness.fake.pushLines([
      init,
      JSON.stringify({
        type: "control_request",
        request_id: "req-task-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Task",
          input: { description: "spawn a subagent" },
        },
      }),
    ]);
    const consuming = collect(harness.turn.events);
    await harness.fake.waitForStdin(2);
    harness.fake.endStdout();
    const events = await consuming;

    expect(parseLine(harness.fake.stdinLines[1] ?? "")).toMatchObject({
      type: "control_response",
      response: { request_id: "req-task-1", response: { behavior: "deny" } },
    });
    expect(events.some((event) => event.kind === "permission_request")).toBe(false);
    expect(
      events.some((event) => event.kind === "raw" && event.note?.includes("无法表达为权限信封")),
    ).toBe(true);
  });
});

/**
 * 录制的 interrupt 回执行带的是当时手工用的 request_id；真机回执必然回显调用方
 * 发出的 ID，故按适配器实际写出的 ID 改写后再喂回去。
 */
function receiptEchoing(sentLine: string, recordedReceiptLine: string): string {
  const sent = parseLine(sentLine);
  const receipt = parseLine(recordedReceiptLine);
  const response = { ...(receipt["response"] as Record<string, unknown>) };
  response["request_id"] = sent["request_id"];
  return JSON.stringify({ ...receipt, response });
}

describe("fixture 05：interrupt 优雅取消", () => {
  it("cancel 先写 interrupt，收到回执后由 result 收尾 cancelled，全程不树杀", async () => {
    const lines = fixtureLines("05-interrupt.jsonl");
    const harness = startTurn({}, { prompt: "sleep 60" }, 1);
    harness.fake.pushLines(lines.slice(0, 16));

    const events: AgentEvent[] = [];
    for await (const event of harness.turn.events) {
      events.push(event);
      if (event.kind === "command" && event.status === "started") {
        await harness.turn.cancel();
        harness.fake.pushLines([
          receiptEchoing(harness.fake.stdinLines[1] ?? "", lines[16] ?? ""),
          ...lines.slice(17),
        ]);
      }
    }

    const written = parseLine(harness.fake.stdinLines[1] ?? "");
    const recorded = parseLine(fixtureLines("05-interrupt.client-input.jsonl")[1] ?? "");
    expect(written).toStrictEqual({
      ...recorded,
      request_id: (written as { request_id: string }).request_id,
    });
    expect((written as { request_id: string }).request_id).toMatch(/^ffpane-interrupt-\d+$/);

    const command = events
      .filter((event): event is CommandEvent => event.kind === "command")
      .at(-1);
    // 被 interrupt 掉的工具是"未执行"，不是"失败"：tool_result_meta 的
    // non_execution_kind 才是判据。
    expect(command?.status).toBe("denied");
    expect(command).not.toHaveProperty("exitCode");

    const end = endOf(events);
    expect(end.reason).toBe("cancelled");
    expect(harness.fake.killCount).toBe(0);
  });

  it("消费方在别处泵流时，cancel 等到回执才返回（不退化成树杀）", async () => {
    const lines = fixtureLines("05-interrupt.jsonl");
    const harness = startTurn({ interruptTimeoutMs: 5_000 }, {}, 1);
    harness.fake.pushLines(lines.slice(0, 16));

    const events: AgentEvent[] = [];
    let markCommand!: () => void;
    const commandSeen = new Promise<void>((resolve) => {
      markCommand = resolve;
    });
    const consuming = (async () => {
      for await (const event of harness.turn.events) {
        events.push(event);
        if (event.kind === "command" && event.status === "started") {
          markCommand();
        }
      }
    })();

    await commandSeen;
    // 让消费方真正停在"等下一个事件"上，cancel 才有机会观察到回执。
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 假 CLI 的行为：一看到 interrupt 请求就回执（真机实测立即回执）。
    void harness.fake.waitForStdin(2).then(() => {
      harness.fake.pushLines([receiptEchoing(harness.fake.stdinLines[1] ?? "", lines[16] ?? "")]);
    });

    await harness.turn.cancel();
    // 回执已被协议层收到 → 不该动树杀；若回执识别失效，5 秒超时后必然 kill。
    expect(harness.fake.killCount).toBe(0);

    harness.fake.pushLines(lines.slice(17));
    await consuming;
    expect(endOf(events).reason).toBe("cancelled");
    expect(harness.fake.killCount).toBe(0);
    // 幂等：重复取消无害。
    await expect(harness.turn.cancel()).resolves.toBeUndefined();
  });

  it("回执迟迟不来 → 超时树杀兜底，事件流仍以 cancelled 收尾", async () => {
    const lines = fixtureLines("05-interrupt.jsonl");
    const harness = startTurn({ interruptTimeoutMs: 40 }, {}, 1);
    harness.fake.pushLines(lines.slice(0, 16));
    const consuming = collect(harness.turn.events);

    await harness.fake.waitForStdin(1);
    await harness.turn.cancel();

    const events = await consuming;
    expect(harness.fake.killCount).toBeGreaterThanOrEqual(1);
    const end = endOf(events);
    expect(end.reason).toBe("cancelled");
    expect(end.exitCode).toBe(1);
  });

  it("init 未声明 interrupt 能力 → 不做无效等待，直接树杀（隐藏协议漂移防御）", async () => {
    const harness = startTurn({}, {}, 1);
    // 构造行：把真机 init 的 capabilities 清空，其余字段照旧。
    const init = { ...parseLine(fixtureLines("05-interrupt.jsonl")[0] ?? ""), capabilities: [] };
    harness.fake.pushLines([JSON.stringify(init)]);
    const consuming = collect(harness.turn.events);

    // 等 session_start 被消费掉（init 已进映射器状态）后再取消。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.turn.cancel();

    const events = await consuming;
    expect(harness.fake.killCount).toBe(1);
    // 只写了提示词，没写 interrupt。
    expect(harness.fake.stdinLines).toHaveLength(1);
    expect(endOf(events).reason).toBe("cancelled");
  });
});

describe("fixture 06：token 级增量流（--include-partial-messages）", () => {
  it("开启时只认 stream_event 增量：delta 为 final:false，块结束补空 content 的 final:true", async () => {
    const { events } = await replay("06-partial-messages.jsonl", {
      includePartialMessages: true,
    });
    const texts = events.filter((event): event is TextEvent => event.kind === "text");
    const answer = texts.filter((event) => event.channel === "answer");
    expect(answer).toStrictEqual([
      {
        kind: "text",
        content: "Streaming test OK.",
        final: false,
        channel: "answer",
        messageId: "msg_011CeWmmUaoHndi3Kgrzudn4",
      },
      {
        kind: "text",
        content: "",
        final: true,
        channel: "answer",
        messageId: "msg_011CeWmmUaoHndi3Kgrzudn4",
      },
    ]);
    // thinking 增量 3 条 + 1 条收尾，全部归 reasoning 通道。
    const reasoning = texts.filter((event) => event.channel === "reasoning");
    expect(reasoning.filter((event) => !event.final)).toHaveLength(3);
    expect(reasoning.filter((event) => event.final)).toHaveLength(1);
    // signature_delta 不是文本增量（是 thinking 块的加密签名），只留档。
    expect(
      events.filter((event) => event.kind === "raw" && event.note?.includes("signature_delta")),
    ).toHaveLength(1);
    // 整条 assistant 行不再产出文本事件（否则与增量重复、token 统计翻倍）。
    expect(texts.filter((event) => event.final && event.content !== "")).toHaveLength(0);
    expect(endOf(events).reason).toBe("completed");
  });

  it("未开启时增量行只留档，文本仍由整块 assistant 行给出", async () => {
    const { events, harness } = await replay("06-partial-messages.jsonl");
    expect(harness.spec.args).not.toContain("--include-partial-messages");
    const texts = events.filter((event): event is TextEvent => event.kind === "text");
    expect(texts.every((event) => event.final)).toBe(true);
    expect(texts.find((event) => event.channel === "answer")?.content).toBe("Streaming test OK.");
    expect(
      events.filter((event) => event.kind === "raw" && event.note?.includes("stream_event 仅留档")),
    ).toHaveLength(12);
  });
});

describe("fixture 07/08/09：截断、超限、跨目录恢复", () => {
  it("07 硬杀无 result：按进程退出兜底合成 end(crashed)", async () => {
    const harness = startTurn();
    harness.fake.pushBytes(fixtureBytes("07-hardkill-truncated.jsonl"), 97);
    harness.fake.hardKill(1);
    const events = await collect(harness.turn.events);

    expect(events.some((event) => event.kind === "session_start")).toBe(true);
    // 最后一个 tool_use 没有配对结果，command 只有 started，不伪造终态。
    const commands = events.filter((event): event is CommandEvent => event.kind === "command");
    expect(commands.map((event) => event.status)).toStrictEqual(["started"]);
    const end = endOf(events);
    expect(end.reason).toBe("crashed");
    expect(end.exitCode).toBe(1);
  });

  it("07 若是本方取消导致的截断 → end(cancelled)，与崩溃区分开", async () => {
    const harness = startTurn({ interruptTimeoutMs: 30 }, {}, 1);
    harness.fake.pushBytes(fixtureBytes("07-hardkill-truncated.jsonl"), 97);
    const consuming = collect(harness.turn.events);
    await harness.fake.waitForStdin(1);
    await harness.turn.cancel();
    const events = await consuming;
    expect(endOf(events).reason).toBe("cancelled");
  });

  it("08 max-turns 超限 → end(failed) 并带 CLI 原文", async () => {
    const { events } = await replay("08-max-turns-exceeded.jsonl");
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toBe("Reached maximum number of turns (1)");
    expect(end.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("09 跨 cwd resume：启动前快速失败，一个进程都不起", async () => {
    const fake = createFakeProcess();
    let spawned = false;
    const adapter = createClaudeCodeAdapter({
      spawn: () => {
        spawned = true;
        return fake.handle;
      },
    });
    const turn = adapter.startTurn({
      cwd: "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-cc-rec\\b",
      prompt: "继续",
      resume: { nativeSessionId: RECORDED_SESSION_A as NativeSessionId, cwd: RECORDED_CWD_A },
    });
    const events = await collect(turn.events);

    expect(spawned).toBe(false);
    expect(kindsOf(events)).toStrictEqual(["end"]);
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("严格绑定 cwd");
    await expect(turn.cancel()).resolves.toBeUndefined();
    await expect(turn.respondPermission?.("x", "allow")).rejects.toBeInstanceOf(
      ClaudeCodeProtocolError,
    );
  });

  it("09 CLI 侧的非 JSON 首行经 raw 上交，流不中断且 end 仍成立", async () => {
    // 同 cwd 传一个已失效的 session_id：CLI 会先吐一行纯文本报错再给 error result。
    const { events } = await replay(
      "09-resume-wrong-cwd.jsonl",
      {},
      { resume: { id: RECORDED_SESSION_A, cwd: RECORDED_CWD_A } },
    );
    const [first] = events;
    if (first?.kind !== "raw") {
      throw new Error("首行非 JSON 应经 raw 通道上交");
    }
    expect(first.native).toBe(
      "No conversation found with session ID: 9e228810-a71a-4268-88a7-d8b0b667b41f",
    );
    expect(endOf(events).reason).toBe("failed");
  });
});

describe("能力声明", () => {
  it("六项按调研实测填报，命令事件的退出码保留点由 status 承载", () => {
    expect(createClaudeCodeAdapter().capabilities()).toStrictEqual({
      nativeResume: "yes",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "yes",
      gracefulCancel: "yes",
    });
    expect(isKnownRuntime(createClaudeCodeAdapter().runtime)).toBe(true);
  });

  it("隐藏参数逃生门：关掉权限转发即如实降级为 no，且不再提供回执方法", async () => {
    const adapter = createClaudeCodeAdapter({ forwardPermissions: false });
    expect(adapter.capabilities().permissionForwarding).toBe("no");
    const { harness } = await replay("01-basic-write-bash.jsonl", { forwardPermissions: false });
    expect(harness.spec.args).not.toContain("--permission-prompt-tool");
    expect(harness.turn.respondPermission).toBeUndefined();
  });
});

describe("映射器纯函数单测", () => {
  it("structuredPatch 为空数组或非法时不造假 diff", () => {
    expect(formatStructuredPatch("a.txt", [])).toBeUndefined();
    expect(formatStructuredPatch("a.txt", undefined)).toBeUndefined();
    expect(formatStructuredPatch("a.txt", "not an array")).toBeUndefined();
    expect(formatStructuredPatch("a.txt", [{ lines: null }])).toBeUndefined();
    expect(
      formatStructuredPatch("a.txt", [
        { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" keep", "-old", "+new"] },
      ]),
    ).toBe("--- a.txt\n+++ a.txt\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n");
  });

  it("工具 → 权限信封载荷：五类各归其位，表达不了的返回 undefined", () => {
    const cwd = "D:\\proj";
    expect(toPermissionPayload("Write", { file_path: "a.txt", content: "x" }, cwd)).toStrictEqual({
      kind: "write_path",
      path: "a.txt",
    });
    expect(toPermissionPayload("NotebookEdit", { notebook_path: "n.ipynb" }, cwd)).toStrictEqual({
      kind: "write_path",
      path: "n.ipynb",
    });
    expect(toPermissionPayload("Bash", { command: "git status" }, cwd)).toStrictEqual({
      kind: "shell_command",
      command: "git status",
    });
    expect(toPermissionPayload("Read", { file_path: "a.txt" }, cwd)).toStrictEqual({
      kind: "read_path",
      path: "a.txt",
    });
    expect(toPermissionPayload("Grep", {}, cwd)).toStrictEqual({ kind: "read_path", path: cwd });
    expect(toPermissionPayload("WebFetch", { url: "https://x.dev" }, cwd)).toStrictEqual({
      kind: "network",
      target: "https://x.dev",
    });
    expect(toPermissionPayload("WebSearch", {}, cwd)).toStrictEqual({ kind: "network" });
    expect(toPermissionPayload("Task", { description: "x" }, cwd)).toBeUndefined();
    expect(toPermissionPayload("CronCreate", {}, cwd)).toBeUndefined();
  });

  it("未知 system subtype / 未知顶层 type / 脏行一律 raw，不中断映射", () => {
    const state = createClaudeCodeMapperState({ cwd: "D:\\proj" });
    const feed = (line: string): readonly AgentEvent[] => {
      const record = parseJsonlLine(line, 1);
      if (record === undefined) {
        throw new Error("空行不该进入映射器");
      }
      return mapClaudeCodeRecord(state, record);
    };
    expect(feed('{"type":"system","subtype":"thinking_tokens","count":3}')[0]?.kind).toBe("raw");
    expect(feed('{"type":"brand_new_event_2027"}')[0]?.kind).toBe("raw");
    expect(feed("这不是 JSON")[0]?.kind).toBe("raw");
    // 脏行之后仍能正常映射（解析器容错的实际意义）。
    expect(feed('{"type":"result","subtype":"success","permission_denials":[]}')[0]).toStrictEqual({
      kind: "end",
      reason: "completed",
    });
  });

  it("控制协议组装/解析是对称的（interrupt / allow / deny / user 消息）", () => {
    expect(buildUserMessage("hi")).toStrictEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    expect(buildInterruptRequest("r1")).toStrictEqual({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "interrupt" },
    });
    expect(buildPermissionResponse("r2", "allow", { a: 1 })).toStrictEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r2",
        response: { behavior: "allow", updatedInput: { a: 1 } },
      },
    });
    expect(buildPermissionResponse("r3", "deny", {}, "no")).toMatchObject({
      response: { response: { behavior: "deny", message: "no" } },
    });
  });
});
