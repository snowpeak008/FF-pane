/**
 * W2.3 Codex 适配器测试。
 *
 * 主体是 **fixture 回放**：packages/adapters/fixtures/codex/*.jsonl 全部为真机
 * 录制（codex-cli 0.147.0 / Windows 11），逐组断言映射结果，这样 CLI 升级后
 * 只要重录 fixture 就能立刻发现词汇漂移（codex.md §7.4 R3）。
 * git 快照 diff 采集用注入的假执行器测试，不需要真仓库。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeSessionId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCodexDiff } from "../src/codex/adapter.js";
import type {
  AgentEvent,
  CodexGitExecutor,
  CodexGitResult,
  CodexStreamOutcome,
} from "../src/index.js";
import {
  buildCodexArgs,
  CODEX_CAPABILITIES,
  createCodexAdapter,
  createCodexDiffCollector,
  createCodexEventMapper,
  parseJsonlLine,
  readJsonlStream,
  toGitPathspec,
} from "../src/index.js";

/** fixture 录制目录（fixture 内的绝对路径以此为根，已脱敏为 C:\Users\USER）。 */
const FIXTURE_CWD = "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-codex-probe";
const FIXTURE_FILE = "C:\\Users\\USER\\AppData\\Local\\Temp\\ffpane-codex-probe\\hello.txt";

/** basic 与 resume 是同一会话（fixture README：thread_id 保留原值以便断言）。 */
const BASIC_THREAD_ID = "01a04cc1-c42a-7f40-b237-6f384b9e6f17";
/** killed 与 resume-after-kill 是同一会话（强杀后仍可恢复）。 */
const KILLED_THREAD_ID = "01a04cc3-df38-73c0-a180-31b55eecd76d";

const NORMAL_EXIT: CodexStreamOutcome = {
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
  outcome: CodexStreamOutcome = NORMAL_EXIT,
): Promise<AgentEvent[]> {
  const text = await readFile(new URL(`../fixtures/codex/${fixture}`, import.meta.url), "utf8");
  const mapper = createCodexEventMapper({ cwd: FIXTURE_CWD });
  const events: AgentEvent[] = [];
  for await (const record of readJsonlStream(singleChunk(text))) {
    events.push(...mapper.map(record));
  }
  events.push(...mapper.finalize(outcome));
  return events;
}

function kindsOf(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.kind);
}

function endOf(events: readonly AgentEvent[]): Extract<AgentEvent, { kind: "end" }> {
  const last = events.at(-1);
  if (last?.kind !== "end") {
    throw new Error("事件流必须以 end 收尾");
  }
  // 恰好一条 end（adapter.ts AdapterTurn 约定）。
  expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
  return last;
}

function pick<TKind extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: TKind,
): Extract<AgentEvent, { kind: TKind }>[] {
  return events.filter(
    (event): event is Extract<AgentEvent, { kind: TKind }> => event.kind === kind,
  );
}

describe("buildCodexArgs（命令行组装）", () => {
  it("首轮：--json / -C / --skip-git-repo-check / bypass 沙箱；提示词走 stdin 故无位置参数", () => {
    expect(buildCodexArgs({ cwd: "D:\\proj", model: "gpt-5-codex" })).toStrictEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "D:\\proj",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5-codex",
    ]);
  });

  it("resume 轮：exec resume <thread_id> 且**不带 -C**；PROMPT 位置参数为 `-`（从 stdin 读）", () => {
    const args = buildCodexArgs({
      cwd: "D:\\proj",
      resume: { nativeSessionId: BASIC_THREAD_ID as NativeSessionId, cwd: "D:\\proj" },
    });
    expect(args.slice(0, 3)).toStrictEqual(["exec", "resume", BASIC_THREAD_ID]);
    expect(args).not.toContain("-C");
    // 提示词经 stdin：不再有 `--` 分隔的位置参数，末位是 `-`
    expect(args).not.toContain("--");
    expect(args.at(-1)).toBe("-");
  });

  it("首轮不带 `-` 位置参数（无 PROMPT 即从 stdin 读）", () => {
    const args = buildCodexArgs({ cwd: "/p" });
    expect(args).not.toContain("-");
    expect(args).not.toContain("--");
  });

  it("非 bypass 沙箱：首轮走 -s，resume 轮只能走 -c sandbox_mode（不继承命令行）", () => {
    expect(buildCodexArgs({ cwd: "/p", sandbox: "workspace-write" })).toContain("-s");
    const resumed = buildCodexArgs({
      cwd: "/p",
      sandbox: "workspace-write",
      resume: { nativeSessionId: "t" as NativeSessionId, cwd: "/p" },
    });
    expect(resumed).not.toContain("-s");
    expect(resumed).toContain('sandbox_mode="workspace-write"');
  });

  it("配置覆盖与额外可写目录：-c key=value 逐条展开，--add-dir 仅首轮", () => {
    const args = buildCodexArgs({
      cwd: "/p",
      configOverrides: { model_reasoning_effort: '"low"' },
      addDirs: ["/p/extra"],
    });
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).toContain("--add-dir");
    const resumed = buildCodexArgs({
      cwd: "/p",
      addDirs: ["/p/extra"],
      resume: { nativeSessionId: "t" as NativeSessionId, cwd: "/p" },
    });
    expect(resumed).not.toContain("--add-dir");
  });
});

