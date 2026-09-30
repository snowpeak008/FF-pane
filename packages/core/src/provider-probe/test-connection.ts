/**
 * 连接测试（W1.5c / T10.3）：按模板声明的 probe kind 分发。
 */

import { providerProbeKind } from "@ff-pane/shared";
import {
  anthropicHeaders,
  attemptFailure,
  bearerHeaders,
  formatHttpFailure,
  resolveProbeTarget,
  timedFetch,
} from "./http.js";
import { redactSecret } from "./raw-error.js";
import type { ConnectionTestResult, ProbeProviderInput, TestConnectionParams } from "./types.js";
import { joinAnthropicV1, joinUrl } from "./url.js";

const PROBE_MESSAGES = [{ role: "user", content: "ping" }];

function resolveProbeKind(provider: ProbeProviderInput): ReturnType<typeof providerProbeKind> {
  if (provider.probe !== undefined) {
    return provider.probe;
  }
  if (provider.templateId !== undefined) {
    return providerProbeKind(provider.templateId);
  }
  return "none";
}

function resolveDefaultModel(provider: ProbeProviderInput): string | undefined {
  const id = provider.defaultModelId ?? provider.defaultModel;
  return id !== undefined && id.length > 0 ? id : undefined;
}

export async function testConnection(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const result = await dispatchTestConnection(params);
  if (result.ok) {
    return { ...result, detail: redactSecret(result.detail, params.apiKey) };
  }
  return { ...result, rawError: redactSecret(result.rawError, params.apiKey) };
}

function dispatchTestConnection(params: TestConnectionParams): Promise<ConnectionTestResult> {
  const kind = resolveProbeKind(params.provider);
  switch (kind) {
    case "openai":
      return testOpenAiCompatible(params);
    case "anthropic":
      return testAnthropic(params);
    case "none":
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: "该 Provider 模板不支持 HTTP 连接测试（本机 CLI 或未声明探测方式）",
      });
    default: {
      const exhausted: never = kind;
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: `未知的探测方式：${String(exhausted)}`,
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
    fetchImpl: params.fetchImpl,
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

  const model = params.model ?? resolveDefaultModel(params.provider);
  if (model === undefined || model === "") {
    return {
      ok: false,
      stage: "http",
      rawError: `${modelsFailure}\n（未设置 defaultModelId 且调用方未指定 model，无法回退最小 chat 请求探测）`,
    };
  }
  const chatUrl = joinUrl(target.baseUrl, "chat/completions");
  const chatAttempt = await timedFetch(chatUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: PROBE_MESSAGES, max_tokens: 1, stream: false }),
    timeoutS: target.timeoutS,
    fetchImpl: params.fetchImpl,
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
  const model = params.model ?? resolveDefaultModel(params.provider);
  if (model === undefined || model === "") {
    return {
      ok: false,
      stage: "invalid-config",
      rawError:
        "anthropic 连接测试需要模型 ID（messages 请求的必填字段）：请设置 defaultModelId 或在调用时指定 model",
    };
  }
  const url = joinAnthropicV1(target.baseUrl, "messages");
  const attempt = await timedFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...anthropicHeaders(params.apiKey) },
    body: JSON.stringify({ model, max_tokens: 1, messages: PROBE_MESSAGES }),
    timeoutS: target.timeoutS,
    fetchImpl: params.fetchImpl,
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
