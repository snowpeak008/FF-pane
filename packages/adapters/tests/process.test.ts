/**
 * W2.1a 子进程管理层测试。
 *
 * 原则：不 mock child_process——假 CLI 用 node 内联脚本（node -e "..."）真实
 * spawn，Windows 垫片路径用临时目录里的真 .cmd 垫片，孙进程清理用 tasklist 查证。
 */

/// <reference types="node" />

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_KEY_ENV_PATTERNS,
  ByteChunkQueue,
  buildAgentEnv,
  buildCmdShimCommandLine,
  EXIT_SETTLE_GRACE_MS,
  findExecutableOnWindowsPath,
  isApiKeyEnvName,
  killProcessTree,
  resolveSpawnTarget,
  spawnAgentProcess,
} from "../src/index.js";

const NODE = process.execPath;
const isWindows = process.platform === "win32";

/** 收齐一条流的所有块（保留分块信息，用于完整性断言）。 */
async function drain(stream: AsyncIterable<Buffer>): Promise<{ chunks: Buffer[]; text: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return { chunks, text: Buffer.concat(chunks).toString("utf8") };
}

/** 读到第一个换行为止（假 CLI 用它回报孙进程 pid）。 */
async function readFirstLine(stream: AsyncIterable<Buffer>): Promise<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      return buffer.slice(0, newline).trim();
    }
  }
  return buffer.trim();
}

/**
 * 等到队列的排队字节数达到 target 为止（消费端此刻不该在取字节，否则条件不单调）。
 * 返回是否等到，交由调用方断言——超时静默通过会把一次真实回归读成成功。
 */
