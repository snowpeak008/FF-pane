/**
 * OpenAI 兼容的生图请求。
 *
 * - 生成：POST /v1/images/generations
 * - 改图：POST /v1/images/edits（原图字节进，PNG 字节出）
 * - 地址已经带 /v1，或已经是完整的 images 路径时，不再拼一次 /v1
 *
 * 只在内存里交出 PNG 字节：不写磁盘、不打日志，抛出的信息里不含密钥。
 * 供以后的出图工具调用。本文件不接工作台，也不接画板。
 */

import { describeCauseChain, redactSecret } from "@ff-pane/core";

/** 生图 HTTP 失败。message 已去掉密钥。 */
export class OpenAiImagesError extends Error {
  readonly code = "openai-images" as const;

  constructor(message: string) {
    super(message);
    this.name = "OpenAiImagesError";
  }
}

/** generations = 新图，edits = 按原图修改。 */
export type OpenAiImagesAction = "generations" | "edits";

/** 调用中转站时的鉴权与地址。密钥只留在这次请求的内存里。 */
export interface OpenAiImagesRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** 生成一张 PNG。size 不传则不写进请求体。 */
export interface GenerateImagePngInput extends OpenAiImagesRequest {
  readonly prompt: string;
  readonly size?: string;
}

/** 按原图改一张 PNG。imagePng 是原图字节。 */
export interface EditImagePngInput extends GenerateImagePngInput {
  readonly imagePng: Uint8Array;
}

const TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REASON_MAX = 500;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function publicReason(text: string, apiKey: string): string {
  const redacted = redactSecret(text, apiKey.trim());
  if (redacted.length <= REASON_MAX) {
    return redacted;
  }
  return `${redacted.slice(0, REASON_MAX)}…`;
}

function fail(apiKey: string, message: string): never {
  throw new OpenAiImagesError(publicReason(message, apiKey));
}

function requireText(value: string, apiKey: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    fail(apiKey, message);
  }
  return trimmed;
}

function requestSignal(parent: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (parent === undefined) {
    return timeout;
  }
  return AbortSignal.any([parent, timeout]);
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function assertPng(bytes: Uint8Array, apiKey: string): Uint8Array {
  if (bytes.length === 0) {
    fail(apiKey, "响应里没有图片");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    fail(apiKey, "响应图片过大");
  }
  if (!isPng(bytes)) {
    fail(apiKey, "响应不是 PNG");
  }
  return bytes;
}

/**
 * 把用户填的地址收成 generations 或 edits 的 URL。
 * 已是完整路径就沿用（改图时只换最后一段）；已以 /v1 结尾就不再加 /v1。
 */
export function resolveOpenAiImagesUrl(baseUrl: string, action: OpenAiImagesAction): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    throw new OpenAiImagesError("请填写地址");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OpenAiImagesError("地址不是合法的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenAiImagesError("地址要写成 http 或 https 链接");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const generations = /\/images\/generations$/i;
  const edits = /\/images\/edits$/i;
  let nextPath: string;
  if (action === "generations" && generations.test(path)) {
    nextPath = path;
  } else if (action === "edits" && edits.test(path)) {
    nextPath = path;
  } else if (generations.test(path) || edits.test(path)) {
    nextPath = path.replace(/\/(?:generations|edits)$/i, `/${action}`);
  } else if (/\/images$/i.test(path)) {
    nextPath = `${path}/${action}`;
  } else if (/\/v1$/i.test(path)) {
    nextPath = `${path}/images/${action}`;
  } else {
    const prefix = path === "" ? "" : path;
    nextPath = `${prefix}/v1/images/${action}`;
  }
  if (!nextPath.startsWith("/")) {
    nextPath = `/${nextPath}`;
  }
  url.pathname = nextPath;
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function readErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "string" && error.trim() !== "") {
    return error.trim();
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim() !== "") {
      return message.trim();
    }
  }
  const message = record["message"];
  if (typeof message === "string" && message.trim() !== "") {
    return message.trim();
  }
  return undefined;
}

