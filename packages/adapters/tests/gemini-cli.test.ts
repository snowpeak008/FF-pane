/**
 * W2.5 Gemini CLI 适配器测试。
 *
 * 分层：
 * - fixture 回放（6 份，packages/adapters/fixtures/gemini-cli/）验证事件映射语义。
 *   **真实录制**的 3 份是事实基准；**文档构造**的 3 份照测，测试名标注"待真机校验"
 *   —— 本机无 Gemini 认证（无 API key、无 OAuth），成功路径无法真机录制。
 * - `--policy` 生成器用迷你策略引擎（复刻 CLI 的匹配规则与稳定 JSON 串）断言裁决。
 * - 退出码语义表、启动参数、适配器全链路（注入 spawn 接缝）。
 * - 真机验证：无认证下跑一次真实 gemini，确认退出码 41 → end(failed) + 认证提示。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeSessionId, PermissionEnvelope } from "@ff-pane/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentProcessExit,
  AgentProcessHandle,
  AgentProcessSpec,
  GeminiPolicyRule,
  GeminiTurnOutcome,
} from "../src/index.js";
import {
  buildGeminiCommand,
  buildGeminiPolicyRules,
  createGeminiCliAdapter,
  createGeminiEventMapper,
  describeGeminiExitCode,
  evaluateGeminiPolicyRules,
  GEMINI_CLI_CAPABILITIES,
  GEMINI_EXIT_AUTH_FAILURE,
  GEMINI_POLICY_FILE_NAME,
  GEMINI_POLICY_OVERRIDE_PRIORITY,
  GEMINI_YOLO_ALLOW_ALL_PRIORITY,
  GeminiCommandError,
  isGeminiSafePolicyRegExp,
  parseJsonlLine,
  renderGeminiPolicyToml,
  spawnAgentProcess,
  splitLines,
  stringifyGeminiToolArgs,
} from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/gemini-cli/", import.meta.url));
const PROJECT_ROOT = process.platform === "win32" ? "D:\\proj" : "/proj";

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** 把 fixture 当作 stdout 逐行喂进映射器，再按给定终局收尾。 */
function replay(
  fixture: string,
  outcome: Partial<GeminiTurnOutcome> = {},
  cwd: string = PROJECT_ROOT,
): AgentEvent[] {
  const mapper = createGeminiEventMapper({ cwd });
  const events: AgentEvent[] = [];
  let lineNumber = 0;
  for (const line of splitLines(readFixture(fixture))) {
    lineNumber += 1;
    const record = parseJsonlLine(line, lineNumber);
    if (record !== undefined) {
      events.push(...mapper.map(record));
    }
  }
  events.push(
    ...mapper.finish({ endKind: "exited", exitCode: 0, cancelRequested: false, ...outcome }),
  );
  return events;
}

function expectEnd(events: readonly AgentEvent[]): Extract<AgentEvent, { kind: "end" }> {
  const end = events.at(-1);
  if (end?.kind !== "end") {
    throw new Error("事件流必须以 end 收尾");
  }
  return end;
}