async function waitForPendingBytes(
  queue: ByteChunkQueue,
  target: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (queue.pendingBytes >= target) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

/** Windows：用 tasklist 查证 pid 是否还在（进程树终止的独立证据）。 */
function pidAlive(pid: number): Promise<boolean> {
  if (!isWindows) {
    try {
      process.kill(pid, 0);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  return new Promise<boolean>((resolve) => {
    const list = spawn("tasklist", ["/FI", `PID eq ${String(pid)}`, "/NH"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    list.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    list.once("close", () => {
      resolve(out.includes(String(pid)));
    });
    list.once("error", () => {
      resolve(false);
    });
  });
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await pidAlive(pid))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

describe("spawnAgentProcess：正常退出与退出码", () => {
  it("stdout 原样送达，退出码 0，结束方式 exited", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('hello ff-pane')"],
    });
    const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    expect(stdout.text).toBe("hello ff-pane");
    expect(exit.kind).toBe("exited");
    expect(exit.exitCode).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.error).toBeNull();
    expect(handle.pid).toBeTypeOf("number");
  });

  it("非零退出码原样传递", async () => {
    const handle = spawnAgentProcess({ command: NODE, args: ["-e", "process.exit(7)"] });
    await drain(handle.stdout);
    const exit = await handle.exitPromise;
    expect(exit.kind).toBe("exited");
    expect(exit.exitCode).toBe(7);
  });

  it("cwd 生效", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ff-pane-cwd-"));
    try {
      const handle = spawnAgentProcess({
        command: NODE,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: dir,
      });
      const [stdout] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
      expect(stdout.text.toLowerCase()).toContain(path.basename(dir).toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnAgentProcess：流的完整性与分离", () => {
  it("大输出不丢字节（超过 highWaterMark，走背压 pause/resume）", async () => {
    const lineLength = 1000;
    const lineCount = 5_000;
    const script = [
      `const line = 'x'.repeat(${String(lineLength - 1)}) + '\\n';`,
      `for (let i = 0; i < ${String(lineCount)}; i += 1) { process.stdout.write(line); }`,
    ].join("");
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", script],
      streamHighWaterMark: 64 * 1024,
    });
    const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    expect(stdout.text.length).toBe(lineLength * lineCount);
    expect(stdout.chunks.length).toBeGreaterThan(1);
    // 顺序完整：切行后每行都应是完整的 999 个 x
    const lines = stdout.text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.length - 1).toBe(lineCount);
    expect(new Set(lines.slice(0, -1).map((line) => line.length)).size).toBe(1);
    expect(exit.exitCode).toBe(0);
  }, 30_000);

  it("消费端停住时队列顶到上限（触发 pause），放行后依然不丢字节", async () => {
    const blockSize = 1024;
    const blockCount = 4096;
    const highWaterMark = 16 * 1024;
    const script = [
      `const block = 'y'.repeat(${String(blockSize)});`,
      `for (let i = 0; i < ${String(blockCount)}; i += 1) { process.stdout.write(block); }`,
    ].join("");
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", script],
      streamHighWaterMark: highWaterMark,
    });
    const queue = handle.stdout as ByteChunkQueue;
    const iterator = queue[Symbol.asyncIterator]();

    // 先取一块，确认流已经开始产出。
    const first = await iterator.next();
    expect(first.done).toBe(false);
    let received = first.value?.length ?? 0;

    // 然后**把消费端按住不动**，等生产端自己把队列顶到上限。产出总量（4 MiB）远大于
    // 上限（16 KiB），且这期间没有任何一处在取走字节，故 pendingBytes 只增不减——
    // 积压窗口由这个等待条件确定，不再取决于「消费恰好慢于生产」。
    //
    // 原先的写法是「消费端每块睡 2 ms，顺便看一眼 pendingBytes」：而 pause 恰好发生在
    // 队列达到上限的那一刻，紧接着的一次 shift 就把它降回上限以下，所以采样点看到的
    // 几乎总是「刚刚被抽走一块之后」的低水位。要采到 >= 上限，得赶上「队列一次积压了
    // 两块以上」的巧合，而那取决于机器负载与管道分块大小——这就是 §4.5 登记的
    // 「全量并发下偶发 sawBacklog 不成立」。
    const sawBacklog = await waitForPendingBytes(queue, highWaterMark, 20_000);
    expect(sawBacklog).toBe(true);

    // 放行：resume 之后剩余字节必须一个不少地交完。
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      received += next.value.length;
    }
    expect(received).toBe(blockSize * blockCount);
    expect((await handle.exitPromise).exitCode).toBe(0);
  }, 30_000);

  it("stderr 与 stdout 分离", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('OUT');process.stderr.write('ERR')"],
    });
    const [stdout, stderr] = await Promise.all([
      drain(handle.stdout),
      drain(handle.stderr),
      handle.exitPromise,
    ]);
    expect(stdout.text).toBe("OUT");
    expect(stderr.text).toBe("ERR");
  });

  it("stdin 关闭模式下 CLI 立即读到 EOF（不挂起）", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: [
        "-e",
        "process.stdin.on('end', () => process.stdout.write('eof'));process.stdin.resume()",
      ],
      stdin: "closed",
      timeoutMs: 10_000,
    });
    expect(handle.stdin).toBeNull();
    const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    expect(stdout.text).toBe("eof");
    expect(exit.kind).toBe("exited");
  });

  it("stdin 管道模式可写入并以 end 收口", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: [
        "-e",
        "let d='';process.stdin.on('data',(c)=>{d+=c});process.stdin.on('end',()=>process.stdout.write('got:'+d))",
      ],
      stdin: "pipe",
    });
    expect(handle.stdin).not.toBeNull();
    handle.stdin?.end("ping\n");
    const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    expect(stdout.text).toBe("got:ping\n");
    expect(exit.exitCode).toBe(0);
  });
});

describe("ByteChunkQueue：块边界不合并、不错序", () => {
  it("逐块原样产出源流的每个 data 块", async () => {
    const source = new PassThrough();
    const queue = new ByteChunkQueue(source);
    source.write("first");
    source.write("second");
    source.write("third");
    source.end();
    const { chunks, text } = await drain(queue);
    expect(chunks.map((chunk) => chunk.toString("utf8"))).toEqual(["first", "second", "third"]);
    expect(text).toBe("firstsecondthird");
  });

  it("源流为 null 时是一条空的已结束流", async () => {
    const { chunks } = await drain(new ByteChunkQueue(null));
    expect(chunks).toEqual([]);
  });

  it("源流报错时先交完已排队字节，再抛出", async () => {
    const source = new PassThrough();
    const queue = new ByteChunkQueue(source);
    source.write("partial");
    source.destroy(new Error("boom"));
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of queue) {
        seen.push(chunk.toString("utf8"));
      }
    }).rejects.toThrow("boom");
    expect(seen).toEqual(["partial"]);
  });
});

