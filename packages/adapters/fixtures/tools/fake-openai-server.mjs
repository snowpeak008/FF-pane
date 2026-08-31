/**
 * fixture 录制用的假模型服务端（T7.3）。
 *
 * **它不是测试替身，是录音棚**：单测回放的是已录好的 fixture，本脚本只在补录
 * fixture 时手工运行一次。放进仓库的理由是可溯源——fixture 的 README 要能写出
 * 「这一份是怎么录出来的」，而不是「某次在某人机器上跑出来的」。
 *
 * 为什么要它：Grok Build 与 Aider 的真机录制都卡在「需要一个真模型」上，而
 * fixture 要录的**恰恰不是模型的回答，而是 CLI 自己的输出格式**——事件行长什么样、
 * 工具调用怎么落地、退出码是多少。这些与模型答得对不对完全无关。用一个说 OpenAI
 * 兼容协议的本地服务端把模型这一环换掉，录到的仍是**真实 CLI 的真实行为**，
 * 只是它的对话方是可复现的：同样的脚本永远录出同样的流，且不花钱、不联网、
 * 不需要任何人的账号。
 *
 * 用法：
 *   node fake-openai-server.mjs --port 8181 --script <路径> [--dump <目录>]
 *
 * --script 指向一个 JSON 数组，第 N 个元素对应第 N 次 /v1/chat/completions 请求：
 *   { "text": "..." }                                     纯文本回复
 *   { "toolCalls": [{ "name": "write", "args": {...} }] }  工具调用
 *   { "text": "...", "finishReason": "stop" }              显式指定 finish_reason
 *   { "delayMs": 30000 }                                   拖住不回（录取消/强杀路径）
 * 请求数超出脚本长度时，一律回一句收尾文本（避免 CLI 陷入无限工具循环）。
 *
 * **旁路调用不计入脚本序号**：Grok 一轮里除了主对话，还会各发一次「生成会话标题」
 * 与「生成仪表盘行」的请求（真机 dump 实测）。若按到达顺序机械发牌，脚本第 1 条
 * 会被标题请求吃掉，录出来的流就与脚本对不上、且换个 CLI 版本就得重排。故按请求
 * 内容识别旁路调用、单独应答，主对话的发牌序号只由主对话推进。
 *
 * --dump 把每次请求体原样写进 <目录>/request-<N>.json。录制前先 dump 一轮，
 * 是为了从请求里读出 CLI 声明的工具 schema——工具名与参数键名必须逐字对上，
 * 靠猜的 args 会被 CLI 当成非法调用，录出来的就不是成功流了。
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = new Map(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith("--")) {
      pairs.push([token.slice(2), all[index + 1]?.startsWith("--") ? "true" : all[index + 1]]);
    }
    return pairs;
  }, []),
);

const port = Number(args.get("port") ?? 8181);
const scriptPath = args.get("script");
const dumpDir = args.get("dump");
const script = scriptPath === undefined ? [] : JSON.parse(readFileSync(scriptPath, "utf8"));
if (dumpDir !== undefined) {
  mkdirSync(dumpDir, { recursive: true });
}

/** 主对话序号：脚本按它取第几条回复（旁路调用不推进）。 */
let requestIndex = 0;
/** dump 文件序号：连旁路调用一起编号，dump 出来的就是真实到达顺序。 */
let dumpSeq = 0;

/** 固定的 id / 时间戳：fixture 要可复现，随机值会让两次录制的 diff 全是噪声。 */
const RESPONSE_ID = "chatcmpl-ffpane-fixture";
const CREATED = 1_756_600_000;
const MODEL = "ffpane-fixture-model";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

/** 脚本用尽后的兜底：一句话收尾，绝不再发工具调用。 */
const FALLBACK = { text: "Done." };

/**
 * 旁路调用识别（见模块头）。匹配的是 CLI 自己写死的提示词片段，故用原文子串——
 * 版本漂移导致它认不出来时，症状是脚本被吃掉一条，dump 一眼可见，不会静默出错。
 */
const SIDE_CALL_MARKERS = ["generating the session title", "dashboard line"];

function isSideCall(raw) {
  return SIDE_CALL_MARKERS.some((marker) => raw.includes(marker));
}

function pickStep() {
  const step = script[requestIndex] ?? FALLBACK;
  requestIndex += 1;
  return step;
}

/** 把脚本条目编译成一条 assistant message（非流式形态）。 */
function toMessage(step) {
  if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: step.text ?? null,
      tool_calls: step.toolCalls.map((call, index) => ({
        id: call.id ?? `call_ffpane_${index + 1}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    };
  }
  return { role: "assistant", content: step.text ?? "" };
}

function finishReasonOf(step) {
  if (step.finishReason !== undefined) {
    return step.finishReason;
  }
  return Array.isArray(step.toolCalls) && step.toolCalls.length > 0 ? "tool_calls" : "stop";
}

const USAGE = { prompt_tokens: 812, completion_tokens: 45, total_tokens: 857 };

function sendJson(res, step) {
  const body = {
    id: RESPONSE_ID,
    object: "chat.completion",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, message: toMessage(step), finish_reason: finishReasonOf(step) }],
    usage: USAGE,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** SSE 流式：分块吐 delta，最后一条带 finish_reason，再发 [DONE]。 */
function sendStream(res, step) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const emit = (delta, finishReason = null) => {
    const chunk = {
      id: RESPONSE_ID,
      object: "chat.completion.chunk",
      created: CREATED,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  emit({ role: "assistant", content: "" });
  const message = toMessage(step);
  if (message.tool_calls !== undefined) {
    message.tool_calls.forEach((call, index) => {
      // 工具参数一次性给全：分片投递的重组逻辑不是本脚本要验证的东西。
      emit({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: call.function.arguments },
          },
        ],
      });
    });
    if (typeof message.content === "string" && message.content.length > 0) {
      emit({ content: message.content });
    }
  } else if (typeof message.content === "string" && message.content.length > 0) {
    // 切成两片，让「流式是真的流式」在录到的事件里看得出来。
    const half = Math.ceil(message.content.length / 2);
    emit({ content: message.content.slice(0, half) });
    emit({ content: message.content.slice(half) });
  }
  emit({}, finishReasonOf(step));
  res.write(
    `data: ${JSON.stringify({
      id: RESPONSE_ID,
      object: "chat.completion.chunk",
      created: CREATED,
      model: MODEL,
      choices: [],
      usage: USAGE,
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: MODEL, object: "model", created: CREATED, owned_by: "ffpane" }],
      }),
    );
    return;
  }
  if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unsupported: ${req.method} ${url}` } }));
    return;
  }

  const raw = await readBody(req);
  if (dumpDir !== undefined) {
    writeFileSync(join(dumpDir, `request-${dumpSeq++}.json`), raw, "utf8");
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 请求体解析不了也照常回一条，录制脚本不该因为一次坏请求就停摆。
  }
  const side = isSideCall(raw);
  const step = side ? { text: "fixture" } : pickStep();
  process.stderr.write(
    `[fake-openai] ${side ? "side" : `#${requestIndex - 1}`} stream=${parsed.stream === true}\n`,
  );
  if (typeof step.delayMs === "number") {
    // 只拖住不回：录「轮次进行中被强杀」时，CLI 必须停在等模型回复的状态。
    await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  }
  if (parsed.stream === true) {
    sendStream(res, step);
  } else {
    sendJson(res, step);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`[fake-openai] listening on http://127.0.0.1:${port}/v1\n`);
});