function firstImagePayload(
  payload: unknown,
): { readonly b64: string } | { readonly url: string } | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) {
    return undefined;
  }
  const first = data[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const record = first as Record<string, unknown>;
  const b64 = record["b64_json"];
  if (typeof b64 === "string" && b64.trim() !== "") {
    return { b64: b64.trim() };
  }
  const imageUrl = record["url"];
  if (typeof imageUrl === "string" && imageUrl.trim() !== "") {
    return { url: imageUrl.trim() };
  }
  return undefined;
}

function decodeB64Png(b64: string, apiKey: string): Uint8Array {
  const buffer = Buffer.from(b64, "base64");
  return assertPng(Uint8Array.from(buffer), apiKey);
}

async function fetchPngUrl(
  imageUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    fail(apiKey, "响应里的图片地址不可用");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(apiKey, "响应里的图片地址不可用");
  }
  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: "GET",
      signal,
      redirect: "follow",
    });
  } catch (error) {
    fail(apiKey, `下载图片失败：${describeCauseChain(error)}`);
  }
  if (!response.ok) {
    fail(apiKey, `下载图片失败（HTTP ${response.status}）`);
  }
  return assertPng(new Uint8Array(await response.arrayBuffer()), apiKey);
}

async function pngFromImagesResponse(
  response: Response,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("image/png")) {
    if (!response.ok) {
      fail(apiKey, `HTTP ${response.status}`);
    }
    return assertPng(new Uint8Array(await response.arrayBuffer()), apiKey);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const detail = (payload !== undefined ? readErrorMessage(payload) : undefined) ?? text;
    fail(apiKey, `HTTP ${response.status}: ${detail}`);
  }
  if (payload === undefined) {
    fail(apiKey, "响应无法解析");
  }
  const image = firstImagePayload(payload);
  if (image === undefined) {
    fail(apiKey, readErrorMessage(payload) ?? "响应里没有图片");
  }
  if ("b64" in image) {
    return decodeB64Png(image.b64, apiKey);
  }
  return fetchPngUrl(image.url, apiKey, fetchImpl, signal);
}

async function postImages(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  body: string | FormData,
  json: boolean,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: json
        ? {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          }
        : { Authorization: `Bearer ${apiKey}` },
      body,
      signal,
    });
  } catch (error) {
    if (error instanceof OpenAiImagesError) {
      throw error;
    }
    fail(apiKey, describeCauseChain(error));
  }
  return pngFromImagesResponse(response, apiKey, fetchImpl, signal);
}

/** 生成一张 PNG 的字节。调用方自己决定写不写盘；这个函数不写。 */
export async function generateImagePng(input: GenerateImagePngInput): Promise<Uint8Array> {
  const apiKey = input.apiKey;
  if (apiKey.trim() === "") {
    fail(apiKey, "请填写密钥");
  }
  const model = requireText(input.model, apiKey, "请填写模型名");
  const prompt = requireText(input.prompt, apiKey, "提示词是空的");
  const url = resolveOpenAiImagesUrl(input.baseUrl, "generations");
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: { model: string; prompt: string; n: number; size?: string } = {
    model,
    prompt,
    n: 1,
  };
  if (input.size !== undefined && input.size.trim() !== "") {
    body.size = input.size.trim();
  }
  return postImages(
    url,
    apiKey,
    fetchImpl,
    requestSignal(input.signal),
    JSON.stringify(body),
    true,
  );
}

/** POST /v1/images/edits。原图字节进，PNG 字节出。不写磁盘。 */
export async function editImagePng(input: EditImagePngInput): Promise<Uint8Array> {
  const apiKey = input.apiKey;
  if (apiKey.trim() === "") {
    fail(apiKey, "请填写密钥");
  }
  const model = requireText(input.model, apiKey, "请填写模型名");
  const prompt = requireText(input.prompt, apiKey, "提示词是空的");
  if (input.imagePng.byteLength === 0) {
    fail(apiKey, "原图是空的");
  }
  const url = resolveOpenAiImagesUrl(input.baseUrl, "edits");
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  const copy = Uint8Array.from(input.imagePng);
  form.set("image", new Blob([copy], { type: "image/png" }), "source.png");
  if (input.size !== undefined && input.size.trim() !== "") {
    form.set("size", input.size.trim());
  }
  return postImages(url, apiKey, fetchImpl, requestSignal(input.signal), form, false);
}