describe("fixture 回放：真实录制", () => {
  it("real-stream-json-api-error.jsonl：init→session_start；result(error)+退出码 400 → end(failed) 带 HTTP 说明", () => {
    const events = replay("real-stream-json-api-error.jsonl", { exitCode: 400 });

    expect(events.map((event) => event.kind)).toStrictEqual(["session_start", "end"]);
    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    expect(start.native).toStrictEqual({
      nativeSessionId: "d0eae9f7-aca4-4ba2-a2c5-ddca42c726c4",
      cwd: PROJECT_ROOT,
    });
    // init.model 是配置别名（"auto"），不得当作实际模型上报。
    expect(start.model).toBeUndefined();

    const end = expectEnd(events);
    expect(end.reason).toBe("failed");
    expect(end.exitCode).toBe(400);
    expect(end.message).toContain("API key not valid");
    expect(end.message).toContain("HTTP 400");
    // 真机该轮 stats 全零，但字段齐全 → usage 仍应给出（零不等于缺席）。
    expect(end.usage).toStrictEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    });
  });

  it("real-json-auth-error.json：-o json 的多行输出全部落 raw 诊断通道，流不中断", () => {
    const events = replay("real-json-auth-error.json", { exitCode: GEMINI_EXIT_AUTH_FAILURE });

    expect(events.filter((event) => event.kind === "raw").length).toBeGreaterThan(0);
    expect(events.every((event) => event.kind === "raw" || event.kind === "end")).toBe(true);
    const end = expectEnd(events);
    expect(end.reason).toBe("failed");
    expect(end.exitCode).toBe(GEMINI_EXIT_AUTH_FAILURE);
    // fixture 里的 error.code 与退出码语义表同源（41 = 认证失败）。
    expect(JSON.parse(readFixture("real-json-auth-error.json")).error.code).toBe(
      GEMINI_EXIT_AUTH_FAILURE,
    );
    expect(end.message).toContain("认证失败");
  });

  it("real-session-storage.jsonl：原生会话文件不是事件流，逐行落 raw 且不误判为事件", () => {
    const events = replay("real-session-storage.jsonl");

    expect(events.every((event) => event.kind === "raw" || event.kind === "end")).toBe(true);
    // README 声明：会话文件与 api-error fixture 的 sessionId 一致。
    const [firstLine] = splitLines(readFixture("real-session-storage.jsonl"));
    expect(JSON.parse(firstLine ?? "{}").sessionId).toBe("d0eae9f7-aca4-4ba2-a2c5-ddca42c726c4");
    expect(expectEnd(events).reason).toBe("completed");
  });
});

describe("fixture 回放：文档构造（待真机校验）", () => {
  it("constructed-stream-json-success.jsonl（待真机校验）：delta 聚合 + result 补空 final + 命令无退出码", () => {
    const events = replay("constructed-stream-json-success.jsonl");

    expect(events.map((event) => event.kind)).toStrictEqual([
      "session_start",
      "text",
      "file_change",
      "file_change",
      "command",
      "command",
      "text",
      "text",
      "end",
    ]);

    const texts = events.filter((event) => event.kind === "text");
    // 两条 delta 增量（final:false）+ result 到达时补的空 content final。
    expect(texts.map((event) => event.final)).toStrictEqual([false, false, true]);
    expect(texts.at(-1)?.content).toBe("");
    expect(texts[0]?.content).toContain("I'll create the file first");

    const changes = events.filter((event) => event.kind === "file_change");
    expect(changes.map((event) => event.status)).toStrictEqual(["started", "completed"]);
    expect(changes[1]?.path).toContain("hello.txt");
    // 统一 diff 的 @@ -0,0 表示原文件 0 行 → 新建。
    expect(changes[1]?.changeKind).toBe("add");
    expect(changes[1]?.diff).toContain("@@ -0,0 +1,1 @@");
    expect(changes[0]?.actionId).toBe(changes[1]?.actionId);

    const commands = events.filter((event) => event.kind === "command");
    expect(commands.map((event) => event.status)).toStrictEqual(["started", "completed"]);
    expect(commands[1]?.command).toBe("node -v");
    expect(commands[1]?.output).toBe("v24.4.0");
    // gemini 的 tool_result 没有结构化退出码：exitCode 必须缺席，成败只看 status。
    expect(commands[1]?.exitCode).toBeUndefined();

    const end = expectEnd(events);
    expect(end.reason).toBe("completed");
    expect(end.usage).toStrictEqual({
      inputTokens: 7810,
      outputTokens: 702,
      cachedInputTokens: 0,
      totalTokens: 8512,
    });
  });

  it("constructed-stream-json-headless-deny.jsonl（待真机校验）：被拒 → denied，且 result=success 仍上浮为 failed", () => {
    const events = replay("constructed-stream-json-headless-deny.jsonl");

    const changes = events.filter((event) => event.kind === "file_change");
    expect(changes.map((event) => event.status)).toStrictEqual(["started", "denied"]);

    const end = expectEnd(events);
    // 坑 1：进程退 0、result 是 success，唯一线索是 tool_result 的 denied。
    expect(end.reason).toBe("failed");
    expect(end.exitCode).toBe(0);
    expect(end.message).toContain("headless 静默失败");
    expect(end.message).toContain("write_file");
  });

  it("constructed-json-success.json（待真机校验）：-o json 成功输出同样只落 raw，不产生伪事件", () => {
    const events = replay("constructed-json-success.json");

    expect(events.every((event) => event.kind === "raw" || event.kind === "end")).toBe(true);
    expect(expectEnd(events).reason).toBe("completed");
  });

  it("策略拒绝的真实 errorType 是 policy_violation（源码字面量），映射同样记 denied", () => {
    // fixture 用的是 permission_denied；0.57.0 源码 getPolicyDenialError() 的 errorType
    // 实为 policy_violation（另有一条工具基类路径只抛消息文本）。三种形态都必须记 denied，
    // 否则被 --policy 拒掉的动作会被当成普通失败、丢掉"权限被拒"这一关键语义。
    const mapper = createGeminiEventMapper({ cwd: PROJECT_ROOT });
    const lines = [
      '{"type":"tool_use","tool_name":"write_file","tool_id":"t1","parameters":{"file_path":"a.txt","content":"x"}}',
      '{"type":"tool_result","tool_id":"t1","status":"error","output":"Tool execution denied by policy. FF-pane 拒绝","error":{"type":"policy_violation","message":"Tool execution denied by policy."}}',
      '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"t2","parameters":{"command":"git push"}}',
      '{"type":"tool_result","tool_id":"t2","status":"error","output":"Tool execution for \\"Shell\\" denied by policy.","error":{"type":"TOOL_EXECUTION_ERROR","message":"Tool execution for \\"Shell\\" denied by policy."}}',
    ];
    const events = lines.flatMap((line, index) => {
      const record = parseJsonlLine(line, index + 1);
      return record === undefined ? [] : [...mapper.map(record)];
    });

    expect(events.filter((event) => event.kind === "file_change").at(-1)?.status).toBe("denied");
    expect(events.filter((event) => event.kind === "command").at(-1)?.status).toBe("denied");
    const end = expectEnd([
      ...events,
      ...mapper.finish({ endKind: "exited", exitCode: 0, cancelRequested: false }),
    ]);
    expect(end.reason).toBe("failed");
  });
});

