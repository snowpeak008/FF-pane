/**
 * T8.6a Qwen Code 适配器测试。
 *
 * 主体是 **fixture 回放**：packages/adapters/fixtures/qwen-code/*.jsonl 全部为真机
 * 录制（qwen 0.23.0 / Windows 10，模型端为本地假服务，性质见该目录 README），
 * 逐组断言映射结果——CLI 升级后重录 fixture 即可立刻发现词汇漂移。
 *
 * 断言的重心不是"字段搬运对不对"，而是三件会造成事实错误的事（调研 §8）：
 * 1. API 错误升格文本（`[API Error:`）**不能**被记成成功——qwen 连退出码信号都没有；
 * 2. `result.permission_denials` 非空的轮**不能**被记成成功（结构化判据），
 *    被拒动作要从 is_error 里辨认出来并归到 `denied`；
 * 3. result 已到达时退出码不参与成败判定（Windows 退出期 libuv 崩溃 0xC0000409
 *    发生在 result 落出之后——非零退出码不得把成功轮误判失败）。
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentEvent, QwenTurnOutcome } from "../src/index.js";
import {
  buildQwenCommand,
  createQwenCodeAdapter,
  createQwenEventMapper,
  isKnownRuntime,
  KNOWN_RUNTIMES,
  planQwenSession,
  QWEN_CODE_CAPABILITIES,
  QWEN_CODE_RUNTIME,
  QwenCommandError,
  readJsonlStream,
  renderQwenEditDiff,
} from "../src/index.js";

/** fixture 录制目录（fixture 内的绝对路径以此为根，已脱敏为 C:\Users\USER）。 */
const FIXTURE_CWD = "C:/Users/USER/AppData/Local/Temp/ffpane-qwen-rec";

/** success 与 resume 是同一会话（fixture README：session_id 为显式指定的样例值）。 */
const SUCCESS_SESSION_ID = "2d2a0f7e-3333-4444-8555-666677778888";

const NORMAL_EXIT: QwenTurnOutcome = {
  endKind: "exited",
  exitCode: 0,
  cancelRequested: false,
};

async function* singleChunk(text: string): AsyncGenerator<string> {
  yield text;
}

/** 回放一组 fixture：真 JSONL 管道（W2.1b）+ 映射器 + finish 收尾。 */
async function replay(
  fixture: string,
  outcome: QwenTurnOutcome = NORMAL_EXIT,
): Promise<AgentEvent[]> {
  const text = await readFile(new URL(`../fixtures/qwen-code/${fixture}`, import.meta.url), "utf8");
  const mapper = createQwenEventMapper({ cwd: FIXTURE_CWD });
  const events: AgentEvent[] = [];
  for await (const record of readJsonlStream(singleChunk(text))) {
    events.push(...mapper.map(record));
  }
  events.push(...mapper.finish(outcome));
  return events;
}

function only<K extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
}

describe("qwen-code 命令行组装", () => {
  it("固定携带 stream-json + partial + 显式审批模式 + auth-type + safe-mode", () => {
    const args = buildQwenCommand({ approvalMode: "yolo", sessionId: "u-1" });
    expect(args).toEqual([
      "-o",
      "stream-json",
      "--include-partial-messages",
      "--approval-mode",
      "yolo",
      "--auth-type",
      "openai",
      "--safe-mode",
      "--session-id",
      "u-1",
    ]);
  });

  it("恢复：只传 --resume（与 --session-id 互斥，同时给即快速失败）", () => {
    const args = buildQwenCommand({ approvalMode: "plan", resumeSessionId: "r-1" });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(() =>
      buildQwenCommand({ approvalMode: "plan", sessionId: "u-1", resumeSessionId: "r-1" }),
    ).toThrow(QwenCommandError);
  });

  it("model / max-session-turns / include-directories / extraArgs 逐项下发", () => {
    const args = buildQwenCommand({
      approvalMode: "yolo",
      sessionId: "u-1",
      model: "qwen3-coder-plus" as never,
      maxSessionTurns: 30,
      includeDirectories: ["D:\\docs", "D:\\src"],
      extraArgs: ["--debug"],
    });
    expect(args).toEqual(
      expect.arrayContaining(["-m", "qwen3-coder-plus", "--max-session-turns", "30", "--debug"]),
    );
    expect(args.filter((a) => a === "--include-directories")).toHaveLength(2);
  });

  it("safeMode: false 时不下发 --safe-mode（用户要 hooks/extensions 的逃生门）", () => {
    const args = buildQwenCommand({ approvalMode: "yolo", sessionId: "u-1", safeMode: false });
    expect(args).not.toContain("--safe-mode");
  });

  it("maxSessionTurns 非正整数即快速失败", () => {
    expect(() =>
      buildQwenCommand({ approvalMode: "yolo", sessionId: "u-1", maxSessionTurns: 0 }),
    ).toThrow(QwenCommandError);
  });

  it("会话裁决：无 resume 生成新 ID；resume 的 cwd 不一致启动前快速失败", () => {
    const fresh = planQwenSession({
      cwd: "C:\\proj",
      newSessionId: () => "gen-1",
      isSameCwd: () => true,
    });
    expect(fresh).toEqual({ sessionId: "gen-1" });

    expect(() =>
      planQwenSession({
        cwd: "C:\\proj-b",
        resume: { nativeSessionId: "s-1" as never, cwd: "C:\\proj-a" },
        newSessionId: () => "gen-2",
        isSameCwd: (a, b) => a === b,
      }),
    ).toThrow(/工作目录/);
  });
});

