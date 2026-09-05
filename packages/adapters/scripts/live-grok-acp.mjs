/**
 * T8.5b Grok Build ACP 真机冒烟（live，非 CI）：用**真实 grok CLI** 走
 * `grok agent stdio` 双工通道跑一轮受管执行，断言 ACP 路径独有的四件事：
 * 1. session_start **开轮即得**（headless 只在 end 给——§7.3 坑 5 在本模式不存在）；
 * 2. **权限请求真转发**：session/request_permission → 统一 permission_request 事件
 *    → respondPermission 回执 → 工具真的落地（allow）；
 * 3. 事件证据齐全（diff / 退出码 / 文本增量）与 headless 同源；
 * 4. end=completed 且进程收干净。
 *
 * 与 live-grok-build.mjs 的分工：那份验证 headless 路径（--prompt-file /
 * --always-approve / 临时文件清理），这里验证 ACP 路径（握手 / 双工 / 审批往返）。
 * 降级链不在真机验（本机 grok 支持 agent stdio，垫不出「子命令不存在」的形态；
 * 该链路由 grok-build-acp.test.ts 的假进程用例钉住）。
 *
 * 模型端两种跑法（同 live-grok-build.mjs）：
 * 1. **默认（不花钱）**：起本仓库的假 OpenAI 兼容服务端（fixtures/tools/），
 *    经临时 GROK_HOME 里的自定义模型配置接入。用户的 ~/.grok 分毫不动。
 * 2. `LIVE_REAL_MODEL=1`：走用户自己的登录态/密钥与真实 xAI 后端（会产生费用）。
 *
 * 用法：pnpm -C packages/adapters build && node packages/adapters/scripts/live-grok-acp.mjs
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
const PORT = Number(process.env.LIVE_PORT ?? 8189);

const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-grok-acp-live-"));
const grokHome = mkdtempSync(join(tmpdir(), "ffpane-grok-acp-home-"));
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

// transport 显式 "acp"：本脚本验证的就是这条路径，降级发生即失败（不静默换路）
const adapter = createGrokBuildAdapter(
  useRealModel ? { transport: "acp" } : { transport: "acp", grokHome },
);

const turn = adapter.startTurn({
  cwd: projectRoot,
  prompt:
    "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did.",
  ...(useRealModel ? {} : { model: "ffpane-live" }),
  timeoutMs: 180_000,
});

console.log("[live] 命令行：", turn.commandLine.join(" "));

const events = [];
const permissionLog = [];
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
  if (event.kind === "permission_request") {
    permissionLog.push(event);
    console.log(
      `[perm] ${event.payload.kind} → allow`,
      JSON.stringify(event.payload).slice(0, 120),
    );
    // 权限层裁决的位置：live 脚本代权限层作答（真实链路里是 guard 的信封裁决）
    await turn.respondPermission(event.nativeRequestId, "allow");
    continue;
  }
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

console.log("\n[live] 判据（ACP 路径）：");
check("end 恰好一条且在最后", end.length === 1 && events[events.length - 1]?.kind === "end");
check("end.reason = completed", end[0]?.reason === "completed", end[0]?.message ?? "");
check("拿到原生会话 ID", (start[0]?.native?.nativeSessionId ?? "").length > 0);
check("session_start 先于一切动作（ACP 独有：开轮即得）", sawStartBeforeFirstAction);
check(
  "权限请求真转发（write + execute 各至少一次）",
  permissionLog.some((p) => p.payload.kind === "write_path") &&
    permissionLog.some((p) => p.payload.kind === "shell_command"),
  permissionLog.map((p) => p.payload.kind).join("、"),
);
check(
  "文件变更事件带 diff 正文",
  changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello")),
);
check("hello.txt 真的落地（allow 回执生效）", readdirSync(projectRoot).includes("hello.txt"));
check(
  "命令事件带退出码 0",
  commands.some((c) => c.status === "completed" && c.exitCode === 0),
);
check("有文本增量且以 final 收尾", texts.length > 1 && texts[texts.length - 1]?.final === true);

server?.kill();
rmSync(projectRoot, { recursive: true, force: true });
rmSync(grokHome, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
