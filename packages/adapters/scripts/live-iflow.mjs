/**
 * T8.6b iFlow ACP 真机冒烟（live，非 CI）：用**真实 iflow CLI**（0.5.19）走
 * `iflow --experimental-acp` stdio 双工跑四轮受管执行，断言五件事：
 * 1. **权限往返**：session/request_permission → 统一 permission_request →
 *    respondPermission(allow) 回执 → 文件真落地；reject 轮验证**坑 2 防线**
 *    （拒绝后 iFlow 静默吞工具无 failed 事件，权限桥记账 → denied 事件 +
 *    end_turn 改判 failed + 文件真的没落地）；
 * 2. **优雅取消**：session/cancel → prompt 以 stopReason=cancelled 落定（非树杀）；
 * 3. **会话互通 / 恢复**：第二轮 resume（session/load）复用首轮会话 ID；
 * 4. **受管 HOME 隔离**：settings/会话存储全部落受管目录（USERPROFILE/HOME 替换），
 *    用户真实 ~/.iflow 分毫不动；
 * 5. 事件证据（fileDiff / 命令输出 / exitCode 如实缺席）与 fixture 回放同源。
 *
 * 模型端两种跑法（同 live-grok-acp.mjs）：
 * 1. **默认（不花钱）**：起本仓库的假 OpenAI 兼容服务端（fixtures/tools/），
 *    经受管 HOME 的 openai-compatible settings + env 三件套接入——协议这一环
 *    没有被替换（iFlow 官方后端本就说 OpenAI 兼容协议）。
 * 2. `LIVE_REAL_MODEL=1`：走用户自己的 IFLOW_API_KEY 与真实 iFlow 后端（计费）。
 *
 * 用法：pnpm --filter @ff-pane/adapters build && node packages/adapters/scripts/live-iflow.mjs
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIFlowAdapter } from "../dist/index.js";

const useRealModel = process.env.LIVE_REAL_MODEL === "1";
const PORT = Number(process.env.LIVE_PORT ?? 8195);

const projectRoot = mkdtempSync(join(tmpdir(), "ffpane-iflow-live-"));
const managedHome = mkdtempSync(join(tmpdir(), "ffpane-iflow-live-home-"));

const helloPath = join(projectRoot, "hello.txt");
const deniedPath = join(projectRoot, "denied.txt");

/**
 * 内嵌假 OpenAI 兼容服务端（口径同 fixtures/tools/fake-openai-server.mjs，不改既有
 * 脚本）。**按轮重置发牌序号**：`setScript()` 换本轮脚本并把序号归零——一个 iFlow
 * 轮次内是多次模型调用的工具循环（探针实测 write→tool_result→shell→tool_result→
 * 文本共 3 次调用），跨轮共用全局序号会错位，故每轮独立脚本 + 归零。
 */