describe("qwen-code edit diff 渲染", () => {
  it("old/new 片段渲染为单 hunk 替换视图", () => {
    const diff = renderQwenEditDiff("const a = 1;", "const a = 2;");
    expect(diff).toContain("-const a = 1;");
    expect(diff).toContain("+const a = 2;");
  });

  it("新增内容（old 为空串）不产出凭空的删除行", () => {
    const diff = renderQwenEditDiff("", "hello");
    expect(diff).not.toMatch(/^-/m);
    expect(diff).toContain("+hello");
  });

  it("新旧一致 → 不产出空 diff", () => {
    expect(renderQwenEditDiff("same", "same")).toBeUndefined();
  });
});

describe("qwen-code fixture 回放：成功流", () => {
  it("session_start 首发且带原生绑定（ID 与 cwd 成对）", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const starts = only(events, "session_start");
    expect(starts).toHaveLength(1);
    expect(events[0]?.kind).toBe("session_start");
    expect(starts[0]?.native).toEqual({
      nativeSessionId: SUCCESS_SESSION_ID,
      cwd: FIXTURE_CWD,
    });
  });

  it("文件写入事件带路径与 add 类型（write_file 无 diff——不自造）", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const changes = only(events, "file_change");
    expect(changes).toHaveLength(2); // started + completed
    expect(changes[0]?.status).toBe("started");
    expect(changes[1]?.status).toBe("completed");
    expect(changes[1]?.path).toContain("hello.txt");
    expect(changes[1]?.changeKind).toBe("add");
    expect(changes[1]?.diff).toBeUndefined();
    expect(changes[1]?.actionId).toBe("call_w1");
  });

  it("命令事件带命令原文与输出，exitCode 恒缺席（无结构化字段）", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const commands = only(events, "command");
    expect(commands).toHaveLength(2);
    expect(commands[1]?.command).toBe("node -v");
    expect(commands[1]?.status).toBe("completed");
    expect(commands[1]?.output).toBe("v24.15.0");
    expect(commands[1]?.exitCode).toBeUndefined();
  });

  it("文本走 stream_event 增量一路（真增量 + final 收尾），assistant 行 text 块不重复产出", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const texts = only(events, "text").filter((t) => t.channel === "answer");
    const increments = texts.filter((t) => !t.final);
    expect(increments.map((t) => t.content).join("")).toBe(
      "Created hello.txt and checked the Node version.",
    );
    // 若 assistant 行 text 块也产出，全文会出现两遍
    expect(increments).toHaveLength(2);
    expect(texts[texts.length - 1]?.final).toBe(true);
  });

  it("end 恰好一条、reason=completed、带 usage 汇总", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const ends = only(events, "end");
    expect(ends).toHaveLength(1);
    expect(events[events.length - 1]?.kind).toBe("end");
    expect(ends[0]?.reason).toBe("completed");
    expect(ends[0]?.usage?.totalTokens).toBe(2571);
  });

  it("goal_state 等非骨架 stream_event 落 raw 留档不丢证据", async () => {
    const events = await replay("real-stream-json-success.jsonl");
    const raws = only(events, "raw");
    expect(raws.some((r) => (r.note ?? "").includes("goal_state"))).toBe(true);
  });
});

describe("qwen-code fixture 回放：恢复会话", () => {
  it("resume 轮的 session_id 与首轮一致（真机验证：不新开会话）", async () => {
    const events = await replay("real-stream-json-resume.jsonl");
    const starts = only(events, "session_start");
    expect(starts[0]?.native?.nativeSessionId).toBe(SUCCESS_SESSION_ID);
    expect(only(events, "end")[0]?.reason).toBe("completed");
  });
});

describe("qwen-code fixture 回放：权限拒绝（伪装成功防线）", () => {
  it("default 模式：被拒动作记 denied，整轮 failed 而非 completed（退出码仍是 0）", async () => {
    const events = await replay("real-stream-json-headless-deny.jsonl");
    const changes = only(events, "file_change");
    expect(changes.some((c) => c.status === "denied")).toBe(true);
    const commands = only(events, "command");
    expect(commands.some((c) => c.status === "denied")).toBe(true);

    // result.subtype 是 "success"、is_error 是 false、进程退出码 0——
    // 全靠 permission_denials 结构化判据改判
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("write_file");
    expect(end?.message).toContain("run_shell_command");
  });
});

describe("qwen-code fixture 回放：API 错误伪装成功防线", () => {
  it("[API Error: 文本标记 → 整轮 failed（result 报 success、退出码 0 都不算数）", async () => {
    const events = await replay("real-stream-json-api-error.jsonl");
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("API Error");
  });
});

