/**
 * T8.5c OpenCode 注册接入真机冒烟（live，非 CI）：用**真实 opencode CLI** 走
 * Server（`opencode serve` + HTTP/SSE）路径跑一轮受管执行，断言注册接入承诺的事：
 * 1. server 惰性起动 → 健康检查 → 版本记录（版本漂移排查的第一手依据）；
 * 2. 权限请求真转发：permission.asked → 统一 permission_request 事件 →
 *    respondPermission(allow) → 文件真落地（Server 路径独有，CLI 路径默认自动拒绝）；
 * 3. 事件证据齐全：流式文本增量 / file_change（diff 取权限元数据）/ command 退出码；
 * 4. **close() 实测耗时**（T8.5c 退出预算数字的依据：QUIT_RUNTIME_CLOSE_BUDGET_MS
 *    取实测的 ≥3 倍裕量）与 server 收干净（state=closed）。
 *
 * 模型端：内嵌假 OpenAI 兼容服务端（不花钱、不联网、可复现），opencode 经临时
 * OPENCODE_CONFIG 的 openai-compatible 自定义 Provider 接入（调研 §4.2 的录制同款）。
 * **旁路调用识别按结构特征**：OpenCode 每个新会话有一次 small_model 标题生成调用
 * （调研 §4.2），其请求体不带 tools 声明——主对话请求恒带（agent 工具 schema），
 * 据此分流，标题请求不吃主对话的脚本序号。
 * 注意首跑联网依赖（调研 §8.3）：@ai-sdk/openai-compatible 驱动包按需下载后缓存
 * （~/.cache/opencode）；离线且无缓存的机器首跑会失败——那是 OpenCode 的行为，
 * 不是适配器缺陷，重跑（有网）即过。
 *
 * 用法：pnpm -C packages/adapters build && node packages/adapters/scripts/live-opencode.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeAdapter } from "../dist/index.js";

const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-opencode-live-"));
const configDir = mkdtempSync(join(tmpdir(), "ffpane-opencode-cfg-"));
execFileSync("git", ["init", "-q"], { cwd: projectRoot });

/* ------------------------------------------------------------------ *
 * 内嵌假模型服务端（fixtures/tools/fake-openai-server.mjs 的 live 变体：
 * 旁路识别改结构特征——fixtures 既有文件红线不动，故不改那份而在此内嵌）。
 * ------------------------------------------------------------------ */
const SCRIPT = [
  {
    toolCalls: [
      { id: "call_w", name: "write", args: { filePath: "hello.txt", content: "hello\n" } },
    ],
  },
  {
    toolCalls: [{ id: "call_b", name: "bash", args: { command: "node -v", description: "check" } }],
  },
  { text: "Created hello.txt and checked the Node version." },
];
let mainIndex = 0;

function toMessage(step) {
  if (Array.isArray(step.toolCalls)) {
    return {
      role: "assistant",
      content: step.text ?? null,
      tool_calls: step.toolCalls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    };
  }
  return { role: "assistant", content: step.text ?? "" };
}

const USAGE = { prompt_tokens: 812, completion_tokens: 45, total_tokens: 857 };
const BASE = {
  id: "chatcmpl-ffpane-live",
  object: "chat.completion.chunk",
  created: 1_756_600_000,
  model: "mock-model",
};

const mock = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏请求体也照常回一条
  }
  // 旁路识别（标题生成等）：主对话恒带 agent 工具 schema，旁路请求不带
  const side = !Array.isArray(parsed.tools) || parsed.tools.length === 0;
  const step = side ? { text: "fixture" } : (SCRIPT[mainIndex++] ?? { text: "Done." });
  const message = toMessage(step);
  const finish = message.tool_calls === undefined ? "stop" : "tool_calls";
  process.stderr.write(
    `[mock] ${side ? "side" : `#${mainIndex - 1}`} stream=${parsed.stream === true}\n`,
  );
  if (parsed.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finishReason = null) =>
      res.write(
        `data: ${JSON.stringify({ ...BASE, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    emit({ role: "assistant", content: "" });
    if (message.tool_calls !== undefined) {
      for (const [index, call] of message.tool_calls.entries()) {
        emit({ tool_calls: [{ index, id: call.id, type: "function", function: call.function }] });
      }
    } else if (message.content.length > 0) {
      const half = Math.ceil(message.content.length / 2);
      emit({ content: message.content.slice(0, half) });
      emit({ content: message.content.slice(half) });
    }
    emit({}, finish);
    res.write(`data: ${JSON.stringify({ ...BASE, choices: [], usage: USAGE })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ...BASE,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: USAGE,
    }),
  );
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;