describe("fixture 回放：exec-basic.jsonl（成功全流程）", () => {
  it("事件序列与 W2.1b 六类骨架逐条对齐", async () => {
    const events = await replay("exec-basic.jsonl");
    expect(kindsOf(events)).toStrictEqual([
      "session_start",
      "raw", // turn.started
      "text",
      "file_change", // item.started
      "file_change", // item.completed
      "command", // item.started
      "command", // item.completed（失败，退出码 1）
      "command", // item.started（重试）
      "command", // item.completed（成功）
      "text",
      "end",
    ]);
  });

  it("session_start 的 thread_id 与 cwd 成对登记", async () => {
    const [start] = await replay("exec-basic.jsonl");
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native).toStrictEqual({
      nativeSessionId: BASIC_THREAD_ID,
      cwd: FIXTURE_CWD,
    });
  });

  it("agent_message 整条到达 → 单条 final:true 的 answer 文本", async () => {
    const texts = pick(await replay("exec-basic.jsonl"), "text");
    expect(texts).toHaveLength(2);
    expect(texts.every((text) => text.final && text.channel === "answer")).toBe(true);
    expect(texts[0]?.messageId).toBe("item_0");
    expect(texts.at(-1)?.content).toContain("containing exactly");
  });

  it("file_change：started/completed 双事件同 actionId，无 diff 字段（Codex 不给 diff 正文）", async () => {
    const changes = pick(await replay("exec-basic.jsonl"), "file_change");
    expect(changes.map((change) => change.status)).toStrictEqual(["started", "completed"]);
    expect(changes.every((change) => change.actionId === "item_1")).toBe(true);
    expect(changes.every((change) => change.path === FIXTURE_FILE)).toBe(true);
    expect(changes.every((change) => change.changeKind === "add")).toBe(true);
    expect(changes.every((change) => !("diff" in change))).toBe(true);
  });

  it("command：in_progress 的 exit_code=null 与空 aggregated_output 一律缺席", async () => {
    const commands = pick(await replay("exec-basic.jsonl"), "command");
    expect(commands.map((command) => command.status)).toStrictEqual([
      "started",
      "failed",
      "started",
      "completed",
    ]);
    expect(commands[0]?.exitCode).toBeUndefined();
    expect(commands[0]?.output).toBeUndefined();
    expect(commands[1]?.exitCode).toBe(1);
    // 中文本地化输出原样保留（UTF-8 解码正确）。
    expect(commands[1]?.output).toContain("方法调用失败");
    expect(commands[3]?.exitCode).toBe(0);
  });

  it("end：completed + usage 四项（cache_write 无落点故不映射）", async () => {
    const end = endOf(await replay("exec-basic.jsonl"));
    expect(end.reason).toBe("completed");
    expect(end.usage).toStrictEqual({
      inputTokens: 46130,
      outputTokens: 450,
      cachedInputTokens: 40192,
      reasoningTokens: 131,
    });
    expect(end.exitCode).toBe(0);
  });

  it("带真实退出码的命令失败属正常试错，不把 end 拖成 failed", async () => {
    // exec-basic 里模型先跑错一条 PowerShell（exit 1）再改对——若把它算作
    // "环境阻断"，成功的 Run 会被误判为失败。
    const end = endOf(await replay("exec-basic.jsonl"));
    expect(end.reason).toBe("completed");
    expect(end.message).toBeUndefined();
  });
});

