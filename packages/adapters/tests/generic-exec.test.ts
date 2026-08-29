/**
 * W2.2 generic-exec（L2 通用单次命令接入）测试。
 *
 * 原则同 W2.1a：不 mock child_process——假 CLI 用 node 内联脚本（node -e "…"）
 * 真实 spawn；Windows 的 .cmd 垫片注入面用临时目录里的真垫片验证。
 */

/// <reference types="node" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { NativeSessionBinding, NativeSessionId } from "@ff-pane/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterTurnContext,
  AgentEvent,
  GenericExecConfig,
  GenericExecOutputFormat,
} from "../src/index.js";
import {
  createAdapterRegistry,
  createGenericExecAdapter,
  DEFAULT_ARGV_LENGTH_LIMIT,
  GENERIC_EXEC_CAPABILITIES,
  GenericExecConfigError,
  isKnownRuntime,
  measureArgvLength,
  renderGenericExecArgs,
  resolveGenericExecCwd,
  TASK_PLACEHOLDER,
  validateGenericExecConfig,
} from "../src/index.js";

const NODE = process.execPath;
const isWindows = process.platform === "win32";

/**
 * 构造 node 内联脚本的参数：用户参数必须跟在 `--` 之后，否则 node 会把
 * `--prompt` 之类当成自己的选项并以 "bad option" 退出（实测 exit 9）。
 * 加了 `--` 之后子进程里的用户参数就是 process.argv.slice(1)。
 */
function nodeArgs(script: string, ...userArgs: string[]): string[] {
  return ["-e", script, "--", ...userArgs];
}

/** 假 CLI：把收到的用户参数原样以 JSON 吐回 stdout。 */
const PRINT_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

/** 假 CLI：把 stdin 全文与用户参数一并回报（stdin 模式用）。 */
const REPORT_STDIN = [
  "let d = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { d += c; });",
  "process.stdin.on('end', () => {",
  "  process.stdout.write(JSON.stringify({",
  "    len: d.length, head: d.slice(0, 12), tail: d.slice(-12),",
  "    argv: process.argv.slice(1),",
  "  }));",
  "});",
].join("");

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "ff-pane-generic-"));
});

afterEach(async () => {
  if (workDir !== "") {
    await rm(workDir, { recursive: true, force: true });
  }
});

/** 本轮上下文的可覆盖项（exactOptionalPropertyTypes 下逐项条件展开，不用 Partial 展开）。 */
interface TurnOverrides {
  readonly prompt?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly resume?: NativeSessionBinding;
}

