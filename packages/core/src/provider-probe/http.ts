/**
 * 探测请求的底层管道（W1.5c 内部实现，不进 barrel）：
 * 带超时的 fetch、探测目标解析（baseUrl / timeoutS 校验）、HTTP 失败原文组装、
 * 鉴权头构造。密钥红线：明文 key 只进请求头，绝不进入 URL / 请求体 / 返回值。
 *
 * 下方 reference 指令：本文件用到 Node 运行时全局（fetch / Response / AbortSignal /
 * performance / URL），而本包 tsconfig 未开 "types"，需显式引入 @types/node 的全局声明。
 * 这些全局不可用模块导入替代（Node 未从任何内置模块导出 fetch / AbortSignal）。
 */

/// <reference types="node" />

import { PROVIDER_DEFAULT_TIMEOUT_S } from "@ff-pane/shared";
import { describeCauseChain, truncateRawText } from "./raw-error.js";
import type { ProbeFailure, ProbeProviderInput } from "./types.js";
import { normalizeBaseUrl } from "./url.js";

/** anthropic 必需的 API 版本头（官方要求的固定日期版本）。 */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 单次 HTTP 尝试：拿到响应（任意状态码）/ 超时 / 网络层失败。kind 与失败 stage 同名。 */
export type HttpAttempt =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly bodyText: string;
      readonly latencyMs: number;
    }
  | { readonly kind: "timeout"; readonly rawError: string }
  | { readonly kind: "network"; readonly rawError: string };

/** 拿到 HTTP 响应的尝试（含非 2xx）。 */
export type HttpResponseAttempt = Extract<HttpAttempt, { kind: "response" }>;

/** timedFetch 的请求参数。 */
export interface TimedFetchInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutS: number;
}

/** 判定错误（沿 cause 链）是否为超时/中止。本模块唯一的 abort 源是超时信号。 */
function isTimeoutLike(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const name = (current as { readonly name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/**
 * 发起一次带超时的请求并读完响应体。
 * 超时用 AbortSignal.timeout，同一信号覆盖连接与响应体读取全程；
 * 网络层失败的 rawError 取 cause 链原始 message（describeCauseChain）。
 */
export async function timedFetch(url: string, init: TimedFetchInit): Promise<HttpAttempt> {
  const timeoutMs = Math.max(1, Math.round(init.timeoutS * 1000));
  const requestInit: RequestInit = {
    method: init.method,
    headers: { ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  const startedAt = performance.now();
  try {
    const response = await fetch(url, requestInit);
    const bodyText = await response.text();
    return {
      kind: "response",
      response,
      bodyText,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (isTimeoutLike(error)) {
      return {
        kind: "timeout",
        rawError: `请求超时：${init.timeoutS} 秒内未完成（${init.method} ${url}）`,
      };
    }
    return { kind: "network", rawError: describeCauseChain(error) };
  }
}

/** 超时 / 网络层失败的尝试直接映射为 ProbeFailure（kind 即 stage）。 */
export function attemptFailure(attempt: Exclude<HttpAttempt, { kind: "response" }>): ProbeFailure {
  return { ok: false, stage: attempt.kind, rawError: attempt.rawError };
}

/**
 * 非 2xx 响应的错误原文：状态行（含方法与 URL，URL 中不含密钥）+ 响应体原文。
 * 响应体仅做长度截断（truncateRawText），不改写内容（§4.2）。
 */
export function formatHttpFailure(
  method: string,
  url: string,
  attempt: HttpResponseAttempt,
): string {
  const { response, bodyText } = attempt;
  const statusLine =
    response.statusText === ""
      ? `HTTP ${response.status}`
      : `HTTP ${response.status} ${response.statusText}`;
  const head = `${statusLine}（${method} ${url}）`;
  return bodyText === "" ? `${head}\n（响应体为空）` : `${head}\n${truncateRawText(bodyText)}`;
}

/** 探测目标解析结果：合法的 baseUrl（已去尾斜杠）+ 生效超时秒数，或 invalid-config 失败。 */
export type ProbeTarget =
  | { readonly ok: true; readonly baseUrl: string; readonly timeoutS: number }
  | { readonly ok: false; readonly failure: ProbeFailure };

function invalidConfig(rawError: string): ProbeTarget {
  return { ok: false, failure: { ok: false, stage: "invalid-config", rawError } };
}

/** 发请求前的配置校验：baseUrl 必须是合法 http(s) 地址，timeoutS 必须为正数。 */
export function resolveProbeTarget(provider: ProbeProviderInput): ProbeTarget {
  const rawBaseUrl = provider.baseUrl?.trim() ?? "";
  if (rawBaseUrl === "") {
    return invalidConfig("Provider 未配置 baseUrl，无法发起探测请求");
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return invalidConfig(`baseUrl 不是合法 URL：${rawBaseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidConfig(`baseUrl 必须是 http/https 地址：${rawBaseUrl}`);
  }
  const timeoutS = provider.timeoutS ?? PROVIDER_DEFAULT_TIMEOUT_S;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    return invalidConfig(`timeoutS 必须是正数，当前值：${String(provider.timeoutS)}`);
  }
  return { ok: true, baseUrl, timeoutS };
}

/** openai_compatible 的鉴权头；key 缺省（如本地 Ollama）则不带 Authorization。 */
export function bearerHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined || apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` };
}

/** anthropic 的鉴权 + 版本头；key 缺省则只带版本头（服务端自会返回 401 原文）。 */
export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "anthropic-version": ANTHROPIC_VERSION,
    ...(apiKey === undefined || apiKey === "" ? {} : { "x-api-key": apiKey }),
  };
}