describe("fixture 回放：exec-resume.jsonl / exec-resume-after-kill.jsonl（原生恢复）", () => {
  it("resume 的 session_start 返回同一 thread_id，cwd 取本轮工作根", async () => {
    const events = await replay("exec-resume.jsonl");
    expect(kindsOf(events)).toStrictEqual(["session_start", "raw", "text", "end"]);
    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native?.nativeSessionId).toBe(BASIC_THREAD_ID);
    expect(start.native?.cwd).toBe(FIXTURE_CWD);
    expect(endOf(events).reason).toBe("completed");
  });

  it("被强杀的会话仍可恢复：resume-after-kill 的 thread_id 与 killed 一致", async () => {
    const [killedStart] = await replay("exec-killed.jsonl", {
      ...NORMAL_EXIT,
      cancelled: true,
      exitCode: 1,
    });
    const [resumedStart] = await replay("exec-resume-after-kill.jsonl");
    if (killedStart?.kind !== "session_start" || resumedStart?.kind !== "session_start") {
      throw new Error("两组 fixture 的首事件都应为 session_start");
    }
    expect(killedStart.native?.nativeSessionId).toBe(KILLED_THREAD_ID);
    expect(resumedStart.native?.nativeSessionId).toBe(KILLED_THREAD_ID);
  });
});

describe("fixture 回放：exec-sandbox-error-win.jsonl（头号坑：turn.completed ≠ 成功）", () => {
  it("失败的动作如实映射为 failed，且沙箱层错误的 exit_code=-1 保留", async () => {
    const events = await replay("exec-sandbox-error-win.jsonl");
    expect(pick(events, "file_change").map((change) => change.status)).toStrictEqual([
      "started",
      "failed",
      "started",
      "failed",
    ]);
    const commands = pick(events, "command");
    expect(commands.map((command) => command.status)).toStrictEqual(["started", "failed"]);
    expect(commands[1]?.exitCode).toBe(-1);
    expect(commands[1]?.output).toContain("windows sandbox");
  });

  it("**end 不得报成功**：Codex 报 turn.completed，映射为 failed 并写明阻断原因", async () => {
    const end = endOf(await replay("exec-sandbox-error-win.jsonl"));
    expect(end.reason).toBe("failed");
    expect(end.reason).not.toBe("completed");
    expect(end.message).toContain("turn.completed");
    expect(end.message).toContain("被环境阻断");
    // usage 照常保留：这一轮确实烧了 token。
    expect(end.usage?.inputTokens).toBe(62492);
  });

  it("declined → denied，且同样阻断 end 的成功语义", async () => {
    // 0.147.0 的沙箱失败录制里是 failed；declined 出现在审批被拒时（§2.4），
    // 故此处以构造记录覆盖该分支。
    const mapper = createCodexEventMapper({ cwd: FIXTURE_CWD });
    const declined = parseJsonlLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_9",
          type: "command_execution",
          command: "rm -rf /",
          aggregated_output: "",
          exit_code: null,
          status: "declined",
        },
      }),
      1,
    );
    if (declined === undefined) {
      throw new Error("构造的记录应可解析");
    }
    const [event] = mapper.map(declined);
    expect(event).toStrictEqual({
      kind: "command",
      command: "rm -rf /",
      status: "denied",
      actionId: "item_9",
    });

    const completed = parseJsonlLine(JSON.stringify({ type: "turn.completed" }), 2);
    if (completed === undefined) {
      throw new Error("构造的记录应可解析");
    }
    expect(mapper.map(completed)).toStrictEqual([]);
    const end = endOf(mapper.finalize(NORMAL_EXIT));
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("被拒绝");
  });
});

describe("fixture 回放：exec-killed.jsonl（强杀截断 → end 兜底）", () => {
  it("主动取消：无 turn.completed/failed → end(cancelled)", async () => {
    const events = await replay("exec-killed.jsonl", {
      cancelled: true,
      spawnFailed: false,
      exitCode: 1,
      error: null,
    });
    expect(kindsOf(events)).toStrictEqual(["session_start", "raw", "end"]);
    const end = endOf(events);
    expect(end.reason).toBe("cancelled");
    expect(end.message).toContain("未收到 turn.completed");
    expect(end.exitCode).toBe(1);
    expect(end.usage).toBeUndefined();
  });

  it("非主动取消（进程自己没了）：同一截断流 → end(crashed) 并带 stderr 尾巴", async () => {
    const end = endOf(
      await replay("exec-killed.jsonl", {
        cancelled: false,
        spawnFailed: false,
        exitCode: null,
        error: "ERROR codex_core::client: stream disconnected",
      }),
    );
    expect(end.reason).toBe("crashed");
    expect(end.message).toContain("stream disconnected");
    expect(end.exitCode).toBeUndefined();
  });
});