describe("映射器的兜底与截断行为", () => {
  it("脏行与未知事件类型经 raw 通道上交，解析不中断", () => {
    const mapper = createGeminiEventMapper({ cwd: PROJECT_ROOT });
    const events = [
      "WARN: 这不是 JSON",
      '{"type":"todo_list","items":[]}',
      '{"type":"init","session_id":"s1","model":"auto"}',
    ].flatMap((line, index) => {
      const record = parseJsonlLine(line, index + 1);
      return record === undefined ? [] : [...mapper.map(record)];
    });

    expect(events.map((event) => event.kind)).toStrictEqual(["raw", "raw", "session_start"]);
    expect(events[1]).toMatchObject({ nativeType: "todo_list", runtime: "gemini-cli" });
  });

  it("流被截断（无 result）：文本先补 final，再按进程终局合成 end", () => {
    const mapper = createGeminiEventMapper({ cwd: PROJECT_ROOT, sessionId: "pre-generated" });
    const record = parseJsonlLine(
      '{"type":"message","role":"assistant","content":"半句话","delta":true}',
      1,
    );
    const streamed = record === undefined ? [] : [...mapper.map(record)];
    const tail = mapper.finish({ endKind: "killed", exitCode: null, cancelRequested: false });

    expect(streamed.map((event) => event.kind)).toStrictEqual(["text"]);
    expect(tail.map((event) => event.kind)).toStrictEqual(["text", "end"]);
    expect(tail[0]).toMatchObject({ content: "", final: true });
    expect(expectEnd(tail).reason).toBe("crashed");
  });

  it("主动取消：end(reason=cancelled)；退出码 130 同样按取消处理", () => {
    const mapper = createGeminiEventMapper({ cwd: PROJECT_ROOT });
    expect(
      expectEnd(mapper.finish({ endKind: "killed", exitCode: null, cancelRequested: true })).reason,
    ).toBe("cancelled");
    const other = createGeminiEventMapper({ cwd: PROJECT_ROOT });
    expect(
      expectEnd(other.finish({ endKind: "exited", exitCode: 130, cancelRequested: false })).reason,
    ).toBe("cancelled");
  });
});

