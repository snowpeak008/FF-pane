/**
 * 连接测试（W1.5c，设计文档 §4.2）：发送一次最小请求，返回 成功 / 失败 + 错误原文。
 * 各类型策略：
 * - openai_compatible：GET {baseUrl}/models（带 Bearer）。404/405 视为服务端未实现
 *   模型列表接口，回退 POST {baseUrl}/chat/completions 最小请求（max_tokens=1，
 *   模型取调用方指定的 model，缺省 provider.defaultModel）。
 * - anthropic：POST {baseUrl→/v1}/messages 最小请求（max_tokens=1，
 *   x-api-key + anthropic-version 头）；模型 ID 是必填字段，缺失返回 invalid-config。
 * - cli_login / custom：不支持 HTTP 探测，返回 stage="unsupported"。
 */

import {
  anthropicHeaders,
  attemptFailure,
  bearerHeaders,
  formatHttpFailure,
  resolveProbeTarget,
  timedFetch,
} from "./http.js";
import { redactSecret } from "./raw-error.js";
import type { ConnectionTestResult, TestConnectionParams } from "./types.js";
import { joinAnthropicV1, joinUrl } from "./url.js";

/** 最小探测请求共用的消息体：单条用户消息，配合 max_tokens=1 把消耗压到最低。 */
const PROBE_MESSAGES = [{ role: "user", content: "ping" }];

/**
 * 连接测试入口。不抛业务异常，一切预期内失败都落在 ok:false 分支；
 * 返回前对输出做明文 key 兜底脱敏（密钥红线，§4.3）。
 */
export async function testConnection(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const result = await dispatchTestConnection(params);
  if (result.ok) {
    return { ...result, detail: redactSecret(result.detail, params.apiKey) };
  }
  return { ...result, rawError: redactSecret(result.rawError, params.apiKey) };
}

function dispatchTestConnection(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const { provider } = params;
  switch (provider.type) {
    case "openai_compatible":
      return testOpenAiCompatible(params);
    case "anthropic":
      return testAnthropic(params);
    case "cli_login":
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: "cli_login Provider 的凭证由 CLI 自管，不支持 HTTP 连接测试",
      });
    case "custom":
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: "custom Provider 使用自定义请求模板，无法通用构造最小探测请求",
      });
    default: {
      const exhausted: never = provider.type;
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: `未知的 Provider 类型：${String(exhausted)}`,
      });
    }
  }
}

async function testOpenAiCompatible(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const target = resolveProbeTarget(params.provider);
  if (!target.ok) {
    return target.failure;
  }
  const headers = { accept: "application/json", ...bearerHeaders(params.apiKey) };
  const modelsUrl = joinUrl(target.baseUrl, "models");
  const modelsAttempt = await timedFetch(modelsUrl, {
    method: "GET",
    headers,
    timeoutS: target.timeoutS,
  });
  if (modelsAttempt.kind !== "response") {
    return attemptFailure(modelsAttempt);
  }
  if (modelsAttempt.response.ok) {
    return {
      ok: true,
      latencyMs: modelsAttempt.latencyMs,
      detail: `GET ${modelsUrl} → HTTP ${modelsAttempt.response.status}`,
    };
  }

  const modelsFailure = formatHttpFailure("GET", modelsUrl, modelsAttempt);
  const modelsStatus = modelsAttempt.response.status;
  if (modelsStatus !== 404 && modelsStatus !== 405) {
    return { ok: false, stage: "http", rawError: modelsFailure };
  }

  // 404/405：服务端未实现 /models，回退最小 chat 请求继续探测连通性与鉴权。
  const model = params.model ?? params.provider.defaultModel;
  if (model === undefined || model === "") {
    return {
      ok: false,
      stage: "http",
      rawError: `${modelsFailure}\n（未设置 defaultModel 且调用方未指定 model，无法回退最小 chat 请求探测）`,
    };
  }
  const chatUrl = joinUrl(target.baseUrl, "chat/completions");
  const chatAttempt = await timedFetch(chatUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: PROBE_MESSAGES, max_tokens: 1, stream: false }),
    timeoutS: target.timeoutS,
  });
  if (chatAttempt.kind !== "response") {
    return attemptFailure(chatAttempt);
  }
  if (chatAttempt.response.ok) {
    return {
      ok: true,
      latencyMs: chatAttempt.latencyMs,
      detail:
        `POST ${chatUrl} → HTTP ${chatAttempt.response.status}` +
        `（GET /models 返回 ${modelsStatus}，已回退最小 chat 请求探测）`,
    };
  }
  return {
    ok: false,
    stage: "http",
    rawError:
      `${modelsFailure}\n` +
      `——已回退最小 chat 请求探测——\n` +
      formatHttpFailure("POST", chatUrl, chatAttempt),
  };
}

async function testAnthropic(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const target = resolveProbeTarget(params.provider);
  if (!target.ok) {
    return target.failure;
  }
  const model = params.model ?? params.provider.defaultModel;
  if (model === undefined || model === "") {
    return {
      ok: false,
      stage: "invalid-config",
      rawError:
        "anthropic 连接测试需要模型 ID（messages 请求的必填字段）：请设置 defaultModel 或在调用时指定 model",
    };
  }
  const url = joinAnthropicV1(target.baseUrl, "messages");
  const attempt = await timedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...anthropicHeaders(params.apiKey) },
    body: JSON.stringify({ model, max_tokens: 1, messages: PROBE_MESSAGES }),
    timeoutS: target.timeoutS,
  });
  if (attempt.kind !== "response") {
    return attemptFailure(attempt);
  }
  if (attempt.response.ok) {
    return {
      ok: true,
      latencyMs: attempt.latencyMs,
      detail: `POST ${url} → HTTP ${attempt.response.status}`,
    };
  }
  return { ok: false, stage: "http", rawError: formatHttpFailure("POST", url, attempt) };
}
