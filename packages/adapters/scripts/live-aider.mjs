/**
 * T7.3b Aider 真机冒烟（live，非 CI）：用**真实 aider CLI** 跑一轮受管执行，
 * 断言统一事件流里出现完整的一套证据，并逐条核查红线。
 *
 * 与 tests/aider.test.ts 的分工：那份是 fixture 回放，验证的是「给定这段 stdout，
 * 扫描与映射对不对」；这里验证的是它前面那几段——命令行组装真的能让 aider 启动、
 * `--message-file` 真的被读到、七条红线开关真的生效、diff 真的补得上、
 * transcript 真的能续接、临时文件真的清干净。这些没有任何单测覆盖得到。
 *
 * ## 安全纪律（不可放松）
 *
 * **始终经 env 注入 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`，并始终给 `--model`。**
 * 缺任一项时 aider 会进 onboarding、**唤起浏览器**做 OpenRouter OAuth 并挂最多
 * 5 分钟（docs/adapters/aider.md §7.3 坑 1）。本脚本默认走本仓库的假模型端点，
 * 既不花钱也不联网，更不会弹任何窗口。
 *
 * `LIVE_REAL_MODEL=1` 时改用用户自己的 Provider（会产生费用）——此时 `LIVE_MODEL`
 * 与 `OPENAI_API_KEY` 必须由调用方给全，脚本会先检查再启动。
 *
 * 用法：pnpm -C packages/adapters build && node packages/adapters/scripts/live-aider.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAiderAdapter } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(here, "../fixtures/tools/fake-openai-server.mjs");
const useRealModel = process.env.LIVE_REAL_MODEL === "1";
const PORT = Number(process.env.LIVE_PORT ?? 8198);

if (
  useRealModel &&
  (process.env.LIVE_MODEL === undefined || process.env.OPENAI_API_KEY === undefined)
) {
  console.error(
    "[live] LIVE_REAL_MODEL=1 时必须同时给 LIVE_MODEL 与 OPENAI_API_KEY —— " +
      "缺任一项 aider 会弹浏览器做 OAuth（见 aider.md §7.3 坑 1）。已中止。",
  );
  process.exit(1);
}

// --- 准备一个临时 git 仓库当"用户项目" ---
const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-aider-live-"));
const sideRoot = mkdtempSync(join(tmpdir(), "ffpane-aider-side-"));
execFileSync("git", ["init", "-q"], { cwd: projectRoot });
execFileSync("git", ["config", "user.email", "live@example.com"], { cwd: projectRoot });
execFileSync("git", ["config", "user.name", "Live"], { cwd: projectRoot });
writeFileSync(join(projectRoot, "readme.txt"), "hello world\n", "utf8");
execFileSync("git", ["add", "-A"], { cwd: projectRoot });
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projectRoot });

const git = (...args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
const headBefore = git("rev-parse", "HEAD");
const filesBefore = readdirSync(projectRoot).sort();

// --- 假模型：一句解释 + 一份 whole 格式的文件清单 ---
const scriptPath = join(sideRoot, "script.json");
writeFileSync(
  scriptPath,
  JSON.stringify([
    {
      text:
        "I will append a greeting line to the readme.\n\n" +
        "readme.txt\n```\nhello world\nhello from ff-pane\n```\n",
    },
  ]),
);

let server;
if (!useRealModel) {
  server = spawn(process.execPath, [serverScript, "--port", String(PORT), "--script", scriptPath], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));
}

const adapter = createAiderAdapter({ tempDir: sideRoot });

/** 密钥与端点**只经 env**（设计文档 §4.3），且 --model 必给（否则弹浏览器）。 */
const env = useRealModel
  ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
  : { OPENAI_API_KEY: "sk-fake-live", OPENAI_BASE_URL: `http://127.0.0.1:${PORT}/v1` };
const model = useRealModel ? process.env.LIVE_MODEL : "openai/ffpane-fixture-model";

