/**
 * 模型列表拉取（W1.5c / T10.3）：按模板 probe kind 分发。
 */

import type { ProviderModel } from "@ff-pane/shared";
import { providerProbeKind } from "@ff-pane/shared";
import {
  anthropicHeaders,
  attemptFailure,
  bearerHeaders,
  formatHttpFailure,
  resolveProbeTarget,
  timedFetch,
} from "./http.js";
import { inferModelKind } from "./model-kind.js";
import { describeCauseChain, redactSecret, truncateRawText } from "./raw-error.js";
import type {
  FetchModelsParams,
  FetchModelsResult,
  ProbeFailure,
  ProbeProviderInput,
} from "./types.js";
import { joinAnthropicV1, joinUrl } from "./url.js";

const ANTHROPIC_MODELS_PAGE_LIMIT = 1000;

function resolveProbeKind(provider: ProbeProviderInput): ReturnType<typeof providerProbeKind> {
  if (provider.probe !== undefined) {
    return provider.probe;
  }
  if (provider.templateId !== undefined) {
    return providerProbeKind(provider.templateId);
  }
  return "none";
}

export async function fetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const result = await dispatchFetchModels(params);
  if (result.ok) {
    return result;
  }
  return { ...result, rawError: redactSecret(result.rawError, params.apiKey) };
}

function dispatchFetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const kind = resolveProbeKind(params.provider);
  switch (kind) {
    case "openai":
      return fetchOpenAiCompatibleModels(params);
    case "anthropic":
      return fetchAnthropicModels(params);
    case "none":
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: "该 Provider 模板不提供模型列表接口，请手动输入模型 ID",
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

async function fetchOpenAiCompatibleModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const target = resolveProbeTarget(params.provider);
  if (!target.ok) {
    return target.failure;
  }
  const url = joinUrl(target.baseUrl, "models");
  const attempt = await timedFetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...bearerHeaders(params.apiKey) },
    timeoutS: target.timeoutS,
    fetchImpl: params.fetchImpl,
  });
  if (attempt.kind !== "response") {
    return attemptFailure(attempt);
  }
  if (!attempt.response.ok) {
    return { ok: false, stage: "http", rawError: formatHttpFailure("GET", url, attempt) };
  }
  return parseModelsBody(attempt.bodyText, `GET ${url}`);
}

async function fetchAnthropicModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const target = resolveProbeTarget(params.provider);
  if (!target.ok) {
    return target.failure;
  }
  const url = `${joinAnthropicV1(target.baseUrl, "models")}?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`;
  const attempt = await timedFetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...anthropicHeaders(params.apiKey) },
    timeoutS: target.timeoutS,
    fetchImpl: params.fetchImpl,
  });
  if (attempt.kind !== "response") {
    return attemptFailure(attempt);
  }
  if (!attempt.response.ok) {
    return { ok: false, stage: "http", rawError: formatHttpFailure("GET", url, attempt) };
  }
  return parseModelsBody(attempt.bodyText, `GET ${url}`);
}

function invalidResponse(rawError: string): ProbeFailure {
  return { ok: false, stage: "invalid-response", rawError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseModelsBody(bodyText: string, requestLabel: string): FetchModelsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    return invalidResponse(
      `${requestLabel} 返回 2xx 但响应体不是合法 JSON（${describeCauseChain(error)}）：\n${truncateRawText(bodyText)}`,
    );
  }
  const data = isRecord(parsed) ? parsed["data"] : undefined;
  if (!Array.isArray(data)) {
    return invalidResponse(`${requestLabel} 的响应缺少 data 数组：\n${truncateRawText(bodyText)}`);
  }
  const models: ProviderModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry["id"];
    if (typeof id !== "string" || id === "") {
      continue;
    }
    const displayNameRaw = entry["display_name"];
    const label = typeof displayNameRaw === "string" && displayNameRaw !== "" ? displayNameRaw : id;
    models.push({ id, label, kind: inferModelKind(id) });
  }
  if (data.length > 0 && models.length === 0) {
    return invalidResponse(
      `${requestLabel} 的 data 数组中没有任何含字符串 id 的条目：\n${truncateRawText(bodyText)}`,
    );
  }
  return { ok: true, models };
}