/* ------------------------------------------------------------------ *
 * OpenCode 配置：openai-compatible 自定义 Provider（调研 §4.2 录制同款），
 * 经 OPENCODE_CONFIG 注入——用户的全局 ~/.config/opencode 分毫不动。
 * ------------------------------------------------------------------ */
const configPath = join(configDir, "opencode.json");
writeFileSync(
  configPath,
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      mockai: {
        npm: "@ai-sdk/openai-compatible",
        name: "FF-pane live mock",
        options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "live-fixture-key" },
        models: { "mock-model": { name: "mock", limit: { context: 128000, output: 8192 } } },
      },
    },
    model: "mockai/mock-model",
    small_model: "mockai/mock-model",
    autoupdate: false,
  }),
);

const adapter = createOpenCodeAdapter({
  serverOptions: {
    env: {
      OPENCODE_CONFIG: configPath,
      // 权限转发的触发条件：edit / bash 置 ask（Server 路径转发为 permission.asked）
      OPENCODE_PERMISSION: JSON.stringify({ edit: "ask", bash: "ask" }),
    },
  },
  providerId: "mockai",
});

const turn = adapter.startTurn({
  cwd: projectRoot,
  prompt: "Create hello.txt containing 'hello', run node -v, then say what you did.",
  model: "mockai/mock-model",
  timeoutMs: 180_000,
});

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
    await turn.respondPermission(event.nativeRequestId, "allow");
    continue;
  }
  if (event.kind !== "raw") {
    console.log(`[event] ${event.kind}`, JSON.stringify(event).slice(0, 160));
  }
}

const status = adapter.server.status();
console.log(`[live] server 版本：${status.version ?? "?"}，重启次数：${status.restarts}`);

// close 实测耗时（退出预算数字的依据）
const closeStart = Date.now();
await adapter.close();
const closeMs = Date.now() - closeStart;
console.log(`[live] adapter.close() 实测耗时：${closeMs} ms`);

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

console.log("\n[live] 判据（Server 路径）：");
check("server 健康检查通过并记录版本", (status.version ?? "").length > 0, status.version ?? "");
check("end 恰好一条且在最后", end.length === 1 && events[events.length - 1]?.kind === "end");
check("end.reason = completed", end[0]?.reason === "completed", end[0]?.message ?? "");
check(
  "拿到原生会话 ID（ses_ 前缀）",
  (start[0]?.native?.nativeSessionId ?? "").startsWith("ses_"),
  start[0]?.native?.nativeSessionId ?? "",
);
check("session_start 先于一切动作", sawStartBeforeFirstAction);
check(
  "权限请求真转发（write + bash 各至少一次）",
  permissionLog.some((p) => p.payload.kind === "write_path") &&
    permissionLog.some((p) => p.payload.kind === "shell_command"),
  permissionLog.map((p) => p.payload.kind).join("、"),
);
check(
  "hello.txt 真的落地（allow 回执生效）",
  readdirSync(projectRoot).includes("hello.txt") &&
    readFileSync(join(projectRoot, "hello.txt"), "utf8").includes("hello"),
);
check(
  "file_change 完成且 diff 含 +hello（取权限元数据）",
  changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello")),
);
check(
  "命令事件带退出码 0",
  commands.some((c) => c.status === "completed" && c.exitCode === 0),
);
check("有文本增量且以 final 收尾", texts.length > 1 && texts[texts.length - 1]?.final === true);
check(
  `close() 在小预算内（${closeMs} ms ≤ 1000 ms）且 server 收干净`,
  closeMs <= 1000 && adapter.server.status().state === "closed",
);

mock.close();
rmSync(projectRoot, { recursive: true, force: true });
rmSync(configDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