function turnContext(overrides: TurnOverrides = {}): AdapterTurnContext {
  return {
    cwd: workDir,
    prompt: overrides.prompt ?? "",
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.resume !== undefined ? { resume: overrides.resume } : {}),
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

async function runTurn(config: GenericExecConfig, ctx: TurnOverrides = {}): Promise<AgentEvent[]> {
  return collect(createGenericExecAdapter(config).startTurn(turnContext(ctx)).events);
}

/** 取唯一的 text 事件内容（契约：每轮恰好一条）。 */
function answerOf(events: readonly AgentEvent[]): string {
  const texts = events.filter((event) => event.kind === "text");
  expect(texts).toHaveLength(1);
  const [text] = texts;
  if (text?.kind !== "text") {
    throw new Error("缺少 text 事件");
  }
  expect(text.final).toBe(true);
  expect(text.channel).toBe("answer");
  return text.content;
}

/** 取末尾的 end 事件（契约：恰好一条且在最后）。 */
function endOf(events: readonly AgentEvent[]): Extract<AgentEvent, { kind: "end" }> {
  expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
  const end = events.at(-1);
  if (end?.kind !== "end") {
    throw new Error("事件流必须以 end 收尾");
  }
  return end;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("argv 模式：占位符替换与防注入", () => {
  /** 一个尽可能刻薄的任务文本：空格、引号、中文、shell 元字符、换行、反斜杠。 */
  const NASTY_TASK = [
    '把 "报表" 生成一下',
    "&& echo INJECTED",
    "| type C:\\Windows\\win.ini",
    "$(id) `whoami` %PATH% !bang!",
    "path\\with\\back\\slashes\\",
    "换行也要活着",
  ].join("\n");

  it("任务文本作为单个 argv 元素原样抵达（含空格/引号/中文/元字符/换行）", async () => {
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs(PRINT_ARGV, "--prompt", TASK_PLACEHOLDER, "--json"),
        taskDelivery: "argv",
      },
      { prompt: NASTY_TASK },
    );

    expect(events.map((event) => event.kind)).toStrictEqual(["text", "end"]);
    // 元字符没有变成新的参数、也没有被 shell 解释：argv 结构与任务文本都精确
    expect(JSON.parse(answerOf(events))).toStrictEqual(["--prompt", NASTY_TASK, "--json"]);
    expect(endOf(events).reason).toBe("completed");
  }, 20_000);

  it("同一元素内的多个占位符与多个含占位符的元素都替换", () => {
    expect(
      renderGenericExecArgs(
        [`--a=${TASK_PLACEHOLDER}`, `${TASK_PLACEHOLDER}|${TASK_PLACEHOLDER}`],
        "T",
      ),
    ).toStrictEqual(["--a=T", "T|T"]);
    // 不含占位符的元素不受影响，且替换只发生在元素内部（不做分词）
    expect(renderGenericExecArgs(["--json", TASK_PLACEHOLDER], "a b c")).toStrictEqual([
      "--json",
      "a b c",
    ]);
  });

  it("stdout 全文即答案：中文跨 chunk 边界不乱码、不丢字节", async () => {
    const block = "中文输出测试".repeat(2000);
    const script = [
      `const line = '${"中文输出测试".repeat(4)}'.repeat(500) + '\\n';`,
      "for (let i = 0; i < 20; i += 1) { process.stdout.write(line); }",
    ].join("");
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(script, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    const answer = answerOf(events);
    expect(answer.includes("\uFFFD")).toBe(false);
    expect(answer.length).toBe((block.length + 1) * 20);
    expect(endOf(events).reason).toBe("completed");
  }, 30_000);
});

describe("Windows .cmd 垫片下的注入面（真垫片验证）", () => {
  let shimDir = "";
  let shimPath = "";

  beforeAll(async () => {
    shimDir = await mkdtemp(path.join(tmpdir(), "ff-pane-generic-shim-"));
    await writeFile(
      path.join(shimDir, "print-argv.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );
    shimPath = path.join(shimDir, "ff-pane-generic-fake.cmd");
    // npm 全局垫片同形：批处理内用 %* 转发参数，参数会被 cmd 二次解析。
    await writeFile(
      shimPath,
      ["@ECHO off", 'node "%~dp0print-argv.js" %*', ""].join("\r\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    if (shimDir !== "") {
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isWindows)(
    "任务文本里的 cmd 元字符不产生第二条命令",
    async () => {
      const task = 'a & echo INJECTED & (dir) | findstr x > out.txt "quoted" %PATH% ^caret^ 中文';
      const events = await runTurn(
        { command: shimPath, args: ["--prompt", TASK_PLACEHOLDER], taskDelivery: "argv" },
        { prompt: task },
      );
      const answer = answerOf(events);
      expect(JSON.parse(answer)).toStrictEqual(["--prompt", task]);
      // INJECTED 只作为参数文本出现（在 JSON 里），没有被 cmd 当命令执行过
      expect(answer.split("INJECTED")).toHaveLength(2);
      expect(endOf(events).reason).toBe("completed");
    },
    30_000,
  );
});

describe("stdin 模式：长文本投递", () => {
  it("远超 8191 字符的任务文本经 stdin 完整抵达，argv 不含任务文本", async () => {
    const task = `${"甲乙丙丁".repeat(10_000)}<<END>>`;
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs(REPORT_STDIN, "--stdin-mode"),
        taskDelivery: "stdin",
      },
      { prompt: task },
    );

    const report = JSON.parse(answerOf(events)) as {
      len: number;
      head: string;
      tail: string;
      argv: string[];
    };
    expect(task.length).toBeGreaterThan(DEFAULT_ARGV_LENGTH_LIMIT);
    expect(report.len).toBe(task.length);
    expect(report.head).toBe(task.slice(0, 12));
    expect(report.tail).toBe(task.slice(-12));
    expect(report.tail.endsWith("<<END>>")).toBe(true);
    expect(report.argv).toStrictEqual(["--stdin-mode"]);
    expect(endOf(events).reason).toBe("completed");
  }, 30_000);

  it("stdin 模式下 CLI 立即读到 EOF（不挂起）", async () => {
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs(REPORT_STDIN),
        taskDelivery: "stdin",
        timeoutMs: 15_000,
      },
      { prompt: "" },
    );
    expect(JSON.parse(answerOf(events))).toMatchObject({ len: 0, argv: [] });
    expect(endOf(events).reason).toBe("completed");
  }, 20_000);

  it("argv 模式下超长任务文本快速失败且不启动进程", async () => {
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs(PRINT_ARGV, TASK_PLACEHOLDER),
        taskDelivery: "argv",
      },
      { prompt: "长".repeat(DEFAULT_ARGV_LENGTH_LIMIT + 1) },
    );
    // 没有 text 事件 = 进程从未启动，只有一条 end
    expect(events.map((event) => event.kind)).toStrictEqual(["end"]);
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("stdin");
    expect(end.message).toContain("8191");
  });

  it("argvLengthLimit: 0 关闭预检（POSIX 的 ARG_MAX 远高于 8191）", async () => {
    const task = "x".repeat(20_000);
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs("process.stdout.write(String(process.argv[1].length))", TASK_PLACEHOLDER),
        taskDelivery: "argv",
        argvLengthLimit: 0,
      },
      { prompt: task },
    );
    // 预检没有拦下来即达成本例目的；真实平台上限（Windows 垫片 8191 / POSIX
    // ARG_MAX）另由 W2.1a 负责，故成败不做强断言。
    const end = endOf(events);
    expect(end.message ?? "").not.toContain("请把 taskDelivery 改为 stdin");
    if (end.reason === "completed") {
      expect(answerOf(events)).toBe(String(task.length));
    }
  }, 30_000);
});

