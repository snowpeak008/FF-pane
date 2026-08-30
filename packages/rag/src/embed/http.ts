/**
 * 嵌入客户端的 HTTP 底座（T6.3 内部实现，不进 barrel）。
 *
 * 与 core 的 provider-probe/http 是**同源不同命**的两份代码，刻意不复用：
 * probe 属于「设置页探测」，失败要给用户看原文、返回 ok:false 结果对象；
 * 本层属于「批量管道」，失败要能被调度层按 retriable 分流、必须抛。
 * 若为共用这几十行给 rag 加一条对 core 的包依赖，代价（依赖图多一条边、
 * rag 从此不能独立于 core 演进）远大于收益。
 *
 * 下方 reference 指令的原因同 core/src/provider-probe/http.ts：
 * 本文件用到 Node 运行时全局（fetch / Response / AbortSignal / URL）。
 */

/// <reference types="node" />

import {
  EmbedAbortedError,
  EmbedConfigError,
  EmbedHttpError,
  EmbedNetworkError,
  EmbedResponseError,
  EmbedTimeoutError,
} from "./errors.js";
import type { FetchLike } from "./types.js";

/** 失败原文的最大保留长度：够定位问题，又不至于把整页 HTML 错误页灌进日志。 */
export const ERROR_BODY_MAX_LENGTH = 2000;

/** 截断过长的失败原文，并标注截断事实（不改写内容本身）。 */
export function truncateBody(text: string): string {
  return text.length <= ERROR_BODY_MAX_LENGTH
    ? text
    : `${text.slice(0, ERROR_BODY_MAX_LENGTH)}…（已截断，原文共 ${text.length} 字符）`;
}

/** 去除首尾空白与尾部斜杠（多个尾斜杠一并去除）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * 前缀式拼接：baseUrl 视为完整前缀，去尾斜杠后直接拼子路径。
 * 刻意不用 `new URL(path, base)` 的相对解析——base 无尾斜杠时它会吞掉最后一段
 * 路径（http://x/v1 + "embeddings" → http://x/embeddings），正是要避免的坑。
 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

/** 校验并归一 baseUrl；非法即抛 EmbedConfigError（一次请求都不发就拦下）。 */
export function requireHttpBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === "") {
    throw new EmbedConfigError("baseUrl 为空");
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new EmbedConfigError(`baseUrl 不是合法 URL：${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EmbedConfigError(`baseUrl 必须是 http/https 地址：${baseUrl}`);
  }
  return normalized;
}

/**
 * 取消信号是否已触发。
 * 写成函数而不是内联 `signal?.aborted === true`：后者一旦在 await 之前判过一次，
 * TypeScript 的控制流分析会把 aborted 收窄成 false 并在 await 之后继续沿用——
 * 而这个属性恰恰会在等待期间变成 true。过一层函数调用即可拿到真实值。
 */
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/** 沿 cause 链判定错误是否为超时/中止。 */
function isAbortLike(error: unknown): boolean {
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

/** 沿 cause 链拼出原始错误信息（fetch 的顶层 message 常常只有 "fetch failed"）。 */
function describeCauseChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (message !== "" && !parts.includes(message)) {
      parts.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.length === 0 ? String(error) : parts.join(" ← ");
}

/** POST JSON 的入参。 */
export interface JsonPostRequest {
  /** 完整请求 URL（密钥绝不出现在其中，§4.3）。 */
  readonly url: string;
  /** 请求头（鉴权头在此，且仅在此）。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 请求体对象（本函数负责序列化）。 */
  readonly body: unknown;
  /** 超时秒数。 */
  readonly timeoutS: number;
  /** 注入式 fetch。 */
  readonly fetch: FetchLike;
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 发一次带超时的 POST JSON，返回解析后的响应体。
 * 全部失败路径都抛 EmbedError 子类，调度层据 retriable 分流：
 * 超时/网络/5xx/429 可重试，鉴权/参数/形状错不可重试。
 */
export async function postJson(request: JsonPostRequest): Promise<unknown> {
  const { url, headers, timeoutS, signal } = request;
  const label = `POST ${url}`;
  if (signalAborted(signal)) {
    throw new EmbedAbortedError(label);
  }

  const timeoutMs = Math.max(1, Math.round(timeoutS * 1000));
  // 超时信号与调用方取消信号合流：任一触发都中止请求（含响应体读取全程）
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  let bodyText: string;
  try {
    response = await request.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(request.body),
      signal: combined,
    });
    bodyText = await response.text();
  } catch (error) {
    // 调用方取消优先于超时判定：两者都会让 fetch 抛 AbortError，靠信号本身区分
    if (signalAborted(signal)) {
      throw new EmbedAbortedError(label);
    }
    if (isAbortLike(error)) {
      throw new EmbedTimeoutError(timeoutS, label);
    }
    throw new EmbedNetworkError(describeCauseChain(error), { cause: error });
  }

  if (!response.ok) {
    throw new EmbedHttpError(response.status, response.statusText, label, truncateBody(bodyText));
  }
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new EmbedResponseError(
      `${label} 返回 2xx 但响应体不是合法 JSON（${describeCauseChain(error)}）：\n${truncateBody(bodyText)}`,
    );
  }
}

/** 取全局 fetch；宿主环境没有（不该发生）时给出可诊断的配置错误。 */
export function resolveFetch(injected: FetchLike | undefined): FetchLike {
  if (injected !== undefined) {
    return injected;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new EmbedConfigError("当前运行时没有全局 fetch，请通过 config.fetch 注入实现");
  }
  return (url, init) => globalThis.fetch(url, init);
}
