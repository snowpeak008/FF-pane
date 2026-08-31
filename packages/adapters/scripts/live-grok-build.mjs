/**
 * T7.3 Grok Build 真机冒烟（live，非 CI）：用**真实 grok CLI** 跑一轮受管执行，
 * 断言统一事件流里出现完整的一套证据（会话 ID、文件变更含 diff、命令含退出码、
 * 文本增量、end=completed）。
 *
 * 与 tests/grok-build.test.ts 的分工：那份是 fixture 回放，验证的是"给定这段
 * NDJSON，映射得对不对"；这里验证的是它前面那几段——命令行组装真的能让 grok 启动、
 * `--prompt-file` 真的被读到、`--always-approve` 真的让工具落地、进程收尾与
 * 临时文件清理真的成立。这些没有任何单测覆盖得到。
 *
 * 模型端两种跑法：
 * 1. **默认（不花钱）**：起本仓库的假 OpenAI 兼容服务端（fixtures/tools/），
 *    经临时 GROK_HOME 里的自定义模型配置接入。用户的 ~/.grok 分毫不动。
 * 2. `LIVE_REAL_MODEL=1`：走用户自己的登录态/密钥与真实 xAI 后端（会产生费用）。
 *
 * 用法：pnpm -C packages/adapters build && node packages/adapters/scripts/live-grok-build.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGrokBuildAdapter } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(here, "../fixtures/tools/fake-openai-server.mjs");
const useRealModel = process.env.LIVE_REAL_MODEL === "1";
const PORT = Number(process.env.LIVE_PORT ?? 8199);

const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-grok-live-"));
const grokHome = mkdtempSync(join(tmpdir(), "ffpane-grok-home-"));
execFileSync("git", ["init", "-q"], { cwd: projectRoot });

const targetFile = join(projectRoot, "hello.txt").split("\\").join("/");
const scriptPath = join(grokHome, "script.json");
writeFileSync(
  scriptPath,
  JSON.stringify([
    {
      toolCalls: [
        { id: "call_w", name: "write", args: { file_path: targetFile, content: "hello" } },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_b",
          name: "run_terminal_command",
          args: { command: "node -v", description: "check node" },
        },
      ],
    },
    { text: "Created hello.txt and checked the Node version." },
  ]),
);
writeFileSync(
  join(grokHome, "config.toml"),
  [
    "[cli]",
    "auto_update = false",
    "",
    "[model.ffpane-live]",
    'model = "ffpane-fixture-model"',
    `base_url = "http://127.0.0.1:${PORT}/v1"`,
    'api_key = "live-fixture-key"',
    'api_backend = "chat_completions"',
    "context_window = 128000",
  ].join("\n"),
);

let server;
if (!useRealModel) {
  server = spawn(process.execPath, [serverScript, "--port", String(PORT), "--script", scriptPath], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
}

const adapter = createGrokBuildAdapter(useRealModel ? {} : { grokHome, promptDir: grokHome });

const turn = adapter.startTurn({
  cwd: projectRoot,
  prompt:
    "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did.",
  ...(useRealModel ? {} : { model: "ffpane-live" }),
  timeoutMs: 180_000,
});

console.log("[live] 命令行：", turn.commandLine.join(" "));

const events = [];
for await (const event of turn.events) {
  events.push(event);
  if (event.kind !== "raw") {
    console.log(`[event] ${event.kind}`, JSON.stringify(event).slice(0, 160));
  }
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

console.log("\n[live] 判据：");
check("end 恰好一条且在最后", end.length === 1 && events[events.length - 1]?.kind === "end");
check("end.reason = completed", end[0]?.reason === "completed", end[0]?.message ?? "");
check("拿到原生会话 ID", (start[0]?.native?.nativeSessionId ?? "").length > 0);
check(
  "文件变更事件带 diff 正文",
  changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello")),
);
check("hello.txt 真的落地", readdirSync(projectRoot).includes("hello.txt"));
check(
  "命令事件带退出码 0",
  commands.some((c) => c.status === "completed" && c.exitCode === 0),
);
check("有文本增量且以 final 收尾", texts.length > 1 && texts[texts.length - 1]?.final === true);
check(
  "提示词临时文件已清理",
  !readdirSync(grokHome).some((f) => f.startsWith("ffpane-grok-prompt-")),
);

server?.kill();
rmSync(projectRoot, { recursive: true, force: true });
rmSync(grokHome, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