describe("qwen-code fixture 回放：错误与截断", () => {
  it("auth 缺失：单行 result(error_during_execution) → failed 并保留原文", async () => {
    const events = await replay("real-stream-json-auth-missing.jsonl", {
      endKind: "exited",
      exitCode: 1,
      cancelRequested: false,
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("No auth type is selected");
    expect(end?.exitCode).toBe(1);
  });

  it("强杀：流停在 goal_state 无 result → 主动取消记 cancelled", async () => {
    const events = await replay("real-stream-json-killed.jsonl", {
      endKind: "killed",
      exitCode: null,
      cancelRequested: true,
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("cancelled");
    // 强杀前 init 已到：session_start 已带原生绑定（中断轮凭据可用，调研 §4）
    expect(only(events, "session_start")[0]?.native?.nativeSessionId).toBe(
      "5a5d3ca1-6666-4777-8888-99990000aaaa",
    );
  });

  it("非主动取消的截断 → crashed；spawn 失败 → crashed 且带说明", async () => {
    const killed = await replay("real-stream-json-killed.jsonl", {
      endKind: "killed",
      exitCode: null,
      cancelRequested: false,
    });
    expect(only(killed, "end")[0]?.reason).toBe("crashed");

    const mapper = createQwenEventMapper({ cwd: FIXTURE_CWD });
    const spawnFailed = mapper.finish({
      endKind: "spawn-failed",
      exitCode: null,
      cancelRequested: false,
      processError: "spawn qwen ENOENT",
    });
    const end = only([...spawnFailed], "end")[0];
    expect(end?.reason).toBe("crashed");
    expect(end?.message).toContain("ENOENT");
  });

  it("result 已到达时退出码不参与成败判定（退出期 libuv 崩溃 0xC0000409 不误判）", async () => {
    const events = await replay("real-stream-json-success.jsonl", {
      endKind: "exited",
      exitCode: -1073740791,
      cancelRequested: false,
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("completed");
    expect(end?.exitCode).toBe(-1073740791); // 原样留档，不参与判定
  });

  it("result 缺席时退出码照常留档、按截断收 crashed", async () => {
    const events = await replay("real-stream-json-killed.jsonl", {
      endKind: "exited",
      exitCode: 1,
      cancelRequested: false,
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("crashed");
    expect(end?.message).toContain("result");
    expect(end?.exitCode).toBe(1);
  });

  it("脏行与未知信封类型经 raw 通道上交，解析不中断", async () => {
    const mapper = createQwenEventMapper({ cwd: FIXTURE_CWD });
    const lines = [
      "not-json-at-all",
      JSON.stringify({ type: "mystery_event", data: 1 }),
      JSON.stringify({ type: "system", subtype: "future_subtype" }),
    ].join("\n");
    const events: AgentEvent[] = [];
    for await (const record of readJsonlStream(singleChunk(lines))) {
      events.push(...mapper.map(record));
    }
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.kind === "raw")).toBe(true);
  });
});

describe("qwen-code 适配器本体", () => {
  it("能力声明与调研结论一致（六项，逐项有据）", () => {
    const adapter = createQwenCodeAdapter();
    expect(adapter.capabilities()).toEqual(QWEN_CODE_CAPABILITIES);
    expect(QWEN_CODE_CAPABILITIES).toEqual({
      nativeResume: "yes",
      streaming: "yes",
      fileChangeEvents: "partial",
      commandEvents: "partial",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
  });

  it("不实现 respondPermission（单发 headless 无审批回执通道）", () => {
    const adapter = createQwenCodeAdapter();
    const turn = adapter.startTurn({
      cwd: "C:\\repo",
      prompt: "hi",
      // resume 的 cwd 不一致 → 启动前失败，不会真 spawn
      resume: { nativeSessionId: "s-1" as never, cwd: "C:\\other" },
    });
    expect(turn.respondPermission).toBeUndefined();
  });

  it("resume 绑定的 cwd 与本轮不一致 → 启动前失败，不 spawn", async () => {
    let spawned = 0;
    const adapter = createQwenCodeAdapter({
      spawn: () => {
        spawned += 1;
        throw new Error("不应到达");
      },
    });
    const turn = adapter.startTurn({
      cwd: "C:\\proj-b",
      prompt: "hi",
      resume: { nativeSessionId: "s-1" as never, cwd: "C:\\proj-a" },
    });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(spawned).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    expect((events[0] as { message?: string }).message).toContain("工作目录");
  });

  it("registry 键与展示名；qwen-code 已入 KNOWN_RUNTIMES", () => {
    const adapter = createQwenCodeAdapter();
    expect(adapter.runtime).toBe(QWEN_CODE_RUNTIME);
    expect(adapter.displayName).toBe("Qwen Code");
    expect(KNOWN_RUNTIMES).toContain("qwen-code");
    expect(isKnownRuntime("qwen-code")).toBe(true);
  });
});
