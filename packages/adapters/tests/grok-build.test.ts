/**
 * T7.3 Grok Build 适配器测试。
 *
 * 主体是 **fixture 回放**：packages/adapters/fixtures/grok-build/*.jsonl 全部为真机
 * 录制（grok 1.0.13 / Windows 11，模型端为本地假服务，性质见该目录 README），
 * 逐组断言映射结果——CLI 升级后重录 fixture 即可立刻发现词汇漂移。
 *
 * 断言的重心不是"字段搬运对不对"，而是三件会造成事实错误的事：
 * 1. `stopReason: "cancelled"` 与被拒的工具调用**不能**被记成成功（grok-build.md §7.3 坑 1）；
 * 2. 权限拒绝要从 grok 的 `failed` 里辨认出来并归到 `denied`（两者在证据层待遇不同）；
 * 3. 流被截断（强杀 / 错误路径无 end）时必须由进程终局兜底收尾。
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentEvent, GrokStreamOutcome } from "../src/index.js";
import {
  buildGrokArgs,
  createGrokBuildAdapter,
  createGrokEventMapper,
  GROK_BUILD_CAPABILITIES,
  GROK_BUILD_RUNTIME,
  readJsonlStream,
  renderGrokDiff,
} from "../src/index.js";

/** fixture 录制目录（fixture 内的绝对路径以此为根，已脱敏为 C:/Users/USER）。 */
const FIXTURE_CWD = "C:/Users/USER/AppData/Local/Temp/grokprobe";
const FIXTURE_FILE = "C:/Users/USER/AppData/Local/Temp/grokprobe/hello.txt";

/** success 与 resume 是同一会话（fixture README：sessionId 保留原值以便断言）。 */
const SUCCESS_SESSION_ID = "01a05779-42cf-7a33-9cdd-88683d6a8385";

const NORMAL_EXIT: GrokStreamOutcome = {
  cancelled: false,
  spawnFailed: false,
  exitCode: 0,
  error: null,
};

async function* singleChunk(text: string): AsyncGenerator<string> {
  yield text;
}

/** 回放一组 fixture：真 JSONL 管道（W2.1b）+ 映射器 + finalize 收尾。 */
async function replay(
  fixture: string,
  outcome: GrokStreamOutcome = NORMAL_EXIT,
): Promise<AgentEvent[]> {
  const text = await readFile(
    new URL(`../fixtures/grok-build/${fixture}`, import.meta.url),
    "utf8",
  );
  const mapper = createGrokEventMapper({ cwd: FIXTURE_CWD });
  const events: AgentEvent[] = [];
  for await (const record of readJsonlStream(singleChunk(text))) {
    events.push(...mapper.map(record));
  }
  events.push(...mapper.finalize(outcome));
  return events;
}

function only<K extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
}

describe("grok-build 命令行组装", () => {
  const base = { promptFile: "C:/tmp/p.txt", cwd: "C:/repo" };

  it("默认参数：streaming-json + cwd + always-approve + 禁子 Agent + 禁更新", () => {
    expect(buildGrokArgs(base)).toEqual([
      "--prompt-file",
      "C:/tmp/p.txt",
      "--output-format",
      "streaming-json",
      "--cwd",
      "C:/repo",
      "--no-auto-update",
      "--always-approve",
      "--no-subagents",
    ]);
  });

  it("--always-approve 是默认：没它 headless 一事无成且退出码仍是 0（§7.3 坑 1）", () => {
    expect(buildGrokArgs(base)).toContain("--always-approve");
    // 显式选别的模式时走 --permission-mode，不再发 --always-approve
    const strict = buildGrokArgs({ ...base, permissionMode: "default" });
    expect(strict).toContain("--permission-mode");
    expect(strict).toContain("default");
    expect(strict).not.toContain("--always-approve");
  });

  it("resume 追加 -r <session_id>", () => {
    const args = buildGrokArgs({
      ...base,
      resume: { nativeSessionId: SUCCESS_SESSION_ID as never, cwd: "C:/repo" },
    });
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe(SUCCESS_SESSION_ID);
  });

  it("规则与工具名可重复下发，顺序稳定", () => {
    const args = buildGrokArgs({
      ...base,
      allowRules: ["Bash(npm*)"],
      denyRules: ["Bash(rm*)", "Write(**)"],
      tools: ["read_file", "grep"],
      maxTurns: 12,
    });
    expect(args.filter((a) => a === "--deny")).toHaveLength(2);
    expect(args).toContain("Bash(npm*)");
    expect(args[args.indexOf("--tools") + 1]).toBe("read_file,grep");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("12");
  });

  it("noSubagents: false 时不下发该标志（用户明确要子 Agent 时的逃生门）", () => {
    expect(buildGrokArgs({ ...base, noSubagents: false })).not.toContain("--no-subagents");
  });
});