describe("环境变量清洗", () => {
  const ENV_PROBE = [
    "const out = {};",
    "for (const name of process.argv.slice(1)) { out[name] = process.env[name] ?? null; }",
    "process.stdout.write(JSON.stringify(out));",
  ].join("");

  const pollutedBase: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_API_KEY: "sk-user-shell-poison",
    OPENAI_BASE_URL: "https://user-shell.example",
    ANTHROPIC_API_KEY: "sk-ant-poison",
    GEMINI_API_KEY: "gemini-poison",
    GOOGLE_API_KEY: "google-poison",
    MY_VENDOR_API_KEY: "vendor-poison",
    GOOGLE_GENAI_USE_GCA: "true",
    FF_PANE_CANARY: "keep-me",
  };

  const probedNames = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MY_VENDOR_API_KEY",
    "GOOGLE_GENAI_USE_GCA",
    "FF_PANE_CANARY",
  ];

  async function probeChildEnv(
    spec: Parameters<typeof spawnAgentProcess>[0],
  ): Promise<{ seen: Record<string, string | null>; stripped: readonly string[] }> {
    const handle = spawnAgentProcess(spec);
    const [stdout] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    return {
      seen: JSON.parse(stdout.text) as Record<string, string | null>,
      stripped: handle.strippedEnvNames,
    };
  }

  it("默认剥离用户 shell 的 API key 类变量，保留无关变量", async () => {
    const { seen, stripped } = await probeChildEnv({
      command: NODE,
      args: ["-e", ENV_PROBE, ...probedNames],
      baseEnv: pollutedBase,
    });
    expect(seen["OPENAI_API_KEY"]).toBeNull();
    expect(seen["OPENAI_BASE_URL"]).toBeNull();
    expect(seen["ANTHROPIC_API_KEY"]).toBeNull();
    expect(seen["GEMINI_API_KEY"]).toBeNull();
    expect(seen["GOOGLE_API_KEY"]).toBeNull();
    expect(seen["MY_VENDOR_API_KEY"]).toBeNull();
    // 只是"复用 OAuth 登录态"的开关，不携带凭证，不能剥（剥了会误判未登录）
    expect(seen["GOOGLE_GENAI_USE_GCA"]).toBe("true");
    expect(seen["FF_PANE_CANARY"]).toBe("keep-me");
    expect(stripped).toContain("OPENAI_API_KEY");
    expect(stripped).toContain("MY_VENDOR_API_KEY");
    expect(stripped).not.toContain("FF_PANE_CANARY");
  });

  it("显式注入优先于清洗，且能覆盖同名污染值", async () => {
    const { seen, stripped } = await probeChildEnv({
      command: NODE,
      args: ["-e", ENV_PROBE, ...probedNames],
      baseEnv: pollutedBase,
      env: { OPENAI_API_KEY: "sk-run-scoped", FF_PANE_CANARY: "injected" },
    });
    expect(seen["OPENAI_API_KEY"]).toBe("sk-run-scoped");
    expect(seen["FF_PANE_CANARY"]).toBe("injected");
    expect(seen["ANTHROPIC_API_KEY"]).toBeNull();
    expect(stripped).not.toContain("OPENAI_API_KEY");
  });

  it("stripApiKeyEnv: false 时原样透传（L2 通用接入的逃生口）", async () => {
    const { seen, stripped } = await probeChildEnv({
      command: NODE,
      args: ["-e", ENV_PROBE, ...probedNames],
      baseEnv: pollutedBase,
      stripApiKeyEnv: false,
    });
    expect(seen["OPENAI_API_KEY"]).toBe("sk-user-shell-poison");
    expect(stripped).toEqual([]);
  });

  it("buildAgentEnv 与模式清单：命中前缀型与 *_API_KEY 兜底型", () => {
    expect(isApiKeyEnvName("OPENAI_ORG_ID")).toBe(true);
    expect(isApiKeyEnvName("ANTHROPIC_AUTH_TOKEN")).toBe(true);
    expect(isApiKeyEnvName("SOMEVENDOR_API_KEY")).toBe(true);
    expect(isApiKeyEnvName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isApiKeyEnvName("GOOGLE_GENAI_USE_GCA")).toBe(false);
    expect(isApiKeyEnvName("PATH")).toBe(false);
    expect(isApiKeyEnvName("FF_PANE_HOME")).toBe(false);
    expect(API_KEY_ENV_PATTERNS.length).toBeGreaterThan(10);
    // 模式清单不带 /g：共享 RegExp 反复 test 时 lastIndex 不能串味
    expect(API_KEY_ENV_PATTERNS.every((pattern) => !pattern.global)).toBe(true);

    const { env, strippedNames } = buildAgentEnv({
      baseEnv: { OPENAI_API_KEY: "x", KEEP: "y" },
      inject: { EXTRA: "z" },
    });
    expect(env).toEqual({ KEEP: "y", EXTRA: "z" });
    expect(strippedNames).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("spawn 失败归一", () => {
  it("找不到可执行文件 → spawn-failed / ENOENT，不抛异常", async () => {
    const handle = spawnAgentProcess({
      command: "ff-pane-no-such-cli-20260829",
      args: ["--json"],
    });
    const exit = await handle.exitPromise;
    expect(exit.kind).toBe("spawn-failed");
    expect(exit.errorCode).toBe("ENOENT");
    expect(exit.exitCode).toBeNull();
    expect(handle.pid).toBeUndefined();
    // 失败句柄的流是空的已结束流，消费方无需特判
    expect((await drain(handle.stdout)).chunks).toEqual([]);
    expect((await drain(handle.stderr)).chunks).toEqual([]);
    // kill() 对失败句柄同样幂等
    expect((await handle.kill()).kind).toBe("spawn-failed");
  });

  it("cwd 不存在 → spawn-failed（Node 在 spawn 阶段报错）", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('never')"],
      cwd: path.join(tmpdir(), "ff-pane-no-such-dir-20260829"),
    });
    const exit = await handle.exitPromise;
    expect(exit.kind).toBe("spawn-failed");
    expect(exit.error).not.toBeNull();
  });
});