describe("进程退出 → end 映射", () => {
  it("退出码 0 → completed", async () => {
    const events = await runTurn({
      command: NODE,
      args: nodeArgs("process.stdout.write('ok')", TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    const end = endOf(events);
    expect(end.reason).toBe("completed");
    expect(end.exitCode).toBe(0);
    expect(end.message).toBeUndefined();
    expect(answerOf(events)).toBe("ok");
  }, 20_000);

  it("非零退出码 → failed，退出码与 stderr 摘录进 message", async () => {
    const script = [
      "process.stdout.write('partial');",
      "process.stderr.write('boom: 配置文件缺失');",
      "process.exitCode = 3;",
    ].join("");
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(script, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.exitCode).toBe(3);
    expect(end.message).toContain("3");
    expect(end.message).toContain("boom: 配置文件缺失");
    // 失败也照样交出已收到的 stdout
    expect(answerOf(events)).toBe("partial");
  }, 20_000);

  it("命令不存在 → failed / ENOENT，message 可行动", async () => {
    const events = await runTurn({
      command: "ff-pane-no-such-generic-cli-20260829",
      args: [TASK_PLACEHOLDER],
      taskDelivery: "argv",
    });
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("ENOENT");
    expect(end.exitCode).toBeUndefined();
    expect(answerOf(events)).toBe("");
  }, 20_000);

  it("成功但 stdout 为空时也带上 stderr 线索", async () => {
    const events = await runTurn({
      command: NODE,
      args: nodeArgs("process.stderr.write('提示：本次无输出')", TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    const end = endOf(events);
    expect(end.reason).toBe("completed");
    expect(end.message).toContain("提示：本次无输出");
    expect(answerOf(events)).toBe("");
  }, 20_000);

  it("stderr 摘录经脱敏，密钥不进事件流（设计文档 §4.3）", async () => {
    const script = [
      "process.stderr.write('auth failed with key sk-abcdefghijklmnopqrstuvwxyz012345');",
      "process.exitCode = 1;",
    ].join("");
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(script, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("[REDACTED]");
    expect(end.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  }, 20_000);
});

describe("超时与取消", () => {
  const HANG = "process.stdout.write('up\\n');setInterval(() => {}, 1000)";

  it("超时 → cancelled，message 注明 timeoutMs；ctx.timeoutMs 优先于配置", async () => {
    const events = await runTurn(
      {
        command: NODE,
        args: nodeArgs(HANG, TASK_PLACEHOLDER),
        taskDelivery: "argv",
        timeoutMs: 60_000,
      },
      { timeoutMs: 500 },
    );
    const end = endOf(events);
    expect(end.reason).toBe("cancelled");
    expect(end.message).toContain("timeoutMs=500");
    // 超时前已到达的输出照旧交出
    expect(answerOf(events)).toBe("up\n");
  }, 30_000);

  it("cancel() → end(reason=cancelled)，且幂等", async () => {
    const turn = createGenericExecAdapter({
      command: NODE,
      args: nodeArgs(HANG, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    }).startTurn(turnContext());

    const collecting = collect(turn.events);
    await delay(500);
    await turn.cancel();
    const events = await collecting;

    expect(endOf(events).reason).toBe("cancelled");
    expect(answerOf(events)).toBe("up\n");
    await expect(turn.cancel()).resolves.toBeUndefined();
  }, 30_000);
});

describe("stderr 不阻塞", () => {
  it("6 MiB stderr（超默认 4 MiB 背压水位）不卡死，stdout 结论完整", async () => {
    const script = [
      "const block = 'z'.repeat(64 * 1024);",
      "for (let i = 0; i < 96; i += 1) { process.stderr.write(block); }",
      "process.stdout.write('DONE');",
    ].join("");
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(script, TASK_PLACEHOLDER),
      taskDelivery: "argv",
      stderrCaptureLimit: 1024,
    });
    expect(answerOf(events)).toBe("DONE");
    const end = endOf(events);
    expect(end.reason).toBe("completed");
    // 捕获上限只截断留存，不截断消费（否则子进程会被背压堵死）
    expect(end.message).toBeUndefined();
  }, 60_000);
});

describe("outputFormat: jsonl", () => {
  const JSONL_SCRIPT = [
    'process.stdout.write(\'{"type":"progress","step":1}\\n\');',
    "process.stdout.write('WARN 这是一条裸文本诊断行\\n');",
    'process.stdout.write(\'{"type":"result","text":"完成"}\\n\');',
  ].join("");

  it("逐行透传为 raw（脏行带原因），答案文本照旧给出", async () => {
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(JSONL_SCRIPT, TASK_PLACEHOLDER),
      taskDelivery: "argv",
      outputFormat: "jsonl",
    });

    expect(events.map((event) => event.kind)).toStrictEqual(["raw", "raw", "raw", "text", "end"]);
    const raws = events.filter((event) => event.kind === "raw");
    expect(raws.map((raw) => raw.runtime)).toStrictEqual([
      "generic-exec",
      "generic-exec",
      "generic-exec",
    ]);
    expect(raws[0]).toMatchObject({ nativeType: "progress" });
    expect(raws[1]?.native).toBe("WARN 这是一条裸文本诊断行");
    expect(raws[1]?.note).toBeTypeOf("string");
    expect(raws[2]).toMatchObject({ nativeType: "result" });

    expect(answerOf(events)).toContain('"text":"完成"');
    expect(endOf(events).reason).toBe("completed");
  }, 20_000);

  it("默认 text 模式不产生任何 raw 事件", async () => {
    const events = await runTurn({
      command: NODE,
      args: nodeArgs(JSONL_SCRIPT, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    expect(events.map((event) => event.kind)).toStrictEqual(["text", "end"]);
  }, 20_000);
});

describe("工作目录与环境变量", () => {
  const CWD_SCRIPT = "process.stdout.write(process.cwd())";
  const ENV_PROBE = [
    "const out = {};",
    "for (const name of process.argv.slice(1)) { out[name] = process.env[name] ?? null; }",
    "process.stdout.write(JSON.stringify(out));",
  ].join("");

  it("turn 策略用 ctx.cwd，fixed 策略用配置的绝对路径", async () => {
    const turnEvents = await runTurn({
      command: NODE,
      args: nodeArgs(CWD_SCRIPT, TASK_PLACEHOLDER),
      taskDelivery: "argv",
    });
    expect(answerOf(turnEvents).toLowerCase()).toContain(path.basename(workDir).toLowerCase());

    const fixedDir = await mkdtemp(path.join(tmpdir(), "ff-pane-generic-fixed-"));
    try {
      const fixedEvents = await runTurn({
        command: NODE,
        args: nodeArgs(CWD_SCRIPT, TASK_PLACEHOLDER),
        taskDelivery: "argv",
        cwd: { mode: "fixed", path: fixedDir },
      });
      expect(answerOf(fixedEvents).toLowerCase()).toContain(path.basename(fixedDir).toLowerCase());
    } finally {
      await rm(fixedDir, { recursive: true, force: true });
    }

    expect(
      resolveGenericExecCwd(
        { command: "x", args: [], taskDelivery: "stdin", cwd: { mode: "turn" } },
        path.join(tmpdir(), "proj"),
      ),
    ).toBe(path.join(tmpdir(), "proj"));
  }, 30_000);

  it("配置 env 与 ctx.env 合并（ctx 优先），默认剥离用户 shell 的 API key", async () => {
    const probed = ["FF_PANE_GENERIC_CANARY", "FF_PANE_GENERIC_WINS", "OPENAI_API_KEY"];
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-user-shell-poison";
    try {
      const events = await runTurn(
        {
          command: NODE,
          args: nodeArgs(ENV_PROBE, ...probed),
          taskDelivery: "stdin",
          env: { FF_PANE_GENERIC_CANARY: "from-config", FF_PANE_GENERIC_WINS: "config" },
        },
        { env: { FF_PANE_GENERIC_WINS: "ctx" } },
      );
      expect(JSON.parse(answerOf(events))).toStrictEqual({
        FF_PANE_GENERIC_CANARY: "from-config",
        FF_PANE_GENERIC_WINS: "ctx",
        OPENAI_API_KEY: null,
      });

      const unstripped = await runTurn({
        command: NODE,
        args: nodeArgs(ENV_PROBE, ...probed),
        taskDelivery: "stdin",
        stripApiKeyEnv: false,
      });
      expect(JSON.parse(answerOf(unstripped))).toMatchObject({
        OPENAI_API_KEY: "sk-user-shell-poison",
      });
    } finally {
      if (previous === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = previous;
      }
    }
  }, 30_000);
});

describe("适配器身份与能力声明", () => {
  const MINIMAL: GenericExecConfig = {
    command: NODE,
    args: nodeArgs(PRINT_ARGV),
    taskDelivery: "stdin",
  };

  it("runtime 为 generic-exec（已在 KNOWN_RUNTIMES），可入注册表", () => {
    const adapter = createGenericExecAdapter(MINIMAL);
    expect(adapter.runtime).toBe("generic-exec");
    expect(isKnownRuntime(adapter.runtime)).toBe(true);
    expect(adapter.displayName).toContain(NODE);

    const registry = createAdapterRegistry();
    registry.register(adapter);
    expect(registry.get("generic-exec")).toBe(adapter);
  });

  it("能力如实声明：五项 no，取消为 partial（只能树杀）", () => {
    expect(createGenericExecAdapter(MINIMAL).capabilities()).toStrictEqual({
      nativeResume: "no",
      streaming: "no",
      fileChangeEvents: "no",
      commandEvents: "no",
      permissionForwarding: "no",
      gracefulCancel: "partial",
    });
    expect(GENERIC_EXEC_CAPABILITIES.nativeResume).toBe("no");
  });

  it("无权限转发能力，故 turn 不实现 respondPermission", async () => {
    const turn = createGenericExecAdapter(MINIMAL).startTurn(turnContext());
    expect(turn.respondPermission).toBeUndefined();
    await turn.cancel();
  }, 20_000);

  it("displayName 可覆盖", () => {
    expect(createGenericExecAdapter({ ...MINIMAL, displayName: "我的小工具" }).displayName).toBe(
      "我的小工具",
    );
  });

  it("误传 resume 时快速失败（L2 无会话连续性），不启动进程", async () => {
    const resume: NativeSessionBinding = {
      nativeSessionId: "whatever" as NativeSessionId,
      cwd: workDir,
    };
    const events = await runTurn(MINIMAL, { resume });
    expect(events.map((event) => event.kind)).toStrictEqual(["end"]);
    const end = endOf(events);
    expect(end.reason).toBe("failed");
    expect(end.message).toContain("无原生会话");
  });
});

describe("配置校验", () => {
  const BASE: GenericExecConfig = {
    command: "mytool",
    args: ["--prompt", TASK_PLACEHOLDER],
    taskDelivery: "argv",
  };

  it("合法配置通过", () => {
    expect(validateGenericExecConfig(BASE)).toStrictEqual({ ok: true });
    expect(validateGenericExecConfig({ ...BASE, args: [], taskDelivery: "stdin" })).toStrictEqual({
      ok: true,
    });
  });

  function fieldsOf(config: GenericExecConfig): string[] {
    const result = validateGenericExecConfig(config);
    return result.ok ? [] : result.violations.map((violation) => violation.field);
  }

  it("命令为空 / 命令含占位符", () => {
    expect(fieldsOf({ ...BASE, command: "   " })).toContain("command");
    expect(fieldsOf({ ...BASE, command: `tool-${TASK_PLACEHOLDER}` })).toContain("command");
  });

  it("argv 模式缺占位符、stdin 模式多占位符", () => {
    expect(fieldsOf({ ...BASE, args: ["--json"] })).toStrictEqual(["args"]);
    expect(fieldsOf({ ...BASE, taskDelivery: "stdin" })).toStrictEqual(["args"]);
  });

  it("fixed 工作目录必须是非空绝对路径", () => {
    expect(fieldsOf({ ...BASE, cwd: { mode: "fixed", path: "" } })).toStrictEqual(["cwd.path"]);
    expect(fieldsOf({ ...BASE, cwd: { mode: "fixed", path: "relative/dir" } })).toStrictEqual([
      "cwd.path",
    ]);
    expect(fieldsOf({ ...BASE, cwd: { mode: "turn" } })).toStrictEqual([]);
  });

  it("数值域与输出格式", () => {
    expect(fieldsOf({ ...BASE, timeoutMs: -1 })).toStrictEqual(["timeoutMs"]);
    expect(fieldsOf({ ...BASE, timeoutMs: 1.5 })).toStrictEqual(["timeoutMs"]);
    expect(fieldsOf({ ...BASE, argvLengthLimit: -5 })).toStrictEqual(["argvLengthLimit"]);
    expect(fieldsOf({ ...BASE, stderrCaptureLimit: 0 })).toStrictEqual(["stderrCaptureLimit"]);
    expect(fieldsOf({ ...BASE, outputFormat: "yaml" as GenericExecOutputFormat })).toStrictEqual([
      "outputFormat",
    ]);
    expect(
      fieldsOf({ ...BASE, taskDelivery: "shell" as GenericExecConfig["taskDelivery"] }),
    ).toStrictEqual(["taskDelivery"]);
  });

  it("env 名非法 / env 值里误用占位符", () => {
    expect(fieldsOf({ ...BASE, env: { "BAD=NAME": "x" } })).toStrictEqual(["env.BAD=NAME"]);
    expect(fieldsOf({ ...BASE, env: { PROMPT: TASK_PLACEHOLDER } })).toStrictEqual(["env.PROMPT"]);
  });

  it("一次返回全部违规（表单场景）", () => {
    const result = validateGenericExecConfig({
      command: "",
      args: ["--json"],
      taskDelivery: "argv",
      timeoutMs: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.field).sort()).toStrictEqual([
        "args",
        "command",
        "timeoutMs",
      ]);
    }
  });

  it("createGenericExecAdapter 对非法配置抛 GenericExecConfigError（携带违规）", () => {
    let caught: unknown;
    try {
      createGenericExecAdapter({ ...BASE, args: ["--json"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GenericExecConfigError);
    if (caught instanceof GenericExecConfigError) {
      expect(caught.name).toBe("GenericExecConfigError");
      expect(caught.violations.map((violation) => violation.field)).toStrictEqual(["args"]);
      expect(caught.message).toContain("args");
    }
  });

  it("measureArgvLength 计入分隔位", () => {
    expect(measureArgvLength([])).toBe(0);
    expect(measureArgvLength(["ab", "cde"])).toBe(2 + 1 + 3 + 1);
  });
});
