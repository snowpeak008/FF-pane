/**
 * T8.6a Qwen Code 真机冒烟（live，非 CI）：用**真实 qwen CLI** 跑一轮受管执行，
 * 断言统一事件流里出现完整的一套证据（会话 ID、文件变更、命令输出、token 级
 * 文本增量、end=completed），再以 `--resume` 跑第二轮验证原生恢复。
 *
 * 与 tests/qwen-code.test.ts 的分工：那份是 fixture 回放，验证"给定这段 JSONL，
 * 映射得对不对"；这里验证它前面那几段——命令行组装真的能让 qwen 启动、提示词经
 * stdin 真的被读到、`--approval-mode yolo` 真的让工具落地、`--session-id` 预生成
 * 登记真的与 CLI 报出的一致、`--resume` 真的复用同一会话。这些单测覆盖不到。
 *
 * 模型端两种跑法：
 * 1. **默认（不花钱）**：起本仓库的假 OpenAI 兼容服务端（fixtures/tools/），
 *    经 --auth-type openai + OPENAI_API_KEY/OPENAI_BASE_URL 环境变量接入
 *    （ctx.env 注入路径全真——正是 desktop 装配的下发通道）。
 * 2. `LIVE_REAL_MODEL=1`：走用户自己的 OPENAI_API_KEY/OPENAI_BASE_URL
 *    指向真实端点（Dashscope/ModelStudio 等，会产生费用）。
 * 已知副作用：qwen 会在 ~/.qwen/projects/ 下为临时项目目录留一个会话桶
 * （CLI 自身的会话存储，无重定向参数）——与 gemini 的 ~/.gemini/tmp 同性质。
 *
 * 用法：pnpm -C packages/adapters build && node packages/adapters/scripts/live-qwen-code.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQwenCodeAdapter } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(here, "../fixtures/tools/fake-openai-server.mjs");
const useRealModel = process.env.LIVE_REAL_MODEL === "1";
const PORT = Number(process.env.LIVE_PORT ?? 8197);

const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-qwen-live-"));
const workDir = mkdtempSync(join(tmpdir(), "ffpane-qwen-live-aux-"));
execFileSync("git", ["init", "-q"], { cwd: projectRoot });

const targetFile = join(projectRoot, "hello.txt");
const scriptPath = join(workDir, "script.json");
writeFileSync(
  scriptPath,
  JSON.stringify([
    {
      toolCalls: [
        { id: "call_w", name: "write_file", args: { file_path: targetFile, content: "hello" } },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_b",
          name: "run_shell_command",
          args: { command: "node -v", description: "check node" },
        },
      ],
    },
    { text: "Created hello.txt and checked the Node version." },
    // 第二轮（--resume）的收尾文本
    { text: "Acknowledged." },
  ]),
);

let server;
if (!useRealModel) {
  server = spawn(process.execPath, [serverScript, "--port", String(PORT), "--script", scriptPath], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
}

// 密钥经 env 注入（desktop 装配的同一条通道：resolveRuntimeEnv → ctx.env →
// buildAgentEnv 注入优先于清洗）。真实模型模式沿用用户 shell 里的变量。
const injectedEnv = useRealModel
  ? {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      ...(process.env.OPENAI_BASE_URL === undefined
        ? {}
        : { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }),
    }
  : {
      OPENAI_API_KEY: "live-fixture-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
    };

const sessionId = randomUUID();
const adapter = createQwenCodeAdapter({ newSessionId: () => sessionId });

const turn = adapter.startTurn({
  cwd: projectRoot,
  prompt:
    "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did.",
  env: injectedEnv,
  ...(useRealModel ? {} : { model: "ffpane-fixture-model" }),
  timeoutMs: 180_000,
});

const events = [];
let sawStartBeforeFirstAction = false;
let sawAnyAction = false;
for await (const event of turn.events) {
  events.push(event);
  if (event.kind === "session_start" && !sawAnyAction) {
    sawStartBeforeFirstAction = true;
  }
  if (event.kind === "file_change" || event.kind === "command") {
    sawAnyAction = true;
  }
  if (event.kind !== "raw") {
    console.log(`[event] ${event.kind}`, JSON.stringify(event).slice(0, 160));
  }
}

// 第二轮：--resume 原生恢复（同 cwd），验证会话 ID 复用
const resumeTurn = adapter.startTurn({
  cwd: projectRoot,
  prompt: "Briefly acknowledge.",
  env: injectedEnv,
  ...(useRealModel ? {} : { model: "ffpane-fixture-model" }),
  resume: { nativeSessionId: sessionId, cwd: projectRoot },
  timeoutMs: 180_000,
});
const resumeEvents = [];
for await (const event of resumeTurn.events) {
  resumeEvents.push(event);
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(name);
};

const end = events.filter((e) => e.kind === "end");
const start = events.filter((e) => e.kind === "session_start");
const changes = events.filter((e) => e.kind === "file_change");
const commands = events.filter((e) => e.kind === "command");
const texts = events.filter((e) => e.kind === "text" && e.channel === "answer");
const resumeEnd = resumeEvents.filter((e) => e.kind === "end");
const resumeStart = resumeEvents.filter((e) => e.kind === "session_start");

console.log("\n[live] 判据：");
check("end 恰好一条且在最后", end.length === 1 && events[events.length - 1]?.kind === "end");
check("end.reason = completed", end[0]?.reason === "completed", end[0]?.message ?? "");
check(
  "原生会话 ID = 预生成的 --session-id（登记无需解析 init）",
  start[0]?.native?.nativeSessionId === sessionId,
  `${start[0]?.native?.nativeSessionId ?? "?"} vs ${sessionId}`,
);
check("session_start 先于一切动作", sawStartBeforeFirstAction);
check(
  "文件变更事件完成且带路径",
  changes.some((c) => c.status === "completed" && c.path.includes("hello.txt")),
);
check(
  "hello.txt 真的落地（yolo 真的让工具落地）",
  readdirSync(projectRoot).includes("hello.txt") &&
    readFileSync(targetFile, "utf8").includes("hello"),
);
check(
  "命令事件完成且带输出（exitCode 如实缺席——无结构化字段）",
  commands.some(
    (c) => c.status === "completed" && (c.output ?? "").startsWith("v") && c.exitCode === undefined,
  ),
  commands.map((c) => `${c.status}:${c.output ?? ""}`).join("、"),
);
check(
  "有 token 级文本增量且以 final 收尾",
  texts.filter((t) => !t.final).length > 1 && texts[texts.length - 1]?.final === true,
);
check("end 带 usage 汇总", (end[0]?.usage?.totalTokens ?? 0) > 0);
check(
  "resume 轮会话 ID 复用（原生恢复真的不新开会话）",
  resumeEnd[0]?.reason === "completed" && resumeStart[0]?.native?.nativeSessionId === sessionId,
  resumeEnd[0]?.message ?? "",
);

server?.kill();
rmSync(projectRoot, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