const turn = adapter.startTurn({
  cwd: projectRoot,
  prompt:
    "Append a line saying `hello from ff-pane` to readme.txt.\n" +
    "这是一个多行中文提示词，用来验证 --message-file 原样送达。\n",
  model,
  env,
  timeoutMs: 240_000,
});

console.log("[live] 命令行：", turn.commandLine.join(" "));
console.log("[live] 会话凭据：", turn.sessionFile);

const events = [];
for await (const event of turn.events) {
  events.push(event);
  if (event.kind !== "raw") {
    console.log(`[event] ${event.kind}`, JSON.stringify(event).slice(0, 200));
  }
}

// --- 第二轮：验证 transcript 真的能续接 ---
const resumeTurn = adapter.startTurn({
  cwd: projectRoot,
  prompt: "What file did you just change? Do not change anything else.\n",
  model,
  env,
  resume: { nativeSessionId: turn.sessionFile, cwd: projectRoot },
  timeoutMs: 240_000,
});
const resumeEvents = [];
for await (const event of resumeTurn.events) {
  resumeEvents.push(event);
}

server?.kill();

// --- 判据 ---
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(name);
};

const end = events.filter((e) => e.kind === "end");
const start = events.filter((e) => e.kind === "session_start");
const changes = events.filter((e) => e.kind === "file_change");
const texts = events.filter((e) => e.kind === "text" && e.channel === "answer");
const commands = events.filter((e) => e.kind === "command");
const readmeAfter = readFileSync(join(projectRoot, "readme.txt"), "utf8");
const filesAfter = readdirSync(projectRoot).sort();
const headAfter = git("rev-parse", "HEAD");
const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));
const commitCount = git("rev-list", "--count", "HEAD");

console.log("\n[live] 判据：");

// 1~4：整条链真的跑通了
check("end 恰好一条且在最后", end.length === 1 && events.at(-1)?.kind === "end");
check("end.reason = completed", end[0]?.reason === "completed", end[0]?.message ?? "");
check(
  "提示词经 --message-file 送达（模型看到了才会照做）",
  readmeAfter.includes("hello from ff-pane"),
  JSON.stringify(readmeAfter),
);
check(
  "文件变更事件带 git 自补的 diff 正文",
  changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello from ff-pane")),
  changes.map((c) => `${c.path}:${(c.diff ?? "").length}B`).join(","),
);

// 5~6：流式与会话
check("有文本增量且以 final 收尾", texts.length > 1 && texts.at(-1)?.final === true);
check(
  "会话凭据（transcript 路径）经 session_start 报出",
  start[0]?.native?.nativeSessionId === turn.sessionFile,
);
check(
  "第二轮 --restore-chat-history 续接成功",
  resumeEvents.some((e) => e.kind === "raw" && (e.note ?? "").includes("transcript 恢复")) &&
    resumeEvents.filter((e) => e.kind === "end")[0]?.reason === "completed",
);

// 7~10：红线（本工单的核心防线）
check(
  "用户仓库无残留文件（用 dir 列目录判，不用 git status —— aider 会把 .aider* 写进 .gitignore）",
  newFiles.length === 0,
  newFiles.join(","),
);
check("用户仓库无 aider 残留（.aider*）", !filesAfter.some((f) => f.startsWith(".aider")));
check(
  "git 历史无多余 commit",
  headAfter === headBefore && commitCount === "1",
  `HEAD ${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}，共 ${commitCount} 条`,
);
check("用户的 .gitignore 未被创建/改写", !existsSync(join(projectRoot, ".gitignore")));
check(
  "提示词临时文件已清理",
  !readdirSync(sideRoot, { recursive: true }).some((f) =>
    String(f).includes("ffpane-aider-prompt-"),
  ),
);
check(
  "transcript 保留在系统临时目录（会话凭据，跨轮存活）且不在用户仓库内",
  existsSync(turn.sessionFile) && !turn.sessionFile.startsWith(projectRoot),
);

// 11：命令事件如实为零（能力声明 commandEvents = no）
check("无命令事件（headless 下 aider 结构性地不执行模型请求的命令）", commands.length === 0);

rmSync(projectRoot, { recursive: true, force: true });
rmSync(sideRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