describe("grok-build diff 渲染", () => {
  it("有 _meta.details 时按逐处编辑渲染 hunk", () => {
    const diff = renderGrokDiff({
      path: "a.txt",
      oldText: "one\ntwo\nthree",
      newText: "one\nTWO\nthree",
      meta: {
        details: [
          {
            old_string: "two",
            new_string: "TWO",
            old_line: 2,
            new_line: 2,
            context_before: "one",
            context_after: "three",
          },
        ],
      },
    });
    expect(diff).toBe(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join(
        "\n",
      ),
    );
  });

  it("无 details 时退回整段替换，不做行级推断", () => {
    const diff = renderGrokDiff({ path: "a.txt", oldText: "old", newText: "new" });
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  it("新建文件（oldText 为空串）不产出凭空的删除行", () => {
    const diff = renderGrokDiff({ path: "a.txt", oldText: "", newText: "hello" });
    // 表头 `--- a/…` 也以 - 开头，故按行剔除表头后再看有没有删除行
    const removals = (diff ?? "")
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("--- "));
    expect(removals).toEqual([]);
    expect(diff).toContain("+hello");
  });

  it("新旧一致 → 不产出空 diff 字段", () => {
    expect(renderGrokDiff({ path: "a.txt", oldText: "same", newText: "same" })).toBeUndefined();
  });
});

describe("grok-build fixture 回放：成功流", () => {
  it("文件写入事件带路径、changeKind=add 与 diff 正文（无需 git 快照自补）", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const changes = only(events, "file_change");
    expect(changes.length).toBeGreaterThan(0);
    const completed = changes.filter((c) => c.status === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ path: FIXTURE_FILE, changeKind: "add" });
    expect(completed[0]?.diff).toContain("+hello");
  });

  it("命令事件带退出码、输出与工作目录", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const commands = only(events, "command");
    const done = commands.find((c) => c.status === "completed");
    expect(done).toMatchObject({ command: "node -v", exitCode: 0 });
    expect(done?.output).toContain("v24.15.0");
    expect(done?.cwd).toContain("grokprobe");
  });

  it("text 是真增量，收尾补一条 final", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const texts = only(events, "text").filter((t) => t.channel === "answer");
    // 一句话被切成两片投递（fixture 实录），故增量条数 > 1
    expect(texts.filter((t) => !t.final).length).toBeGreaterThan(1);
    const finals = texts.filter((t) => t.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.content).toBe("");
    expect(texts.map((t) => t.content).join("")).toContain("I created hello.txt");
  });

  it("session_start 在 end 之前补发，ID 与 cwd 成对", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const startIndex = events.findIndex((e) => e.kind === "session_start");
    const endIndex = events.findIndex((e) => e.kind === "end");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(endIndex);
    expect(only(events, "session_start")[0]?.native).toEqual({
      nativeSessionId: "01a05779-42cf-7a33-9cdd-88683d6a8385",
      cwd: FIXTURE_CWD,
    });
  });

  it("end 恰好一条、reason=completed、带 usage", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const ends = only(events, "end");
    expect(ends).toHaveLength(1);
    expect(events[events.length - 1]?.kind).toBe("end");
    expect(ends[0]).toMatchObject({ reason: "completed", exitCode: 0 });
    expect(ends[0]?.usage?.totalTokens).toBe(2571);
  });

  it("available_commands 重复出现不影响映射，只落 raw", async () => {
    const events = await replay("real-streaming-json-success.jsonl");
    const raws = only(events, "raw").filter((r) => r.nativeType === "available_commands");
    expect(raws.length).toBeGreaterThan(1);
    expect(raws[0]?.runtime).toBe(GROK_BUILD_RUNTIME);
  });
});

describe("grok-build fixture 回放：恢复会话", () => {
  it("resume 轮的 sessionId 与首轮一致（真机验证：不新开会话）", async () => {
    const events = await replay("real-streaming-json-resume.jsonl");
    expect(only(events, "session_start")[0]?.native?.nativeSessionId).toBe(SUCCESS_SESSION_ID);
    expect(only(events, "end")[0]?.reason).toBe("completed");
  });
});

