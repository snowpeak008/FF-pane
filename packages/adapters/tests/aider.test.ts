/**
 * T7.3b Aider 适配器测试。
 *
 * 主体是 **fixture 回放**：packages/adapters/fixtures/aider/*.stdout.txt 全部为真机
 * 录制（aider 0.86.2 / Windows 11，模型端为本地假服务，性质见该目录 README），
 * 逐组断言映射结果——CLI 升级改了措辞，重录 fixture 即刻发现漂移。
 *
 * 断言的重心不是「字段搬运对不对」，而是四件会造成事实错误的事：
 *
 * 1. **退出码 0 不等于成功**（aider.md §3）。密钥错、端点全挂、编辑块匹配失败、
 *    命令被静默拒绝，退出码统统是 0。判定必须来自标记行。
 * 2. **无密钥 / 无模型不许启动**（§7.3 坑 1）。那会唤起浏览器做 OAuth 并挂 5 分钟，
 *    是本适配器唯一「宁可不启动」的前置校验。
 * 3. **不许在用户仓库留东西**（§8）。红线开关整套下发，且跑完还要核查。
 * 4. **不许把答案正文误判成证据**（§2.2）。扫描器兜底方向恒为「当正文」。
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AiderGitResult, AiderStreamOutcome } from "../src/index.js";
import {
  AIDER_CAPABILITIES,
  AIDER_FIXED_ENV,
  AIDER_RUNTIME,
  AiderSecretInArgvError,
  assertNoSecretInSetEnv,
  buildAiderArgs,
  couldBecomeMarkerPrefix,
  createAiderAdapter,
  createAiderDiffCollector,
  createAiderEventMapper,
  KNOWN_RUNTIMES,
  parseEditFormat,
  parseTokenCount,
  scanAiderLine,
  toAiderPathspec,
} from "../src/index.js";

const FIXTURE_CWD = "C:/Users/USER/AppData/Local/Temp/aiderprobe/rec-repo";
const SESSION_FILE = "C:/tmp/ffpane-aider-session-abc/chat-history.md";

const NORMAL_EXIT: AiderStreamOutcome = {
  cancelled: false,
  spawnFailed: false,
  exitCode: 0,
  error: null,
};

interface FixtureMeta {
  readonly exitCode: number;
  readonly repoFiles: readonly string[];
  readonly gitLog: readonly string[];
  readonly gitStatus: readonly string[];
  readonly homeFiles: readonly string[];
}

async function readFixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/aider/${name}`, import.meta.url), "utf8");
}

async function readMeta(name: string): Promise<FixtureMeta> {
  return JSON.parse(await readFixture(`${name}.meta.json`)) as FixtureMeta;
}

/**
 * 回放一份 fixture。
 *
 * `chunkSize` 刻意可调：aider 的答案文本是不带换行的真增量，而标记行只能整行判定，
 * 故「分块边界落在哪里」是这个适配器最容易出错的地方。默认整块喂，
 * 另有单测按 1 字节逐字喂以证明结果不随分块变化。
 */
async function replay(
  fixture: string,
  options: {
    readonly outcome?: AiderStreamOutcome;
    readonly chunkSize?: number;
    readonly tracked?: readonly string[];
  } = {},
): Promise<AgentEvent[]> {
  const text = await readFixture(`${fixture}.stdout.txt`);
  const tracked = options.tracked;
  const mapper = createAiderEventMapper({
    cwd: FIXTURE_CWD,
    sessionId: SESSION_FILE,
    ...(tracked === undefined ? {} : { wasTracked: (p: string) => tracked.includes(p) }),
  });
  const events: AgentEvent[] = [];
  const size = options.chunkSize ?? text.length;
  for (let i = 0; i < text.length; i += Math.max(1, size)) {
    events.push(...mapper.push(text.slice(i, i + Math.max(1, size))));
  }
  events.push(...mapper.finalize(options.outcome ?? NORMAL_EXIT));
  return events;
}

function only<K extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
}

/** 把答案通道的文本拼回去（TextEvent 是追加语义）。 */
function answerText(events: readonly AgentEvent[]): string {
  return only(events, "text")
    .filter((event) => event.channel === "answer")
    .map((event) => event.content)
    .join("");
}

// ---------------------------------------------------------------------------
// 命令行组装
// ---------------------------------------------------------------------------