describe("fixture 回放：exec-error-auth.jsonl（认证失败）", () => {
  it("turn.failed → end(failed) + 错误原文；重试类 error 事件全部走 raw", async () => {
    const events = await replay("exec-error-auth.jsonl", { ...NORMAL_EXIT, exitCode: 1 });
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("401 Unauthorized");
    expect(end.exitCode).toBe(1);

    // 认证失败流里没有任何正式产出，只有 session_start + raw + end。
    expect(new Set(kindsOf(events))).toStrictEqual(new Set(["session_start", "raw", "end"]));
    const raws = pick(events, "raw");
    expect(raws.every((raw) => raw.runtime === "codex")).toBe(true);
    expect(raws.some((raw) => raw.nativeType === "error")).toBe(true);
    // item 级 error（传输层降级提示）同样留档而非丢弃。
    expect(raws.some((raw) => raw.note?.includes("只记原始日志") === true)).toBe(true);
  });
});

describe("映射器的容错（词汇漂移与脏行）", () => {
  function mapLine(native: unknown): readonly AgentEvent[] {
    const mapper = createCodexEventMapper({ cwd: FIXTURE_CWD });
    const record = parseJsonlLine(typeof native === "string" ? native : JSON.stringify(native), 1);
    if (record === undefined) {
      throw new Error("空行不应出现在本测试");
    }
    return mapper.map(record);
  }

  it("未知顶层事件类型 → raw 兜底（不中断、不静默丢弃）", () => {
    const [event] = mapLine({ type: "turn.paused", detail: 1 });
    expect(event?.kind).toBe("raw");
    expect(event).toMatchObject({ runtime: "codex", nativeType: "turn.paused" });
  });

  it("非 JSON 行 → raw 携带原文与解析原因", () => {
    const [event] = mapLine("WARN 这不是 JSON");
    expect(event?.kind).toBe("raw");
    expect(event).toMatchObject({ native: "WARN 这不是 JSON" });
  });

  it("todo_list / mcp_tool_call / web_search 只记原始日志", () => {
    for (const type of ["todo_list", "mcp_tool_call", "web_search", "collab_tool_call"]) {
      const [event] = mapLine({ type: "item.updated", item: { id: "i", type } });
      expect(event?.kind).toBe("raw");
    }
  });

  it("thread.started 缺 thread_id → raw，不伪造会话绑定", () => {
    const [event] = mapLine({ type: "thread.started" });
    expect(event?.kind).toBe("raw");
    expect(event).toMatchObject({ note: "thread.started 缺 thread_id" });
  });

  it("未识别的 item.status：按相位兜底并补一条 raw 诊断", () => {
    const events = mapLine({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "file_change",
        changes: [{ path: FIXTURE_FILE, kind: "add" }],
        status: "quantum",
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "file_change", status: "completed" });
    expect(events[1]).toMatchObject({ kind: "raw", note: 'item.status 未识别："quantum"' });
  });

  it("changes[] 条目非法 → raw，不产出半条 file_change", () => {
    const events = mapLine({
      type: "item.completed",
      item: { id: "i", type: "file_change", changes: [{ path: FIXTURE_FILE, kind: "rename" }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("raw");
  });

  it("reasoning item → text(channel: reasoning)", () => {
    const [event] = mapLine({
      type: "item.completed",
      item: { id: "item_2", type: "reasoning", text: "先看目录结构" },
    });
    expect(event).toStrictEqual({
      kind: "text",
      content: "先看目录结构",
      final: true,
      channel: "reasoning",
      messageId: "item_2",
    });
  });
});

describe("git 快照 diff 采集（注入假执行器）", () => {
  const CWD = path.sep === "\\" ? "D:\\proj" : "/proj";
  const NEW_FILE_DIFF = [
    "diff --git a/hello.txt b/hello.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/hello.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");

  function createFakeGit(respond: (args: readonly string[]) => Partial<CodexGitResult>): {
    readonly execute: CodexGitExecutor;
    readonly calls: string[][];
  } {
    const calls: string[][] = [];
    const execute: CodexGitExecutor = (args) => {
      calls.push([...args]);
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        error: null,
        ...respond(args),
      });
    };
    return { execute, calls };
  }

  it("未跟踪的新文件：git diff 为空 → 退到 --no-index 取到 diff", async () => {
    const git = createFakeGit((args) => {
      if (args[0] === "status") {
        return { stdout: "?? hello.txt\n M src/app.ts\n" };
      }
      return args.includes("--no-index") ? { exitCode: 1, stdout: NEW_FILE_DIFF } : { stdout: "" };
    });
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });

    const diff = await collector.collect(path.join(CWD, "hello.txt"));
    expect(diff).toBe(NEW_FILE_DIFF);

    // 基线 → diff → diff --cached → diff --no-index，pathspec 一律相对 posix 路径。
    expect(git.calls[0]).toStrictEqual(["status", "--porcelain"]);
    expect(git.calls[1]).toStrictEqual(["diff", "--", "hello.txt"]);
    expect(git.calls[3]?.[1]).toBe("--no-index");
    expect(git.calls[3]?.at(-1)).toBe("hello.txt");

    const diagnostics = collector.diagnostics();
    expect(diagnostics.repoState).toBe("repository");
    expect(diagnostics.degradedReason).toBeUndefined();
    expect(diagnostics.dirtyBeforeTurn).toStrictEqual(["hello.txt", "src/app.ts"]);
    expect(diagnostics.resolvedPaths).toStrictEqual([path.join(CWD, "hello.txt")]);
    expect(diagnostics.missingPaths).toStrictEqual([]);
  });

  it("已跟踪文件的改动：第一条 git diff 命中即返回，不再多跑命令", async () => {
    const git = createFakeGit((args) =>
      args[0] === "status" ? { stdout: "" } : { stdout: "diff --git a/a.ts b/a.ts\n+x\n" },
    );
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });
    await expect(collector.collect(path.join(CWD, "a.ts"))).resolves.toContain("diff --git");
    expect(git.calls).toHaveLength(2);
  });

  it("基线只跑一次：多个 file_change 复用同一次 git status", async () => {
    const git = createFakeGit((args) =>
      args[0] === "status" ? { stdout: "" } : { stdout: "diff --git a/x b/x\n" },
    );
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });
    await collector.prime();
    await collector.collect(path.join(CWD, "a.ts"));
    await collector.collect(path.join(CWD, "b.ts"));
    expect(git.calls.filter((call) => call[0] === "status")).toHaveLength(1);
  });

  it("非 git 目录：diff 整轮缺席，降级原因走事件流外的 diagnostics", async () => {
    const git = createFakeGit((args) =>
      args[0] === "status"
        ? {
            exitCode: 128,
            stderr: "fatal: not a git repository (or any of the parent directories): .git",
          }
        : {},
    );
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });

    await expect(collector.collect(path.join(CWD, "hello.txt"))).resolves.toBeUndefined();
    // 判定为非仓库后不再尝试任何 diff 命令。
    expect(git.calls).toHaveLength(1);

    const diagnostics = collector.diagnostics();
    expect(diagnostics.repoState).toBe("not-a-repository");
    expect(diagnostics.degradedReason).toContain("不是 git 仓库");
    expect(diagnostics.missingPaths).toStrictEqual([path.join(CWD, "hello.txt")]);
  });

  it("git 不可执行：降级为 git-unavailable 并注明原因", async () => {
    const git = createFakeGit(() => ({
      exitCode: null,
      error: "ENOENT: spawn git ENOENT",
    }));
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });
    await expect(collector.collect(path.join(CWD, "a.ts"))).resolves.toBeUndefined();
    expect(collector.diagnostics().repoState).toBe("git-unavailable");
    expect(collector.diagnostics().degradedReason).toContain("ENOENT");
  });

  it("三条命令都拿不到内容：返回 undefined 而不是空串", async () => {
    const git = createFakeGit(() => ({ exitCode: 0, stdout: "" }));
    const collector = createCodexDiffCollector({ cwd: CWD, execute: git.execute });
    await expect(collector.collect(path.join(CWD, "a.ts"))).resolves.toBeUndefined();
    expect(collector.diagnostics().missingPaths).toHaveLength(1);
  });

  it("超长 diff 截断并注明（不静默丢弃）", async () => {
    const git = createFakeGit((args) =>
      args[0] === "status" ? { stdout: "" } : { stdout: "x".repeat(500) },
    );
    const collector = createCodexDiffCollector({
      cwd: CWD,
      execute: git.execute,
      maxDiffBytes: 100,
    });
    const diff = await collector.collect(path.join(CWD, "a.ts"));
    expect(diff).toContain("已截断");
    expect(diff?.startsWith("x".repeat(100))).toBe(true);
  });

  it("toGitPathspec：仓库内转相对 posix 路径，仓库外原样保留", () => {
    expect(toGitPathspec(CWD, path.join(CWD, "src", "a.ts"))).toBe("src/a.ts");
    const outside = path.join(path.dirname(CWD), "other", "b.ts");
    expect(toGitPathspec(CWD, outside)).toBe(outside);
  });
});