describe("退出码语义表", () => {
  it("已知码给出人类可读说明", () => {
    expect(describeGeminiExitCode(41)).toContain("认证失败");
    expect(describeGeminiExitCode(41)).toContain("GEMINI_API_KEY");
    expect(describeGeminiExitCode(42)).toContain("输入错误");
    expect(describeGeminiExitCode(53)).toContain("轮数上限");
    expect(describeGeminiExitCode(55)).toContain("--skip-trust");
    expect(describeGeminiExitCode(130)).toContain("取消");
  });

  it("HTTP 状态码透传与未知码都不被规整", () => {
    expect(describeGeminiExitCode(400)).toContain("HTTP 400");
    expect(describeGeminiExitCode(429)).toContain("HTTP 429");
    expect(describeGeminiExitCode(7)).toContain("未列入语义表");
    expect(describeGeminiExitCode(0)).toBeUndefined();
    expect(describeGeminiExitCode(null)).toBeUndefined();
  });
});

describe("--policy TOML 生成器", () => {
  const workerEnvelope: PermissionEnvelope = {
    readPaths: ["**"],
    writePaths: ["src/**"],
    shell: "allowed",
    network: false,
    dangerousOpsRequireApproval: true,
  };
  const plannerEnvelope: PermissionEnvelope = {
    readPaths: ["**"],
    writePaths: [],
    shell: "forbidden",
    network: true,
    dangerousOpsRequireApproval: true,
  };
  const reviewerEnvelope: PermissionEnvelope = {
    readPaths: ["**"],
    writePaths: [],
    shell: "verify_only",
    network: false,
    dangerousOpsRequireApproval: true,
  };

  function verdict(
    rules: readonly GeminiPolicyRule[],
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): string | undefined {
    return evaluateGeminiPolicyRules(rules, { toolName, args })?.decision;
  }

  const workerRules = buildGeminiPolicyRules({
    envelope: workerEnvelope,
    projectRoot: PROJECT_ROOT,
  });

  it("优先级必须压过内置 yolo allow-all（临时目录文件落 DEFAULT 层）", () => {
    expect(GEMINI_POLICY_OVERRIDE_PRIORITY).toBeGreaterThan(GEMINI_YOLO_ALLOW_ALL_PRIORITY);
    expect(workerRules.every((rule) => rule.priority === GEMINI_POLICY_OVERRIDE_PRIORITY)).toBe(
      true,
    );
    // 只生成 deny：放行由 --approval-mode 承担，规则间无优先级歧义。
    expect(workerRules.every((rule) => rule.decision === "deny")).toBe(true);
  });

  it("每条 argsPattern 都过 CLI 的 isSafeRegExp（不过就会被整条静默丢弃）", () => {
    for (const rule of [
      ...workerRules,
      ...buildGeminiPolicyRules({ envelope: plannerEnvelope, projectRoot: PROJECT_ROOT }),
      ...buildGeminiPolicyRules({
        envelope: reviewerEnvelope,
        projectRoot: PROJECT_ROOT,
        verifyCommands: ["pnpm test"],
      }),
    ]) {
      if (rule.argsPattern !== undefined) {
        expect(() => new RegExp(rule.argsPattern as string)).not.toThrow();
        expect(isGeminiSafePolicyRegExp(rule.argsPattern), rule.id).toBe(true);
      }
    }
  });

  it("isSafeRegExp 复刻：分组量词组合被判不安全（真机复核打回过 4 条规则）", () => {
    // CLI 的判据：出现 `(`…量词…`)` 且任何位置有 `)` 紧跟量词即不安全。
    expect(isGeminiSafePolicyRegExp('(?:\\x00|[{,])"command":"[^\\x00]*\\bgit\\b')).toBe(true);
    expect(
      isGeminiSafePolicyRegExp('(?:\\x00|[{,])"command":"[^\\x00]*\\bgit(?:\\.exe)?\\s+push'),
    ).toBe(false);
    expect(isGeminiSafePolicyRegExp("(")).toBe(false);
    expect(isGeminiSafePolicyRegExp(`a${"b".repeat(2100)}`)).toBe(false);
  });

  it("Worker：作用域内写路径放行，越界写路径拒绝", () => {
    expect(
      verdict(workerRules, "write_file", {
        file_path: join(PROJECT_ROOT, "src", "app.ts"),
        content: "export const a = 1;",
      }),
    ).toBeUndefined();
    expect(
      verdict(workerRules, "replace", {
        file_path: join(PROJECT_ROOT, "src", "deep", "nested.ts"),
        old_string: "a",
        new_string: "b",
      }),
    ).toBeUndefined();
    expect(
      verdict(workerRules, "write_file", {
        file_path: join(PROJECT_ROOT, "docs", "note.md"),
        content: "x",
      }),
    ).toBe("deny");
    expect(
      verdict(workerRules, "write_file", { file_path: join(tmpdir(), "escape.txt"), content: "x" }),
    ).toBe("deny");
  });

  it("Worker：普通命令放行，危险命令逐类拒绝", () => {
    expect(
      verdict(workerRules, "run_shell_command", { command: "pnpm run build" }),
    ).toBeUndefined();
    expect(
      verdict(workerRules, "run_shell_command", { command: 'node -e "console.log(1)"' }),
    ).toBeUndefined();

    for (const command of [
      "git push origin main",
      'git commit -m "x" && git push',
      "npm publish",
      "docker push ghcr.io/x:1",
      "npm install -g typescript",
      "winget install Foo",
      "rm -rf ../other",
      "Remove-Item -Recurse -Force build",
      "cat ~/.ssh/id_rsa",
      "type .env",
      "notepad .git/config",
    ]) {
      expect(verdict(workerRules, "run_shell_command", { command }), command).toBe("deny");
    }
  });

  it("Worker：写 .git 与凭证文件即使在作用域内也拒绝；禁网时联网工具禁用", () => {
    expect(
      verdict(workerRules, "write_file", {
        file_path: join(PROJECT_ROOT, "src", ".git", "config"),
        content: "x",
      }),
    ).toBe("deny");
    expect(
      verdict(workerRules, "write_file", {
        file_path: join(PROJECT_ROOT, "src", ".env"),
        content: "KEY=1",
      }),
    ).toBe("deny");
    expect(verdict(workerRules, "google_web_search", { query: "x" })).toBe("deny");
    expect(verdict(workerRules, "web_fetch", { prompt: "https://example.com" })).toBe("deny");
  });

  it("Planner（只读 + shell forbidden）：编辑与命令工具整体禁用，联网放行", () => {
    const rules = buildGeminiPolicyRules({
      envelope: plannerEnvelope,
      projectRoot: PROJECT_ROOT,
    });
    expect(verdict(rules, "write_file", { file_path: "a.ts", content: "x" })).toBe("deny");
    expect(verdict(rules, "run_shell_command", { command: "echo hi" })).toBe("deny");
    expect(verdict(rules, "google_web_search", { query: "x" })).toBeUndefined();
    // 全局 deny（无 argsPattern）会让工具对模型完全隐藏，这是官方推荐的排除方式。
    expect(
      rules.some((rule) => rule.id === "shell-forbidden" && rule.argsPattern === undefined),
    ).toBe(true);
  });

  it("Reviewer（verify_only）：仅放行任务合同的验证命令", () => {
    const rules = buildGeminiPolicyRules({
      envelope: reviewerEnvelope,
      projectRoot: PROJECT_ROOT,
      verifyCommands: ["pnpm test", "pnpm exec tsc --noEmit"],
    });
    expect(verdict(rules, "run_shell_command", { command: "pnpm test" })).toBeUndefined();
    expect(
      verdict(rules, "run_shell_command", { command: "pnpm test -- --coverage" }),
    ).toBeUndefined();
    expect(
      verdict(rules, "run_shell_command", { command: "pnpm exec tsc --noEmit" }),
    ).toBeUndefined();
    expect(verdict(rules, "run_shell_command", { command: "node -v" })).toBe("deny");
    expect(verdict(rules, "run_shell_command", { command: "pnpm testx" })).toBe("deny");
    // 危险命令不因"是验证命令前缀"而豁免。
    expect(verdict(rules, "run_shell_command", { command: "pnpm test && git push" })).toBe("deny");
  });

  it("稳定 JSON 串复刻正确：键按字典序、顶层键值对被 NUL 包裹", () => {
    expect(stringifyGeminiToolArgs({ file_path: "a", content: "b" })).toBe(
      '{\u0000"content":"b"\u0000,\u0000"file_path":"a"\u0000}',
    );
  });

  it("渲染：deny 规则齐全、正则用 TOML literal string 承载", () => {
    const toml = renderGeminiPolicyToml(workerRules, { label: "run-42" });
    expect(toml).toContain("# 标识：run-42");
    expect(toml.match(/\[\[rule\]\]/g)?.length).toBe(workerRules.length);
    expect(toml).toContain(`priority = ${GEMINI_POLICY_OVERRIDE_PRIORITY}`);
    expect(toml).toContain("decision = 'deny'");
    expect(toml).toContain("toolName = ['write_file', 'replace']");
    for (const rule of workerRules) {
      if (rule.argsPattern !== undefined) {
        // 正则里的单引号一律写作 \x27，故必然落在 TOML literal string 里（无转义歧义）。
        expect(rule.argsPattern).not.toContain("'");
        expect(toml).toContain(`argsPattern = '${rule.argsPattern}'`);
      }
    }
  });
});