let script = [];
let idx = 0;
function setScript(next) {
  script = next;
  idx = 0;
}
function pick() {
  const step = script[idx] ?? { text: "Done." };
  idx += 1;
  return step;
}
function messageOf(step) {
  if (step.toolCalls) {
    return {
      role: "assistant",
      content: null,
      tool_calls: step.toolCalls.map((c, i) => ({
        id: c.id ?? `c${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: "assistant", content: step.text ?? "" };
}
const server = useRealModel
  ? undefined
  : createServer(async (req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      await new Promise((r) => req.on("end", r));
      const step = pick();
      if (typeof step.delayMs === "number") {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "ffpane-fixture-model",
          choices: [
            {
              index: 0,
              message: messageOf(step),
              finish_reason: step.toolCalls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 812, completion_tokens: 45, total_tokens: 857 },
        }),
      );
    });
if (server !== undefined) {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
}

// 三件套经 ctx.env 注入——与 desktop 装配同一条通道（resolveRuntimeEnv("iflow") →
// IFLOW_API_KEY / IFLOW_BASE_URL → turnCtx.env → buildIFlowEnv → spawn env）。
const injectedEnv = useRealModel
  ? {}
  : { IFLOW_API_KEY: "live-fixture-key", IFLOW_BASE_URL: `http://127.0.0.1:${PORT}/v1` };
const adapter = createIFlowAdapter({ managedHome });

async function runOneTurn(label, ctx, { onPermission = "allow", cancelOnStart = false } = {}) {
  const turn = adapter.startTurn(ctx);
  if (label === "R1") {
    console.log("[live] 命令行：", turn.commandLine.join(" "));
  }
  const events = [];
  const permissions = [];
  let cancelled = false;
  for await (const event of turn.events) {
    events.push(event);
    if (event.kind === "permission_request") {
      permissions.push(event);
      console.log(`[${label}][perm] ${event.payload.kind} → ${onPermission}`);
      await turn.respondPermission(event.nativeRequestId, onPermission);
      continue;
    }
    if (cancelOnStart && !cancelled && event.kind === "session_start") {
      cancelled = true;
      // session_start 之后 prompt 才发出；延迟片刻确保 prompt 已在飞（模型端拖住
      // 120 s 不回），此时 session/cancel 才有一个进行中的 prompt 可优雅落定。
      // 不 await：取消与事件消费并行（真实链路里 cancel 来自另一条 IPC）。
      setTimeout(() => {
        void turn.cancel();
      }, 1500);
    }
    if (event.kind !== "raw") {
      console.log(`[${label}][event] ${event.kind}`, JSON.stringify(event).slice(0, 140));
    }
  }
  return { events, permissions };
}

const model = useRealModel ? undefined : "ffpane-fixture-model";
const baseCtx = {
  cwd: projectRoot,
  env: injectedEnv,
  ...(model === undefined ? {} : { model }),
  timeoutMs: 180_000,
};

// R1：allow 一轮（write → shell → 文本，工具循环 3 次模型调用——探针实测）
setScript([
  {
    toolCalls: [
      { id: "c_w1", name: "write_file", args: { file_path: helloPath, content: "hello" } },
    ],
  },
  {
    toolCalls: [
      {
        id: "c_s1",
        name: "run_shell_command",
        args: { command: "node -v", description: "check node" },
      },
    ],
  },
  { text: "Created hello.txt and checked the Node version." },
]);
const r1 = await runOneTurn("R1", {
  ...baseCtx,
  prompt:
    "Create a file named hello.txt containing exactly 'hello'. Then run 'node -v' and briefly say what you did.",
});

// R2：deny 一轮（坑 2 防线真机自证）。拒绝后 iFlow 不再调模型发工具，直接收尾文本
setScript([
  {
    toolCalls: [
      { id: "c_w2", name: "write_file", args: { file_path: deniedPath, content: "nope" } },
    ],
  },
  { text: "Attempted to write denied.txt." },
]);
const r2 = await runOneTurn(
  "R2",
  { ...baseCtx, prompt: "Create a file named denied.txt containing 'nope'." },
  { onPermission: "deny" },
);

// R3：resume 首轮会话（session/load 真机 + 会话互通）
const r1Start = r1.events.find((e) => e.kind === "session_start");
const sessionId = r1Start?.native?.nativeSessionId ?? "";
setScript([{ text: "Resumed and replied." }]);
const r3 = await runOneTurn("R3", {
  ...baseCtx,
  prompt: "Say 'resumed' and nothing else.",
  resume: { nativeSessionId: sessionId, cwd: projectRoot },
});

// R4：优雅取消（模型端拖住不回，session/cancel 落定）
setScript([{ delayMs: 120_000 }]);
const r4 = await runOneTurn(
  "R4",
  { ...baseCtx, prompt: "This turn will be cancelled." },
  { cancelOnStart: true },
);

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(name);
};

const endOf = (r) => r.events.filter((e) => e.kind === "end");
const r1End = endOf(r1);
const r1Changes = r1.events.filter((e) => e.kind === "file_change");
const r1Commands = r1.events.filter((e) => e.kind === "command");
const r1Texts = r1.events.filter((e) => e.kind === "text" && e.channel === "answer");
const r1FirstAction = r1.events.findIndex((e) => e.kind === "file_change" || e.kind === "command");
const r1StartIndex = r1.events.findIndex((e) => e.kind === "session_start");

console.log("\n[live] 判据（iFlow ACP 单通道）：");
check(
  "R1 end 恰一条 completed 且在最后",
  r1End.length === 1 && r1End[0]?.reason === "completed" && r1.events.at(-1)?.kind === "end",
  r1End[0]?.message ?? "",
);
check(
  "R1 session_start 先于一切动作且带原生会话 ID（开轮即得）",
  r1StartIndex >= 0 && r1StartIndex < r1FirstAction && sessionId.length > 0,
  sessionId,
);
check(
  "R1 权限真转发（write_path + shell_command 各至少一次）",
  r1.permissions.some((p) => p.payload.kind === "write_path") &&
    r1.permissions.some((p) => p.payload.kind === "shell_command"),
  r1.permissions.map((p) => p.payload.kind).join("、"),
);
check("R1 hello.txt 真落地（allow 回执生效）", existsSync(helloPath));
check(
  "R1 file_change completed 带 fileDiff 统一 diff（含 +hello）",
  r1Changes.some((c) => c.status === "completed" && (c.diff ?? "").includes("+hello")),
);
check(
  "R1 command completed 带输出 v* 且 exitCode 如实缺席（partial 声明自证）",
  r1Commands.some(
    (c) => c.status === "completed" && /v\d+/.test(c.output ?? "") && c.exitCode === undefined,
  ),
);
check("R1 文本以 final 收尾", r1Texts.length > 0 && r1Texts.at(-1)?.final === true);

const r2End = endOf(r2);
check(
  "R2 拒绝记账（坑 2）：denied 事件 + end_turn 改判 failed + denied.txt 未落地",
  r2.events.some((e) => e.kind === "file_change" && e.status === "denied") &&
    r2End[0]?.reason === "failed" &&
    (r2End[0]?.message ?? "").includes("权限桥记账") &&
    !existsSync(deniedPath),
  r2End[0]?.message?.slice(0, 90) ?? "",
);

const r3End = endOf(r3);
const r3Start = r3.events.find((e) => e.kind === "session_start");
check(
  "R3 resume：session/load 复用首轮会话 ID 且 completed（会话互通）",
  r3End[0]?.reason === "completed" && r3Start?.native?.nativeSessionId === sessionId,
);

const r4End = endOf(r4);
check(
  "R4 优雅取消：end cancelled（session/cancel 协议级落定）",
  r4End.length === 1 && r4End[0]?.reason === "cancelled",
  r4End[0]?.message?.slice(0, 80) ?? "",
);

// 受管 HOME 隔离：settings + 数据目录（cache/log/projects…）全部落受管 .iflow
// 目录，用户真实 ~/.iflow 零触碰。判据核「settings 静态落位 + iFlow 自建的数据
// 目录跟到受管 HOME」——这正是坑 5（settings 不跟 IFLOW_HOME、必须换 USERPROFILE/
// HOME）被证伪的观察点：目录若没跟走，这些子目录会出现在用户真实 HOME 里。
// projects 桶内 session 文件写盘晚于事件流收尾（ACP 异步落盘），非隔离本身的判据。
const managedIflow = join(managedHome, ".iflow");
const iflowEntries = existsSync(managedIflow) ? readdirSync(managedIflow) : [];
check(
  "受管 HOME 隔离：settings + iFlow 数据目录（cache/log/projects）落受管 .iflow",
  existsSync(join(managedIflow, "settings.json")) &&
    iflowEntries.includes("projects") &&
    iflowEntries.includes("cache") &&
    iflowEntries.includes("log"),
  `entries=[${iflowEntries.join(",")}]`,
);

server?.close();
rmSync(projectRoot, { recursive: true, force: true });
rmSync(managedHome, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n[live] 失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log("\n[live] ALL PASS");