describe("取消与超时：进程树终止", () => {
  /** 假 CLI：spawn 一个长睡眠孙进程并回报其 pid，然后自己也长睡。 */
  const FAKE_CLI_WITH_GRANDCHILD = [
    "const { spawn } = require('node:child_process');",
    "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(kid.pid) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("");

  it("kill() 终止整棵树：孙进程也不留（tasklist 查证）", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", FAKE_CLI_WITH_GRANDCHILD],
    });
    const grandchildPid = Number(await readFirstLine(handle.stdout));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(await pidAlive(grandchildPid)).toBe(true);

    const exit = await handle.kill();
    expect(exit.kind).toBe("killed");
    expect(await waitUntilGone(grandchildPid, 10_000)).toBe(true);
    const childPid = handle.pid;
    expect(childPid).toBeTypeOf("number");
    if (childPid !== undefined) {
      expect(await waitUntilGone(childPid, 10_000)).toBe(true);
    }
  }, 40_000);

  it("超时自动树杀，结束方式为 timeout", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", "process.stdout.write('up\\n');setInterval(() => {}, 1000)"],
      timeoutMs: 500,
    });
    const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
    expect(stdout.text).toBe("up\n");
    expect(exit.kind).toBe("timeout");
  }, 30_000);

  it("kill() 幂等：已退出进程重复 kill 无害且结论不变", async () => {
    const handle = spawnAgentProcess({ command: NODE, args: ["-e", "process.exit(3)"] });
    await drain(handle.stdout);
    const natural = await handle.exitPromise;
    expect(natural.kind).toBe("exited");
    const first = await handle.kill();
    const second = await handle.kill();
    expect(first).toEqual(natural);
    expect(second).toEqual(natural);
    expect(first.exitCode).toBe(3);
  }, 20_000);

  it("kill() 并发调用只产出一个终局", async () => {
    const handle = spawnAgentProcess({
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    const [a, b] = await Promise.all([handle.kill(), handle.kill()]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("killed");
  }, 30_000);

  it("主进程已退出但孙进程仍占着 stdout：宽限期到即收口，不会永远悬着", async () => {
    // 真实场景：Codex 等 CLI 会派生子进程继承 stdout，主进程退出后管道仍未关闭，
    // 只等 'close' 会让 exitPromise 无限期悬着。
    const script = [
      "const { spawn } = require('node:child_process');",
      "const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],",
      "  { stdio: ['ignore', 'inherit', 'ignore'], detached: true });",
      "kid.unref();",
      "process.stdout.write(String(kid.pid) + '\\n');",
    ].join("");
    const handle = spawnAgentProcess({ command: NODE, args: ["-e", script] });
    const grandchildPid = Number(await readFirstLine(handle.stdout));
    const startedAt = Date.now();
    const exit = await handle.exitPromise;
    const elapsed = Date.now() - startedAt;

    expect(exit.kind).toBe("exited");
    expect(exit.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(EXIT_SETTLE_GRACE_MS - 1_000);

    // 顺带验证 killProcessTree 对独立进程同样有效
    const outcome = await killProcessTree(grandchildPid);
    expect(outcome.alreadyGone).toBe(false);
    expect(await waitUntilGone(grandchildPid, 10_000)).toBe(true);
  }, 40_000);

  it("killProcessTree 对不存在的 pid 报 alreadyGone", async () => {
    const outcome = await killProcessTree(999_997);
    expect(outcome.alreadyGone).toBe(true);
    expect(outcome.error).toBeNull();
    if (isWindows) {
      expect(outcome.method).toBe("taskkill");
      expect(outcome.exitCode).toBe(128);
    }
  }, 20_000);

  it("killProcessTree 拒绝非法 pid", async () => {
    const outcome = await killProcessTree(0);
    expect(outcome.alreadyGone).toBe(true);
    expect(outcome.error).toContain("无效 pid");
  });
});

describe("Windows 命令解析与 .cmd 垫片", () => {
  let shimDir = "";
  let shimPath = "";

  beforeAll(async () => {
    shimDir = await mkdtemp(path.join(tmpdir(), "ff-pane-shim-"));
    shimPath = path.join(shimDir, "ff-pane-fake-cli.cmd");
    await writeFile(
      path.join(shimDir, "print-argv.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );
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
    "经 cmd.exe 垫片执行，含元字符的参数原样抵达",
    async () => {
      const args = [
        "--json",
        "hello world",
        'say "hi" now',
        "a&b",
        "100%PATH%",
        "^caret^",
        "!bang!",
        "back\\slash\\",
        "pipe|redir>x<y",
        "(paren)",
        "中文 提示词",
      ];
      const handle = spawnAgentProcess({ command: shimPath, args, timeoutMs: 30_000 });
      const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
      expect(exit.kind).toBe("exited");
      expect(exit.exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toEqual(args);
      expect(handle.viaCmdShim).toBe(true);
      expect(handle.resolvedCommand.toLowerCase()).toBe(shimPath.toLowerCase());
    },
    40_000,
  );

  it.skipIf(!isWindows)(
    "裸命令名经 PATH × PATHEXT 解析到 .cmd 垫片",
    async () => {
      const handle = spawnAgentProcess({
        command: "ff-pane-fake-cli",
        args: ["resolved"],
        baseEnv: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
        },
        timeoutMs: 30_000,
      });
      const [stdout, exit] = await Promise.all([drain(handle.stdout), handle.exitPromise]);
      expect(exit.exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toEqual(["resolved"]);
      expect(handle.viaCmdShim).toBe(true);
      expect(handle.resolvedCommand.toLowerCase()).toBe(shimPath.toLowerCase());
    },
    40_000,
  );

  it.skipIf(!isWindows)("原生 .exe 直接 spawn，不走垫片", () => {
    const target = resolveSpawnTarget(NODE, ["-v"]);
    expect(target?.viaCmdShim).toBe(false);
    expect(target?.windowsVerbatimArguments).toBe(false);
    expect(target?.args).toEqual(["-v"]);
    expect(findExecutableOnWindowsPath("node")?.toLowerCase()).toMatch(/node\.exe$/);
    expect(findExecutableOnWindowsPath("ff-pane-no-such-cli-20260829")).toBeUndefined();
  });

  it.skipIf(!isWindows)(
    "PATH/PATHEXT 大小写不敏感取值（W2.3 真机发现：普通对象展开丢失 process.env 魔法访问）",
    () => {
      // 键名故意用 Windows 常见的 "Path"（非全大写）：修复前 env["PATH"] 精确取值
      // 得 undefined → 搜索目录为空 → 裸命令名被误判 ENOENT。
      const plainEnv: NodeJS.ProcessEnv = {
        Path: path.dirname(NODE),
        pathext: ".COM;.EXE",
      };
      expect(findExecutableOnWindowsPath("node", plainEnv)?.toLowerCase()).toMatch(/node\.exe$/);
      // buildAgentEnv 的产物（普通对象）同样必须可解析
      const built = buildAgentEnv({ baseEnv: plainEnv }).env;
      expect(findExecutableOnWindowsPath("node", built)?.toLowerCase()).toMatch(/node\.exe$/);
    },
  );

  it("垫片命令行：最外层加引号，参数双层 ^ 转义", () => {
    const line = buildCmdShimCommandLine("C:\\bin\\fake.cmd", ["a&b", 'q"uote', "plain"]);
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    expect(line).toContain("C:\\bin\\fake.cmd");
    // & 需要两层 ^：外层 cmd 解析吃掉一层，垫片内 %* 重解析吃掉第二层
    expect(line).toContain("^^^&");
    expect(line).toContain('\\^^^"');
  });
});