describe("attachCodexDiff（file_change 事件的 diff 自补）", () => {
  const change: AgentEvent = {
    kind: "file_change",
    path: "D:\\proj\\a.ts",
    changeKind: "update",
    status: "completed",
  };

  function fakeCollector(diff: string | undefined): {
    readonly collector: Parameters<typeof attachCodexDiff>[0];
    readonly asked: string[];
  } {
    const asked: string[] = [];
    return {
      asked,
      collector: {
        prime: () => Promise.resolve(),
        collect: (filePath: string) => {
          asked.push(filePath);
          return Promise.resolve(diff);
        },
        diagnostics: () => ({
          repoState: "repository",
          dirtyBeforeTurn: [],
          resolvedPaths: [],
          missingPaths: [],
        }),
      },
    };
  }

  it("completed 的 file_change 补上 diff", async () => {
    const { collector, asked } = fakeCollector("diff --git a/a.ts b/a.ts\n");
    await expect(attachCodexDiff(collector, change)).resolves.toStrictEqual({
      ...change,
      diff: "diff --git a/a.ts b/a.ts\n",
    });
    expect(asked).toStrictEqual(["D:\\proj\\a.ts"]);
  });

  it("补不到就缺席：不产生 diff 字段，也不填空串", async () => {
    const { collector } = fakeCollector(undefined);
    const result = await attachCodexDiff(collector, change);
    expect("diff" in result).toBe(false);
  });

  it("started / failed 的 file_change 不采集（还没落地或没写成）", async () => {
    const { collector, asked } = fakeCollector("x");
    await attachCodexDiff(collector, { ...change, status: "started" } as AgentEvent);
    await attachCodexDiff(collector, { ...change, status: "failed" } as AgentEvent);
    expect(asked).toStrictEqual([]);
  });

  it("采集器缺席（collectDiff: false）时事件原样通过", async () => {
    await expect(attachCodexDiff(undefined, change)).resolves.toBe(change);
  });
});

