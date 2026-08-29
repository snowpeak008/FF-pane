/**
 * 探测请求的 URL 组装（W1.5c）。
 *
 * 拼接策略（工单要求"策略你定并测试"）：
 * - baseUrl 视为完整前缀：去除尾部斜杠后直接拼子路径，绝不吞掉已有 basePath。
 *   刻意不用 new URL(path, base) 的相对解析——base 无尾斜杠时它会吞掉最后一段
 *   路径（http://x/v1 + "models" → http://x/models），正是要避免的坑。
 * - openai_compatible：baseUrl 应自带版本段（业界惯例，如 https://api.deepseek.com/v1、
 *   http://localhost:11434/v1），模块只负责拼 /models、/chat/completions，
 *   不自动增删 /v1——用户填什么前缀就用什么前缀。
 * - anthropic：官方路径固定为 /v1/...，joinAnthropicV1 对 baseUrl 是否已带 /v1
 *   做归一（api.anthropic.com 与 api.anthropic.com/v1 两种写法皆可，不会出现 /v1/v1）。
 */

/** 去除首尾空白与尾部斜杠（多个尾斜杠一并去除）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 前缀式拼接：normalizeBaseUrl(baseUrl) + "/" + path（path 首部斜杠去重）。 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

/** anthropic 专用：baseUrl 已以 /v1 结尾则直接拼 endpoint，否则先补 /v1。 */
export function joinAnthropicV1(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const prefix = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return `${prefix}/${endpoint.replace(/^\/+/, "")}`;
}
