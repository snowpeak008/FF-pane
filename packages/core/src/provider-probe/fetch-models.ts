/**
 * 模型列表拉取（W1.5c，设计文档 §4.2）。
 * - openai_compatible：GET {baseUrl}/models，解析 data[].id。
 * - anthropic：GET {baseUrl→/v1}/models?limit=1000（官方端点分页默认 20，
 *   一次拉满上限 1000 避免翻页）；display_name 存在时用作显示名。
 * - 任何失败返回 ok:false——§4.2 不做失败重试，上层直接走手动输入回退。
 * kind 为初始推断（见 model-kind.ts inferModelKind），允许上层修改。
 */

import type { ProviderModel } from "@ff-pane/shared";
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
import type { FetchModelsParams, FetchModelsResult, ProbeFailure } from "./types.js";
import { joinAnthropicV1, joinUrl } from "./url.js";

/** anthropic /v1/models 的单页上限（官方允许的最大 limit），一次拉满免翻页。 */
const ANTHROPIC_MODELS_PAGE_LIMIT = 1000;

/**
 * 模型列表拉取入口。不抛业务异常，失败一律落在 ok:false 分支；
 * 返回前对失败原文做明文 key 兜底脱敏（密钥红线，§4.3）。
 */
export async function fetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const result = await dispatchFetchModels(params);
  if (result.ok) {
    return result;
  }
  return { ...result, rawError: redactSecret(result.rawError, params.apiKey) };
}

function dispatchFetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { provider } = params;
  switch (provider.type) {
    case "openai_compatible":
      return fetchOpenAiCompatibleModels(params);
    case "anthropic":
      return fetchAnthropicModels(params);
    case "cli_login":
    case "custom":
      return Promise.resolve({
        ok: false,
        stage: "unsupported",
        rawError: `${provider.type} Provider 不提供模型列表接口，请手动输入模型 ID`,
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

/**
 * 解析 `{ data: [{ id, display_name? }] }` 形状（OpenAI 与 anthropic 官方响应同构）：
 * - 缺字符串 id 的条目跳过（宽容处理服务端夹带的异形条目）；
 * - data 非空但没有任何可用条目、或整体形状不符，判 invalid-response 并附原文片段；
 * - data 为空数组是合法结果（服务端确实没有模型），返回空列表。
 */
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
    const displayName =
      typeof displayNameRaw === "string" && displayNameRaw !== "" ? displayNameRaw : id;
    models.push({ id, displayName, kind: inferModelKind(id) });
  }
  if (data.length > 0 && models.length === 0) {
    return invalidResponse(
      `${requestLabel} 的 data 数组中没有任何含字符串 id 的条目：\n${truncateRawText(bodyText)}`,
    );
  }
  return { ok: true, models };
}