describe("createCodexAdapter（适配器本体）", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "ff-pane-codex-"));
  });

  afterEach(async () => {
    // Windows 下刚退出的子进程可能仍短暂占着 cwd，故给 rm 重试余量。
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const all: AgentEvent[] = [];
    for await (const event of events) {
      all.push(event);
    }
    return all;
  }

  it("runtime / displayName / 六项能力如实声明（codex.md §6）", () => {
    const adapter = createCodexAdapter();
    expect(adapter.runtime).toBe("codex");
    expect(adapter.displayName).toBe("Codex CLI");
    expect(adapter.capabilities()).toStrictEqual({
      nativeResume: "yes",
      streaming: "partial",
      fileChangeEvents: "partial",
      commandEvents: "yes",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
    expect(adapter.capabilities()).toStrictEqual(CODEX_CAPABILITIES);
  });

  it("无原生审批通道（§6 第 5 项）：不提供 respondPermission", () => {
    // 用快速失败的轮次取句柄，避免为了看一个属性去启子进程。
    const turn = createCodexAdapter().startTurn({
      cwd: workDir,
      prompt: "x",
      resume: { nativeSessionId: "" as NativeSessionId, cwd: workDir },
    });
    expect(turn.respondPermission).toBeUndefined();
  });

  it("resume 绑定的 cwd 与本轮不一致 → 启动前快速失败（不 spawn）", async () => {
    const turn = createCodexAdapter().startTurn({
      cwd: workDir,
      prompt: "继续",
      resume: {
        nativeSessionId: BASIC_THREAD_ID as NativeSessionId,
        cwd: path.join(workDir, "sub"),
      },
    });
    const events = await collect(turn.events);
    expect(events).toHaveLength(1);
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("codex exec resume 无 -C 参数");
    expect(turn.diffDiagnostics().repoState).toBe("unchecked");
    // 幂等取消：进程从未启动
    await expect(turn.cancel()).resolves.toBeUndefined();
  });

  it("cwd 比较按路径语义而非裸字符串（末尾分隔符/大小写不算不一致）", async () => {
    const adapter = createCodexAdapter({
      command: "ff-pane-not-a-real-codex",
      collectDiff: false,
    });
    const turn = adapter.startTurn({
      cwd: workDir,
      prompt: "继续",
      resume: {
        nativeSessionId: BASIC_THREAD_ID as NativeSessionId,
        cwd: workDir + path.sep,
      },
    });
    const end = endOf(await collect(turn.events));
    // 通过了 cwd 校验，真正的失败来自"codex 不存在"。
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("未能启动");
  });

  it("codex 不在 PATH：end(failed) 携带 spawn 失败原因，命令行可取证", async () => {
    const adapter = createCodexAdapter({
      command: "ff-pane-not-a-real-codex",
      collectDiff: false,
    });
    const turn = adapter.startTurn({ cwd: workDir, prompt: "x", model: "gpt-5-codex" });
    expect(turn.commandLine[0]).toBe("ff-pane-not-a-real-codex");
    expect(turn.commandLine).toContain("--dangerously-bypass-approvals-and-sandbox");

    const end = endOf(await collect(turn.events));
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("ff-pane-not-a-real-codex");
  });

  it("逐轮 configOverrides 并入命令行，同名键覆盖构造级（per-turn wins）", async () => {
    const adapter = createCodexAdapter({
      command: "ff-pane-not-a-real-codex",
      collectDiff: false,
      // 构造级：成本控制 + 一个将被逐轮覆盖的键
      configOverrides: { model_reasoning_effort: '"low"', model_provider: "construct" },
    });
    const turn = adapter.startTurn({
      cwd: workDir,
      prompt: "x",
      // 逐轮：openai_compatible → codex model_provider 路由（覆盖同名 model_provider）
      configOverrides: {
        model_provider: "ffpane",
        "model_providers.ffpane.base_url": '"https://api.deepseek.com/v1"',
      },
    });
    const line = turn.commandLine;
    // 构造级独有键保留
    expect(line).toContain('model_reasoning_effort="low"');
    // 逐轮覆盖同名键，且不残留构造级旧值
    expect(line).toContain("model_provider=ffpane");
    expect(line).not.toContain("model_provider=construct");
    // 逐轮独有键并入
    expect(line).toContain('model_providers.ffpane.base_url="https://api.deepseek.com/v1"');
    await collect(turn.events);
  });

  it("collectDiff: false 时 diagnostics 明说是关闭而非采集失败", async () => {
    const turn = createCodexAdapter({
      command: "ff-pane-not-a-real-codex",
      collectDiff: false,
    }).startTurn({ cwd: workDir, prompt: "x" });
    expect(turn.diffDiagnostics().degradedReason).toContain("已关闭");
    await collect(turn.events);
  });

  it("非 git 的临时目录：--skip-git-repo-check 常开，diff 降级原因有据可查", async () => {
    const turn = createCodexAdapter({ command: "ff-pane-not-a-real-codex" }).startTurn({
      cwd: workDir,
      prompt: "x",
    });
    expect(turn.commandLine).toContain("--skip-git-repo-check");
    await collect(turn.events);
    // 这里用的是真 git（生产执行器）：临时目录不是仓库，故 diff 整轮缺席，
    // 且原因写在事件流外的诊断里。
    const diagnostics = turn.diffDiagnostics();
    expect(diagnostics.repoState).toBe("not-a-repository");
    expect(diagnostics.degradedReason).toContain("不是 git 仓库");
    expect(diagnostics.resolvedPaths).toStrictEqual([]);
  });
});