describe("启动参数构建", () => {
  it("新会话：固定带 stream-json / skip-trust / 显式审批模式 + 预生成会话 ID", () => {
    const plan = buildGeminiCommand({
      prompt: "做点什么",
      approvalMode: "yolo",
      sessionId: "11111111-2222-4333-8444-555555555555",
      model: "pro",
      policyFile: "C:\\Temp\\ff-pane-run.toml",
    });
    expect(plan.args).toStrictEqual([
      "-o",
      "stream-json",
      "--skip-trust",
      "--approval-mode",
      "yolo",
      "--session-id",
      "11111111-2222-4333-8444-555555555555",
      "-m",
      "pro",
      "--policy",
      "C:\\Temp\\ff-pane-run.toml",
      "-p",
      "做点什么",
    ]);
    expect(plan.stdin).toBe("closed");
    expect(plan.stdinPayload).toBeUndefined();
  });

  it("恢复：只传 --resume（与 --session-id 互斥）", () => {
    const plan = buildGeminiCommand({
      prompt: "继续",
      approvalMode: "plan",
      resumeSessionId: "abc",
    });
    expect(plan.args).toContain("--resume");
    expect(plan.args).not.toContain("--session-id");
    expect(() =>
      buildGeminiCommand({
        prompt: "x",
        approvalMode: "yolo",
        sessionId: "a",
        resumeSessionId: "b",
      }),
    ).toThrow(GeminiCommandError);
  });

  it("长提示词改走 stdin 管道，不再重复传 -p", () => {
    const prompt = "长".repeat(50);
    const plan = buildGeminiCommand({ prompt, approvalMode: "yolo", promptArgMaxChars: 10 });
    expect(plan.stdin).toBe("pipe");
    expect(plan.stdinPayload).toBe(prompt);
    expect(plan.args).not.toContain("-p");
  });

  it("策略文件后缀/逗号非法即快速失败（否则规则被静默忽略）", () => {
    expect(() =>
      buildGeminiCommand({ prompt: "x", approvalMode: "yolo", policyFile: "C:\\Temp\\rules.txt" }),
    ).toThrow(GeminiCommandError);
    expect(() =>
      buildGeminiCommand({ prompt: "x", approvalMode: "yolo", policyFile: "C:\\a,b\\rules.toml" }),
    ).toThrow(GeminiCommandError);
  });
});