describe("aider 命令行组装", () => {
  const base = {
    promptFile: "C:/tmp/p.txt",
    chatHistoryFile: "C:/tmp/s/chat.md",
    inputHistoryFile: "C:/tmp/s/input.txt",
    model: "openai/x" as never,
  };

  it("提示词走 --message-file，且模型是第一个参数", () => {
    const args = buildAiderArgs(base);
    expect(args.slice(0, 4)).toEqual(["--model", "openai/x", "--message-file", "C:/tmp/p.txt"]);
    // --message 会被 aider 抄进 transcript 的命令行那一行（§7.2），一律不用。
    expect(args).not.toContain("--message");
  });

  it("七条红线开关整套下发（默认值会动用户仓库，且默认值可被仓库配置改掉）", () => {
    const args = buildAiderArgs(base);
    for (const flag of [
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-detect-urls",
    ]) {
      expect(args).toContain(flag);
    }
    // repo-map 的 tags 缓存会在仓库里建 .aider.tags.cache.v4/
    expect(args).toContain("--map-tokens");
    expect(args[args.indexOf("--map-tokens") + 1]).toBe("0");
    // 两个 history 文件默认落在 git 根
    expect(args[args.indexOf("--chat-history-file") + 1]).toBe("C:/tmp/s/chat.md");
    expect(args[args.indexOf("--input-history-file") + 1]).toBe("C:/tmp/s/input.txt");
  });

  it("headless 必需项齐备：--yes-always 与两个关交互的开关", () => {
    const args = buildAiderArgs(base);
    for (const flag of [
      "--yes-always",
      "--no-pretty",
      "--no-fancy-input",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-show-model-warnings",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--encoding") + 1]).toBe("utf-8");
  });

  it("三个「行为确定」开关正反面都显式给出，不依赖 aider 默认值", () => {
    const off = buildAiderArgs(base);
    expect(off).toContain("--no-auto-lint");
    expect(off).toContain("--no-auto-test");
    expect(off).toContain("--no-suggest-shell-commands");

    const on = buildAiderArgs({
      ...base,
      autoLint: true,
      autoTest: true,
      suggestShellCommands: true,
    });
    expect(on).toContain("--auto-lint");
    expect(on).toContain("--auto-test");
    expect(on).toContain("--suggest-shell-commands");
    expect(on).not.toContain("--no-auto-lint");
  });

  it("resume 时加 --restore-chat-history，否则不加", () => {
    expect(buildAiderArgs(base)).not.toContain("--restore-chat-history");
    expect(buildAiderArgs({ ...base, restoreHistory: true })).toContain("--restore-chat-history");
  });

  it("可选项按需下发：编辑格式 / 语言 / 文件 / lint 与 test 命令", () => {
    const args = buildAiderArgs({
      ...base,
      editFormat: "diff",
      chatLanguage: "zh-CN",
      files: ["a.ts", "b.ts"],
      readOnlyFiles: ["c.md"],
      lintCommands: ["ts: tsc --noEmit"],
      testCommand: "pnpm test",
      reasoningEffort: "high",
      extraArgs: ["--subtree-only"],
    });
    expect(args[args.indexOf("--edit-format") + 1]).toBe("diff");
    expect(args[args.indexOf("--chat-language") + 1]).toBe("zh-CN");
    expect(args.filter((a) => a === "--file")).toHaveLength(2);
    expect(args[args.indexOf("--read") + 1]).toBe("c.md");
    expect(args[args.indexOf("--lint-cmd") + 1]).toBe("ts: tsc --noEmit");
    expect(args[args.indexOf("--test-cmd") + 1]).toBe("pnpm test");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(args.at(-1)).toBe("--subtree-only");
  });

  it("configOverrides → --set-env，键序固定（同一输入组装出同一命令行）", () => {
    const args = buildAiderArgs({
      ...base,
      setEnv: { ZZ_LAST: "2", AA_FIRST: "1" },
    });
    const pairs = args.filter((_, i) => args[i - 1] === "--set-env");
    expect(pairs).toEqual(["AA_FIRST=1", "ZZ_LAST=2"]);
  });

  it("--set-env 里出现密钥一律快速失败（值会进 argv 并被抄进 transcript）", () => {
    expect(() => assertNoSecretInSetEnv({ OPENAI_API_KEY: "sk-x" })).toThrow(
      AiderSecretInArgvError,
    );
    expect(() => assertNoSecretInSetEnv({ MY_ACCESS_TOKEN: "t" })).toThrow(AiderSecretInArgvError);
    // 非密钥的路由类变量照常放行——那正是它存在的理由（压过仓库 .env，§7.3 坑 4）。
    expect(() => assertNoSecretInSetEnv({ OLLAMA_HOST: "http://127.0.0.1:11434" })).not.toThrow();
    expect(() => buildAiderArgs({ ...base, setEnv: { ANTHROPIC_API_KEY: "sk-y" } })).toThrow(
      AiderSecretInArgvError,
    );
  });

  it("COLUMNS 必须够大：折行会让标记行认不出来（§7.3 坑 2）", () => {
    expect(Number.parseInt(AIDER_FIXED_ENV["COLUMNS"] as string, 10)).toBeGreaterThanOrEqual(1000);
    expect(AIDER_FIXED_ENV["PYTHONUTF8"]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 行扫描器
// ---------------------------------------------------------------------------

describe("aider stdout 行扫描器", () => {
  it("认出文件变更标记并切出路径（含带空格的路径）", () => {
    expect(scanAiderLine("Applied edit to src/a.ts")).toEqual({
      kind: "applied-edit",
      path: "src/a.ts",
    });
    expect(scanAiderLine("Applied edit to my dir/b c.ts")).toEqual({
      kind: "applied-edit",
      path: "my dir/b c.ts",
    });
  });

  it("剥掉 Windows 行尾的 \\r（aider 在 Windows 上输出 CRLF）", () => {
    expect(scanAiderLine("Applied edit to a.ts\r")).toEqual({
      kind: "applied-edit",
      path: "a.ts",
    });
  });

  it("--dry-run 的标记与成功标记分开，路径不含那个后缀", () => {
    expect(scanAiderLine("Did not apply edit to a.ts (--dry-run)")).toEqual({
      kind: "dry-run-edit",
      path: "a.ts",
    });
  });

  it("token 行支持 k 缩写（真机两种形态都出现过）", () => {
    expect(scanAiderLine("Tokens: 672 sent, 23 received.")).toEqual({
      kind: "tokens",
      sent: "672",
      received: "23",
    });
    expect(scanAiderLine("Tokens: 2.4k sent, 16 received.")).toEqual({
      kind: "tokens",
      sent: "2.4k",
      received: "16",
    });
    expect(parseTokenCount("2.4k")).toBe(2400);
    expect(parseTokenCount("672")).toBe(672);
    expect(parseTokenCount("nope")).toBeUndefined();
  });

  it("认出 litellm 错误行并留下错误名", () => {
    expect(scanAiderLine("litellm.AuthenticationError: bad key")).toEqual({
      kind: "litellm-error",
      errorName: "AuthenticationError",
      message: "bad key",
    });
  });

  it("从横幅里读出实际编辑格式", () => {
    expect(parseEditFormat("Model: openai/x with whole edit format")).toBe("whole");
    expect(parseEditFormat("Model: gpt-4o with diff edit format")).toBe("diff");
    expect(parseEditFormat("Applied edit to a.ts")).toBeUndefined();
  });

  it("兜底方向恒为「当正文」：像标记但不合形状的一律不当证据", () => {
    // 缺路径
    expect(scanAiderLine("Applied edit to ").kind).toBe("answer");
    // 缺 --dry-run 后缀
    expect(scanAiderLine("Did not apply edit to a.ts").kind).toBe("answer");
    // 模型在正文里引用了这句话——不能因此凭空多一条文件变更证据
    expect(scanAiderLine("  Applied edit to a.ts").kind).toBe("answer");
    expect(scanAiderLine("> Applied edit to a.ts").kind).toBe("answer");
    // 普通 Markdown 标题不是编辑块失败明细
    expect(scanAiderLine("# Hello").kind).toBe("answer");
    expect(scanAiderLine("# 1 SEARCH/REPLACE block failed to match!").kind).toBe(
      "search-replace-failure",
    );
  });

  it("模型请求的命令真跑了（Running）与 aider 自己 lint（## Running:）是两回事", () => {
    expect(scanAiderLine("Running node -v")).toEqual({ kind: "command-ran", command: "node -v" });
    expect(scanAiderLine("## Running: python -m flake8 a.py")).toEqual({
      kind: "lint-command",
      command: "python -m flake8 a.py",
    });
  });

  it("MARKER_PREFIXES 覆盖每一种标记：标记行绝不会走流式提前吐出的路径", () => {
    const markerLines = [
      "Applied edit to a.ts",
      "Did not apply edit to a.ts (--dry-run)",
      "Committing a.ts before applying edits.",
      "Commit abc1234 some message",
      "Running node -v",
      "## Running: flake8 a.py",
      "The LLM did not conform to the edit format.",
      "Restored previous conversation history.",
      "Tokens: 1 sent, 2 received.",
      "litellm.AuthenticationError: x",
      "# 1 SEARCH/REPLACE block failed to match!",
      "Aider v0.86.2",
      "Model: openai/x with whole edit format",
      "Git repo: .git with 1 files",
      "Repo-map: disabled",
    ];
    for (const line of markerLines) {
      expect(scanAiderLine(line).kind, line).not.toBe("answer");
      // 逐字符递增的每个前缀都必须被判成「还可能是标记」，否则会被提前当正文吐出。
      for (let i = 1; i <= line.length; i += 1) {
        expect(couldBecomeMarkerPrefix(line.slice(0, i)), `${line} @${i}`).toBe(true);
      }
    }
  });

  it("普通散文的开头立刻被判定为「不可能是标记」，故流式不被拖累", () => {
    expect(couldBecomeMarkerPrefix("I will")).toBe(false);
    expect(couldBecomeMarkerPrefix("好的，我来")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fixture 回放
// ---------------------------------------------------------------------------

describe("aider fixture 回放：成功路径", () => {
  it("成功改一个已有文件：一条 file_change(completed) + 答案文本 + end(completed)", async () => {
    const events = await replay("real-success-edit", { tracked: ["readme.txt"] });
    const changes = only(events, "file_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "readme.txt",
      changeKind: "update",
      status: "completed",
    });
    // diff 刻意不在 mapper 里补（那是 git I/O，归适配器层）
    expect(changes[0]?.diff).toBeUndefined();

    const ends = only(events, "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.reason).toBe("completed");
    expect(events.at(-1)?.kind).toBe("end");
    expect(answerText(events)).toContain("I will append a line to the readme.");
  });

  it("token 统计进 end.usage（一轮多条 Tokens 行要累加）", async () => {
    const events = await replay("real-success-edit");
    expect(only(events, "end")[0]?.usage).toEqual({
      inputTokens: 672,
      outputTokens: 23,
      totalTokens: 695,
    });
    // 编辑格式失败会让 aider 自动重试，于是一轮出现两条 Tokens 行
    const retried = await replay("real-edit-failed");
    const usage = only(retried, "end")[0]?.usage;
    expect(usage?.inputTokens).toBeGreaterThan(2400);
  });

  it("新建文件判 add、已跟踪文件判 update（依据 turn 前的 git ls-files）", async () => {
    const events = await replay("real-success-newfile", { tracked: ["readme.txt"] });
    const changes = only(events, "file_change");
    expect(changes.map((c) => [c.path, c.changeKind])).toEqual([
      ["notes/hello.md", "add"],
      ["readme.txt", "update"],
    ]);
  });

  it("判不出是否已跟踪时记 update，不猜 add（猜错方向只影响展示，不影响证据成立）", async () => {
    const events = await replay("real-success-newfile");
    expect(only(events, "file_change").every((c) => c.changeKind === "update")).toBe(true);
  });

  it("会话凭据是 transcript 路径，与 cwd 成对（aider 没有原生会话 ID）", async () => {
    const events = await replay("real-success-edit");
    const starts = only(events, "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.native).toEqual({ nativeSessionId: SESSION_FILE, cwd: FIXTURE_CWD });
  });

  it("恢复的那一轮认出 Restored 标记，且答出了上一轮的口令", async () => {
    const events = await replay("real-restore-history");
    expect(
      only(events, "raw").some((event) => (event.note ?? "").includes("transcript 恢复")),
    ).toBe(true);
    expect(answerText(events)).toContain("BLUE-OTTER-77");
    expect(only(events, "end")[0]?.reason).toBe("completed");
  });

  it("答案文本以一条空 content 的 final 收尾（aider 没有「说完了」的标记）", async () => {
    const events = await replay("real-success-edit");
    const texts = only(events, "text").filter((e) => e.channel === "answer");
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.at(-1)).toEqual({ kind: "text", content: "", final: true, channel: "answer" });
  });

  it("横幅行不进答案文本（那是 aider 的自述，不是模型说的话）", async () => {
    const events = await replay("real-success-edit");
    const text = answerText(events);
    expect(text).not.toContain("Aider v0.86.2");
    expect(text).not.toContain("Git repo:");
    expect(text).not.toContain("Detected dumb terminal");
  });

  it("逐字节喂与整块喂结果完全一致（分块边界不改变语义）", async () => {
    const whole = await replay("real-success-newfile", { tracked: ["readme.txt"] });
    const byByte = await replay("real-success-newfile", {
      tracked: ["readme.txt"],
      chunkSize: 1,
    });
    const strip = (events: readonly AgentEvent[]): unknown =>
      events.filter((e) => e.kind !== "text").map((e) => e);
    expect(strip(byByte)).toEqual(strip(whole));
    expect(answerText(byByte)).toBe(answerText(whole));
  });
});

describe("aider fixture 回放：退出码撒谎的四种形态", () => {
  it("密钥错误：litellm.AuthenticationError，退出码 0，判 failed", async () => {
    const meta = await readMeta("real-auth-invalid-key");
    expect(meta.exitCode).toBe(0);

    const events = await replay("real-auth-invalid-key");
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("AuthenticationError");
    expect(end?.exitCode).toBe(0);
    expect(only(events, "file_change")).toHaveLength(0);
  });

  it("编辑块匹配失败：退出码 0，判 failed 并说明是被阻断", async () => {
    const meta = await readMeta("real-edit-failed");
    expect(meta.exitCode).toBe(0);
    // 真机事实：文件没被改
    expect(meta.gitStatus).toEqual([]);

    const events = await replay("real-edit-failed");
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("阻断");
    expect(only(events, "file_change")).toHaveLength(0);
  });

  it("模型请求的命令被静默拒绝：无 command 事件、退出码 0", async () => {
    const meta = await readMeta("real-shell-declined");
    expect(meta.exitCode).toBe(0);

    const events = await replay("real-shell-declined");
    // headless 下命令结构性地不执行，故绝不能产出 command 事件
    expect(only(events, "command")).toHaveLength(0);
    // 那行裸 `node -v` 只能当答案文本，不能当证据
    expect(answerText(events)).toContain("node -v");
  });

  it("参数错误：stdout 空、usage 全在 stderr、退出码 2，判 failed", async () => {
    const meta = await readMeta("real-badargs");
    expect(meta.exitCode).toBe(2);
    expect((await readFixture("real-badargs.stdout.txt")).length).toBe(0);
    expect(await readFixture("real-badargs.stderr.txt")).toContain("unrecognized arguments");

    const events = await replay("real-badargs", {
      outcome: {
        cancelled: false,
        spawnFailed: false,
        exitCode: 2,
        error: "unrecognized arguments",
      },
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("argparse");
  });

  it("退出码 0 但什么都没产出，判 failed 而不是 completed", async () => {
    const mapper = createAiderEventMapper({ cwd: FIXTURE_CWD, sessionId: SESSION_FILE });
    const end = only(mapper.finalize(NORMAL_EXIT), "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("退出码不承载成功语义");
  });
});

describe("aider fixture 回放：截断与红线告警", () => {
  it("强杀：流停在横幅、无终止标记，主动取消时收成 cancelled", async () => {
    const meta = await readMeta("real-killed");
    expect(meta.exitCode).toBe(1);

    const events = await replay("real-killed", {
      outcome: { cancelled: true, spawnFailed: false, exitCode: 1, error: null },
    });
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("cancelled");
    expect(end?.message).toContain("不回滚");
    expect(events.at(-1)?.kind).toBe("end");
  });

  it("退出码 1 但适配器没取消：判 crashed（外部干预或崩溃）", async () => {
    const events = await replay("real-killed", {
      outcome: { cancelled: false, spawnFailed: false, exitCode: 1, error: null },
    });
    expect(only(events, "end")[0]?.reason).toBe("crashed");
  });

  it("进程没起来：判 failed 并带上 spawn 层原因", async () => {
    const mapper = createAiderEventMapper({ cwd: FIXTURE_CWD, sessionId: SESSION_FILE });
    const end = only(
      mapper.finalize({ cancelled: false, spawnFailed: true, exitCode: null, error: "ENOENT" }),
      "end",
    )[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("ENOENT");
    expect(end?.exitCode).toBeUndefined();
  });

  it("aider 自己的 lint 子进程只记 raw，不产 command 事件（能力声明为 no）", async () => {
    const events = await replay("real-autolint-fix", { tracked: ["readme.txt"] });
    expect(only(events, "command")).toHaveLength(0);
    expect(only(events, "raw").some((e) => (e.note ?? "").includes("lint 子进程"))).toBe(true);
    // auto-lint 会自动多花一轮：同一个文件被 Applied 两次
    expect(only(events, "file_change").filter((c) => c.path === "bad.py")).toHaveLength(2);
  });

  it("aider 造了 commit 就报红线告警并让整轮 failed", async () => {
    const mapper = createAiderEventMapper({ cwd: FIXTURE_CWD, sessionId: SESSION_FILE });
    const events = [
      ...mapper.push("Applied edit to a.ts\nCommit abc1234 docs: update\n"),
      ...mapper.finalize(NORMAL_EXIT),
    ];
    expect(only(events, "raw").some((e) => (e.note ?? "").includes("红线告警"))).toBe(true);
    const end = only(events, "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("--no-auto-commits 未生效");
  });

  it("--dry-run 的编辑记 started 而不是 completed（空转不该满足证据门槛）", async () => {
    const mapper = createAiderEventMapper({ cwd: FIXTURE_CWD, sessionId: SESSION_FILE });
    const events = mapper.push("Did not apply edit to a.ts (--dry-run)\n");
    expect(only(events, "file_change")[0]).toMatchObject({ status: "started" });
  });
});

describe("aider fixture 的真机事实（红线证据）", () => {
  it("下发全套开关后：用户仓库零残留、git 历史无新增 commit、HOME 未被写", async () => {
    for (const name of ["real-success-edit", "real-success-newfile", "real-restore-history"]) {
      const meta = await readMeta(name);
      expect(
        meta.repoFiles.filter((f) => f.startsWith(".aider")),
        name,
      ).toEqual([]);
      expect(meta.repoFiles, name).not.toContain(".gitignore");
      expect(meta.gitLog, name).toEqual(["init"]);
      expect(meta.homeFiles, name).toEqual([]);
    }
  });

  it("不下发开关时默认值有多脏（对照组，证明那七条开关不是摆设）", async () => {
    const meta = await readMeta("real-defaults-residue");
    expect(meta.repoFiles).toContain(".aider.chat.history.md");
    expect(meta.repoFiles).toContain(".aider.input.history");
    expect(meta.repoFiles).toContain(".aider.tags.cache.v4");
    expect(meta.repoFiles).toContain(".gitignore");
    // aider 自己造了一条 commit
    expect(meta.gitLog).toHaveLength(2);
    // 且 .aider* 被写进 .gitignore 后，那三个残留在 git status 里就看不见了
    expect(meta.gitStatus).toEqual(["?? .gitignore"]);
  });

  it("新建文件会被 aider git add 进索引（故 diff 采集必须看 --cached 一侧）", async () => {
    const meta = await readMeta("real-success-newfile");
    expect(meta.gitStatus).toContain("AM notes/hello.md");
  });

  it("仓库 .env 会覆盖注入的 env（真机实证：对话从仓库 .env 那条路走通了）", async () => {
    const meta = await readMeta("real-repo-dotenv-hijack");
    expect(meta.repoFiles).toContain(".env");
    expect(await readFixture("real-repo-dotenv-hijack.stdout.txt")).toContain(
      "Routed through the repository .env",
    );
  });

  it("transcript 里逐字记录了完整命令行（故密钥永不进 argv）", async () => {
    const transcript = await readFixture("real-restore-history.chat-history.md");
    expect(transcript).toContain("--message-file");
    expect(transcript).toContain("Restored previous conversation history.");
  });
});

// ---------------------------------------------------------------------------
// git diff 自补
// ---------------------------------------------------------------------------

describe("aider git diff 自补", () => {
  const ok = (stdout: string): AiderGitResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
    error: null,
  });
  const empty = ok("");

  it("索引侧优先：aider 新建的文件只有 --cached 有内容", async () => {
    const calls: string[][] = [];
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      execute: async (args) => {
        calls.push([...args]);
        if (args[0] === "status") return empty;
        if (args[0] === "ls-files") return ok("readme.txt\n");
        if (args[0] === "rev-parse") return ok("abc\n");
        if (args[1] === "--cached") return ok("--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n");
        return empty;
      },
    });
    const diff = await collector.collect("new.ts");
    expect(diff).toContain("+x");
    // --cached 在 --（工作区）之前被尝试
    const diffCalls = calls.filter((c) => c[0] === "diff");
    expect(diffCalls[0]).toContain("--cached");
  });

  it("turn 前的 ls-files 基线用来判 add / update", async () => {
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      execute: async (args) => {
        if (args[0] === "ls-files") return ok("readme.txt\nsrc/a.ts\n");
        if (args[0] === "rev-parse") return ok("abc\n");
        return empty;
      },
    });
    await collector.prime();
    expect(collector.wasTrackedBeforeTurn("readme.txt")).toBe(true);
    expect(collector.wasTrackedBeforeTurn("C:/repo/src/a.ts")).toBe(true);
    expect(collector.wasTrackedBeforeTurn("brand-new.ts")).toBe(false);
  });

  it("非 git 仓库：整轮不补 diff，且降级原因进 diagnostics 而不是事件流", async () => {
    const collector = createAiderDiffCollector({
      cwd: "C:/tmp",
      execute: async () => ({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
        error: null,
      }),
    });
    expect(await collector.collect("a.ts")).toBeUndefined();
    const diagnostics = collector.diagnostics();
    expect(diagnostics.repoState).toBe("not-a-repository");
    expect(diagnostics.degradedReason).toContain("不是 git 仓库");
    expect(diagnostics.missingPaths).toEqual(["a.ts"]);
    // 判不出跟踪状态时返回 undefined，调用方据此不猜变更类型
    expect(collector.wasTrackedBeforeTurn("a.ts")).toBeUndefined();
  });

  it("git 不可用：降级为 git-unavailable，不抛异常", async () => {
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      execute: async () => ({ exitCode: null, stdout: "", stderr: "", error: "ENOENT: git" }),
    });
    expect(await collector.collect("a.ts")).toBeUndefined();
    expect(collector.diagnostics().repoState).toBe("git-unavailable");
  });

  it("diff 为空时字段缺席，绝不返回空串（不造假空 diff）", async () => {
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      execute: async (args) => {
        if (args[0] === "ls-files") return ok("a.ts\n");
        if (args[0] === "rev-parse") return ok("abc\n");
        return ok("   \n");
      },
    });
    expect(await collector.collect("a.ts")).toBeUndefined();
  });

  it("超长 diff 截断并注明，不静默丢弃", async () => {
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      maxDiffBytes: 32,
      execute: async (args) => {
        if (args[0] === "status") return empty;
        if (args[0] === "ls-files") return ok("a.ts\n");
        if (args[0] === "rev-parse") return ok("abc\n");
        return ok(`+${"x".repeat(200)}\n`);
      },
    });
    const diff = await collector.collect("a.ts");
    expect(diff).toContain("已截断");
    expect((diff ?? "").length).toBeLessThan(200);
  });

  it("HEAD 前后对比可用于红线核查（本轮是否造了 commit）", async () => {
    let head = "before";
    const collector = createAiderDiffCollector({
      cwd: "C:/repo",
      execute: async (args) => {
        if (args[0] === "status") return empty;
        if (args[0] === "ls-files") return ok("a.ts\n");
        if (args[0] === "rev-parse") return ok(`${head}\n`);
        return empty;
      },
    });
    await collector.prime();
    expect(collector.diagnostics().headBeforeTurn).toBe("before");
    head = "after";
    expect(await collector.headAfterTurn()).toBe("after");
  });

  it("pathspec 归一：绝对路径转相对、反斜杠转正斜杠、仓库外原样", () => {
    expect(toAiderPathspec("C:/repo", "C:/repo/src/a.ts")).toBe("src/a.ts");
    expect(toAiderPathspec("C:/repo", "src\\a.ts")).toBe("src/a.ts");
    expect(toAiderPathspec("C:/repo", "D:/other/a.ts")).toBe("D:/other/a.ts");
  });
});

// ---------------------------------------------------------------------------
// 适配器本体
// ---------------------------------------------------------------------------

describe("aider 适配器本体", () => {
  const adapter = createAiderAdapter();

  it("能力声明如实：流式 yes，命令事件 no，恢复与变更与取消 partial", () => {
    expect(adapter.capabilities()).toEqual(AIDER_CAPABILITIES);
    expect(AIDER_CAPABILITIES).toEqual({
      nativeResume: "partial",
      streaming: "yes",
      fileChangeEvents: "partial",
      commandEvents: "no",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
  });

  it("不实现 respondPermission（无审批回执通道）", () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
    });
    expect(turn.respondPermission).toBeUndefined();
  });

  it("注册键在 KNOWN_RUNTIMES 里，显示名可读", () => {
    expect(adapter.runtime).toBe(AIDER_RUNTIME);
    expect(KNOWN_RUNTIMES).toContain("aider");
    expect(adapter.displayName).toBe("Aider");
  });

  /** 收集一轮事件（这些用例全部走启动前快速失败，不会真的 spawn）。 */
  async function collect(turn: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    return events;
  }

  it("缺模型：拒绝启动（那会唤起浏览器做 OAuth 并挂 5 分钟）", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      env: { OPENAI_API_KEY: "sk-fake" },
    });
    const events = await collect(turn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "end", reason: "failed" });
    const end = only(events, "end")[0];
    expect(end?.message).toContain("浏览器");
    expect(end?.message).toContain("onboarding");
  });

  it("缺密钥：同样拒绝启动，并列出它检查了哪些变量", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
    });
    const end = only(await collect(turn), "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("浏览器");
    expect(end?.message).toContain("OPENAI_API_KEY");
  });

  it("空字符串的密钥不算有密钥（不静默塞空串给 aider）", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "" },
    });
    expect(only(await collect(turn), "end")[0]?.reason).toBe("failed");
  });

  it("自定义 Provider 可声明自己的密钥变量名，避免被误判为缺密钥", async () => {
    const custom = createAiderAdapter({ requiredKeyEnvNames: ["MY_PROVIDER_API_KEY"] });
    const turn = custom.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
    });
    const end = only(await collect(turn), "end")[0];
    expect(end?.message).toContain("MY_PROVIDER_API_KEY");
  });

  it("resume 跨目录快速失败（transcript 与 repo-map 都相对当轮 git 根）", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
      resume: { nativeSessionId: "C:/tmp/s/chat-history.md" as never, cwd: "C:/other" },
    });
    const end = only(await collect(turn), "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("不一致");
  });

  it("resume 空凭据快速失败", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
      resume: { nativeSessionId: "" as never, cwd: "C:/repo" },
    });
    expect(only(await collect(turn), "end")[0]?.message).toContain("缺少会话凭据");
  });

  it("resume 指向不存在的 transcript 时快速失败（连续性全靠这个文件）", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
      resume: {
        nativeSessionId: "C:/definitely/not/here/chat-history.md" as never,
        cwd: "C:/repo",
      },
    });
    const end = only(await collect(turn), "end")[0];
    expect(end?.message).toContain("transcript 不存在");
  });

  it("configOverrides 里带密钥：拒绝启动而不是把它写进 argv", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
      configOverrides: { ANTHROPIC_API_KEY: "sk-leak" },
    });
    const end = only(await collect(turn), "end")[0];
    expect(end?.reason).toBe("failed");
    expect(end?.message).toContain("AiderSecretInArgvError");
  });

  it("commandLine 暴露给 Run 日志，且 sessionFile 就是会话凭据", () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      model: "openai/x" as never,
      env: { OPENAI_API_KEY: "sk-fake" },
      tempDir: undefined,
    } as never);
    expect(turn.commandLine[0]).toContain("aider");
    expect(turn.commandLine).toContain("--message-file");
    expect(turn.sessionFile.endsWith("chat-history.md")).toBe(true);
    // 会话目录在系统临时目录，**不在用户仓库里**
    expect(turn.sessionFile.startsWith("C:/repo")).toBe(false);
  });

  it("取消是幂等的，且进程未启动时无害", async () => {
    const turn = adapter.startTurn({
      cwd: "C:/repo",
      prompt: "hi",
      env: { OPENAI_API_KEY: "sk-fake" },
    });
    await expect(turn.cancel()).resolves.toBeUndefined();
    await expect(turn.cancel()).resolves.toBeUndefined();
  });
});