describe("grok-build fixture 回放：权限拒绝（头号坑）", () => {
  it("不加 --always-approve：工具被拒 → denied，整轮 cancelled 而非 completed", async () => {
    const events = await replay("real-streaming-json-headless-noapprove.jsonl");
    const denied = only(events, "file_change").filter((c) => c.status === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.path).toBe(FIXTURE_FILE);

    const end = only(events, "end")[0];
    // 退出码是 0，但这一轮什么都没干成——绝不能记成 completed
    expect(end).toMatchObject({ reason: "cancelled", exitCode: 0 });
    expect(end?.message).toContain("未获批准");
  });

  it("--deny 规则命中：文本里的「Denied by permission policy」被辨认为 denied", async () => {
    const events = await replay("real-streaming-json-deny-rule.jsonl");
    const statuses = only(events, "file_change").map((c) => c.status);
    expect(statuses).toContain("denied");
    expect(statuses).not.toContain("completed");
    expect(only(events, "end")[0]?.reason).toBe("cancelled");
  });

  it("被拒的动作会被记入阻断证据（供 end 说明原因）", async () => {
    const text = await readFile(
      new URL("../fixtures/grok-build/real-streaming-json-deny-rule.jsonl", import.meta.url),
      "utf8",
    );
    const mapper = createGrokEventMapper({ cwd: FIXTURE_CWD });
    for await (const record of readJsonlStream(singleChunk(text))) {
      mapper.map(record);
    }
    expect(mapper.blockages().join("；")).toContain("被拒绝");
  });
});

describe("grok-build fixture 回放：错误与截断", () => {
  it("未登录：只有一条 error、无 end → 收成 failed 并保留原文", async () => {
    const events = await replay("real-streaming-json-auth-error.jsonl", {
      ...NORMAL_EXIT,
      exitCode: 1,
    });
    const end = only(events, "end")[0];
    expect(end).toMatchObject({ reason: "failed", exitCode: 1 });
    expect(end?.message).toContain("Not signed in");
  });

  it("API 报错：available_commands 之后直接 error，同样收成 failed", async () => {
    const events = await replay("real-streaming-json-api-error.jsonl", {
      ...NORMAL_EXIT,
      exitCode: 1,
    });
    expect(only(events, "end")[0]).toMatchObject({ reason: "failed" });
    expect(only(events, "end")[0]?.message).toContain("Incorrect API key");
  });

  it("强杀：流里没有任何终止事件 → 按进程终局兜底为 cancelled", async () => {
    const events = await replay("real-streaming-json-killed.jsonl", {
      cancelled: true,
      spawnFailed: false,
      exitCode: 1,
      error: null,
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("cancelled");
    expect(end?.message).toContain("事件流被截断");
    // 没有会话 ID 就不该编一个出来（§7.3 坑 5）
    expect(only(events, "session_start")).toHaveLength(0);
  });

  it("非主动取消的截断 → crashed；spawn 失败 → failed", async () => {
    const crashed = await replay("real-streaming-json-killed.jsonl", {
      cancelled: false,
      spawnFailed: false,
      exitCode: null,
      error: null,
    });
    expect(only(crashed, "end")[0]?.reason).toBe("crashed");

    const failed = await replay("real-streaming-json-killed.jsonl", {
      cancelled: false,
      spawnFailed: true,
      exitCode: null,
      error: "ENOENT",
    });
    expect(only(failed, "end")[0]).toMatchObject({ reason: "failed" });
    expect(only(failed, "end")[0]?.message).toContain("ENOENT");
  });
});

describe("grok-build 适配器本体", () => {
  it("headless 能力声明与调研结论一致（六项，逐项有据）", () => {
    expect(GROK_BUILD_CAPABILITIES).toEqual({
      nativeResume: "yes",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
  });

  it("headless 模式不实现 respondPermission（单向流无审批回执通道）", () => {
    const adapter = createGrokBuildAdapter({ transport: "streaming-json" });
    const turn = adapter.startTurn({ cwd: process.cwd(), prompt: "x", timeoutMs: 1 });
    expect(turn.respondPermission).toBeUndefined();
    void turn.cancel();
  });

  it("resume 绑定的 cwd 与本轮不一致 → 启动前失败，不 spawn", async () => {
    const adapter = createGrokBuildAdapter();
    const turn = adapter.startTurn({
      cwd: "C:/repo-a",
      prompt: "x",
      resume: { nativeSessionId: "s-1" as never, cwd: "C:/repo-b" },
    });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    expect((events[0] as { message: string }).message).toContain("按 cwd 分桶");
  });

  it("resume 绑定缺 session_id → 启动前失败", async () => {
    const adapter = createGrokBuildAdapter();
    const turn = adapter.startTurn({
      cwd: "C:/repo-a",
      prompt: "x",
      resume: { nativeSessionId: "" as never, cwd: "C:/repo-a" },
    });
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
  });

  it("registry 键与展示名", () => {
    const adapter = createGrokBuildAdapter();
    expect(adapter.runtime).toBe("grok-build");
    expect(adapter.displayName).toBe("Grok Build");
  });
});