/** 可控的假子进程：把 fixture 文本当 stdout 交出，用于全链路断言。 */
function createFakeSpawn(script: {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly hold?: boolean;
}): {
  readonly spawn: (spec: AgentProcessSpec) => AgentProcessHandle;
  readonly calls: AgentProcessSpec[];
} {
  const calls: AgentProcessSpec[] = [];
  const spawn = (spec: AgentProcessSpec): AgentProcessHandle => {
    calls.push(spec);
    let settleExit!: (exit: AgentProcessExit) => void;
    const exitPromise = new Promise<AgentProcessExit>((resolve) => {
      settleExit = resolve;
    });
    let releaseKill!: () => void;
    const killed = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const naturalExit: AgentProcessExit = {
      kind: "exited",
      exitCode: script.exitCode ?? 0,
      signal: null,
      error: null,
      errorCode: null,
    };
    if (script.hold !== true) {
      settleExit(naturalExit);
    }

    async function* stdout(): AsyncGenerator<Buffer> {
      yield Buffer.from(script.stdout, "utf8");
      if (script.hold === true) {
        await killed;
      }
    }
    async function* stderr(): AsyncGenerator<Buffer> {
      if (script.stderr !== undefined) {
        yield Buffer.from(script.stderr, "utf8");
      }
      if (script.hold === true) {
        await killed;
      }
    }

    return {
      pid: 4242,
      stdout: stdout(),
      stderr: stderr(),
      stdin: null,
      exitPromise,
      resolvedCommand: spec.command,
      viaCmdShim: false,
      strippedEnvNames: [],
      kill: async (): Promise<AgentProcessExit> => {
        releaseKill();
        settleExit({ kind: "killed", exitCode: null, signal: null, error: null, errorCode: null });
        return exitPromise;
      },
    };
  };
  return { spawn, calls };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

describe("适配器全链路（注入 spawn 接缝）", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ff-pane-gemini-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("能力声明如实（权限转发 no、命令事件与取消 partial）", () => {
    expect(createGeminiCliAdapter().runtime).toBe("gemini-cli");
    expect(createGeminiCliAdapter().capabilities()).toStrictEqual(GEMINI_CLI_CAPABILITIES);
    expect(GEMINI_CLI_CAPABILITIES).toStrictEqual({
      nativeResume: "yes",
      streaming: "yes",
      fileChangeEvents: "yes",
      commandEvents: "partial",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
    // headless 无原生审批通道 → 不实现 respondPermission。
    expect(
      createGeminiCliAdapter({ spawn: createFakeSpawn({ stdout: "" }).spawn }).startTurn({
        cwd: tmpdir(),
        prompt: "x",
      }).respondPermission,
    ).toBeUndefined();
  });

  it("stdout 走事件映射、stderr 全量入 raw；策略文件下发后被删除", async () => {
    const fake = createFakeSpawn({
      stdout: readFixture("constructed-stream-json-success.jsonl"),
      stderr:
        "YOLO mode is enabled. All tool calls will be automatically approved.\nRipgrep is not available\n",
    });
    let policyPathDuringRun: string | undefined;

    const adapter = createGeminiCliAdapter({
      spawn: (spec) => {
        const handle = fake.spawn(spec);
        const index = spec.args?.indexOf("--policy") ?? -1;
        policyPathDuringRun = index === -1 ? undefined : spec.args?.[index + 1];
        return handle;
      },
      permissionEnvelope: {
        readPaths: ["**"],
        writePaths: ["src/**"],
        shell: "allowed",
        network: false,
        dangerousOpsRequireApproval: true,
      },
      policyLabel: "run-1",
      newSessionId: () => "11111111-2222-4333-8444-555555555555",
    });

    const turn = adapter.startTurn({
      cwd: workDir,
      prompt: "做点什么",
      env: { GEMINI_API_KEY: "k" },
    });
    // 策略文件必须在运行期存在（CLI 启动时要读它）。
    if (policyPathDuringRun === undefined) {
      throw new Error("--policy 未下发");
    }
    const policyTomlDuringRun = await readFile(policyPathDuringRun, "utf8");
    const events = await collect(turn.events);

    expect(policyTomlDuringRun).toContain("[[rule]]");
    expect(policyTomlDuringRun).toContain("# 标识：run-1");
    expect(policyPathDuringRun.endsWith(GEMINI_POLICY_FILE_NAME)).toBe(true);
    // 用完即删。
    await expect(stat(policyPathDuringRun)).rejects.toThrow();

    const spec = fake.calls[0];
    expect(spec?.command).toBe("gemini");
    expect(spec?.args).toContain("--skip-trust");
    expect(spec?.args).toContain("--approval-mode");
    expect(spec?.args).toContain("yolo");
    expect(spec?.args).toContain("--session-id");
    expect(spec?.cwd).toBe(workDir);
    // 密钥只经 env 注入表下发（清洗默认开启，注入优先）。
    expect(spec?.env).toStrictEqual({ GEMINI_API_KEY: "k" });

    const stderrRaws = events.filter(
      (event) => event.kind === "raw" && typeof event.native === "string",
    );
    expect(stderrRaws.length).toBe(2);
    expect(stderrRaws[0]).toMatchObject({ native: expect.stringContaining("YOLO mode") });
    expect(events.filter((event) => event.kind === "end").length).toBe(1);
    expect(expectEnd(events).reason).toBe("completed");
  });

  it("cancel：取消后以 end(cancelled) 收尾，幂等", async () => {
    const fake = createFakeSpawn({
      stdout: '{"type":"init","session_id":"s1","model":"auto"}\n',
      hold: true,
    });
    const turn = createGeminiCliAdapter({ spawn: fake.spawn }).startTurn({
      cwd: workDir,
      prompt: "x",
    });

    const received: AgentEvent[] = [];
    for await (const event of turn.events) {
      received.push(event);
      if (event.kind === "session_start") {
        await turn.cancel();
      }
    }

    expect(received[0]?.kind).toBe("session_start");
    expect(expectEnd(received).reason).toBe("cancelled");
    await expect(turn.cancel()).resolves.toBeUndefined();
  });

  it("resume 的 cwd 与本轮不一致：启动前快速失败，不 spawn", async () => {
    const fake = createFakeSpawn({ stdout: "" });
    const turn = createGeminiCliAdapter({ spawn: fake.spawn }).startTurn({
      cwd: workDir,
      prompt: "继续",
      resume: { nativeSessionId: "s-1" as NativeSessionId, cwd: join(workDir, "other") },
    });
    const events = await collect(turn.events);

    expect(fake.calls.length).toBe(0);
    expect(events.map((event) => event.kind)).toStrictEqual(["end"]);
    const end = expectEnd(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("按工作目录隔离");
  });

  it("resume 的 cwd 一致：传 --resume 且 session_start 复用登记的绑定", async () => {
    const fake = createFakeSpawn({ stdout: '{"type":"init","model":"auto"}\n' });
    const turn = createGeminiCliAdapter({ spawn: fake.spawn }).startTurn({
      cwd: workDir,
      prompt: "继续",
      resume: { nativeSessionId: "s-42" as NativeSessionId, cwd: workDir },
    });
    const events = await collect(turn.events);

    expect(fake.calls[0]?.args).toContain("--resume");
    expect(fake.calls[0]?.args).toContain("s-42");
    const [start] = events;
    if (start?.kind !== "session_start") {
      throw new Error("首事件应为 session_start");
    }
    // init 未报 session_id 时，回落到启动时登记的绑定。
    expect(start.native).toStrictEqual({ nativeSessionId: "s-42", cwd: workDir });
  });
});

describe("真机验证（本机 Gemini CLI 无认证，只能覆盖错误路径）", () => {
  let installed = false;
  let workDir: string;

  beforeAll(async () => {
    const handle = spawnAgentProcess({ command: "gemini", args: ["--version"], stdin: "closed" });
    const drain = async (stream: AsyncIterable<Buffer>): Promise<void> => {
      for await (const _chunk of stream) {
        // 丢弃
      }
    };
    await Promise.all([drain(handle.stdout), drain(handle.stderr)]);
    const exit = await handle.exitPromise;
    installed = exit.kind === "exited" && exit.exitCode === 0;
    workDir = await mkdtemp(join(tmpdir(), "ff-pane-gemini-real-"));
  }, 120_000);

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("无认证真实运行：退出码 41 → end(failed) 带认证提示，stderr 入 raw", async (ctx) => {
    if (!installed) {
      ctx.skip();
    }
    const turn = createGeminiCliAdapter({
      permissionEnvelope: {
        readPaths: ["**"],
        writePaths: ["**"],
        shell: "allowed",
        network: false,
        dangerousOpsRequireApproval: true,
      },
      policyLabel: "w2.5-real-machine",
    }).startTurn({ cwd: workDir, prompt: "Say hello", timeoutMs: 90_000 });
    const events = await collect(turn.events);

    const end = expectEnd(events);
    expect(end.reason).toBe("failed");
    expect(end.exitCode).toBe(GEMINI_EXIT_AUTH_FAILURE);
    expect(end.message).toContain("认证失败");
    const stderrText = events
      .filter((event) => event.kind === "raw" && typeof event.native === "string")
      .map((event) => String((event as { native: unknown }).native))
      .join("\n");
    // stderr 的认证提示原样留档（不参与解析）。
    expect(stderrText).toContain("GEMINI_API_KEY");
    // 真机校验策略文件本身被完整接受：CLI 对每条不合格规则都会打印
    // `[USER] Policy file error …` 并**静默丢弃该规则**，出现即意味着防护失效。
    expect(stderrText).not.toContain("Policy file error");
  }, 120_000);
});
