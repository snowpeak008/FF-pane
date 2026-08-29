/**
 * OpenCode Server HTTP 客户端（W2.6）：端点组装与响应收窄。
 *
 * 与 server.ts 分开的理由：生命周期（spawn / 健康检查 / 崩溃重启）和"往哪个 URL
 * 发什么请求"是两件事，分开后假 HTTP 服务（node:http）就能在不启动任何
 * OpenCode 进程的前提下验证请求组装（测试即如此）。
 *
 * 端点全部取自 1.18.25 真机 `GET /doc`（OpenAPI 3.1）与 T2.0 fixture：
 * - `GET  /global/health`                              → `{healthy, version}`
 * - `POST /session?directory=<cwd>`                    → Session 对象
 * - `GET  /session/:id?directory=<cwd>`                → Session 对象（resume 校验）
 * - `POST /session/:id/prompt_async?directory=<cwd>`   → 204，事件走 SSE
 * - `POST /session/:id/permissions/:permissionID`      → 200 `true`
 * - `POST /session/:id/abort`                          → 200 `true`
 * - `GET  /event`                                      → text/event-stream
 *
 * 认证：`opencode serve` 在设了 `OPENCODE_SERVER_PASSWORD` 时开 basic auth。
 * 用户名实测**必须是字面量 `opencode`**（空用户名与任意其他用户名均 401，
 * 1.18.25 本机实测），故此处写死，不做成可配置项以免误配成 401。
 */

/// <reference types="node" />

/** 可注入的 fetch（测试用假 HTTP 服务时仍走真 fetch，此处只为便于替换与超时包装）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** HTTP 层失败。网络错误与非 2xx 都归一到这里，调用方无需区分两种异常形态。 */
export class OpenCodeHttpError extends Error {
  override readonly name = "OpenCodeHttpError";
  /** 非 2xx 时的状态码；网络层失败时为 undefined。 */
  readonly status: number | undefined;
  readonly method: string;
  readonly url: string;
  /** 响应体前若干字符，便于定位（不含请求体，避免密钥入日志）。 */
  readonly body: string | undefined;

  constructor(init: {
    message: string;
    method: string;
    url: string;
    status?: number | undefined;
    body?: string | undefined;
  }) {
    super(init.message);
    this.method = init.method;
    this.url = init.url;
    this.status = init.status;
    this.body = init.body;
  }
}

/** 权限回执取值（OpenCode 原生三态）。 */
export type OpenCodePermissionReply = "once" | "always" | "reject";

/** `POST /session` 与 `GET /session/:id` 的响应中本适配器关心的字段。 */
export interface OpenCodeSession {
  readonly id: string;
  /** 会话绑定的工作目录（resume 校验依据）。 */
  readonly directory?: string;
  readonly title?: string;
  readonly parentID?: string;
  readonly version?: string;
}

/** `POST /session` 的入参。 */
export interface CreateSessionInput {
  readonly directory?: string | undefined;
  readonly title?: string | undefined;
  readonly agent?: string | undefined;
}

/** `POST /session/:id/prompt_async` 的入参。 */
export interface PromptInput {
  readonly sessionId: string;
  readonly text: string;
  readonly directory?: string | undefined;
  readonly agent?: string | undefined;
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined;
}

/** 客户端构造参数。 */
export interface OpenCodeClientOptions {
  /** 形如 `http://127.0.0.1:4096`，末尾斜杠会被去掉。 */
  readonly baseUrl: string;
  /** `OPENCODE_SERVER_PASSWORD` 的值；缺席表示服务未开 basic auth。 */
  readonly password?: string | undefined;
  /** 普通请求超时（毫秒），默认 30 秒。SSE 订阅不受此限制。 */
  readonly requestTimeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

/** OpenCode Server 客户端。 */
export interface OpenCodeClient {
  readonly baseUrl: string;
  health(): Promise<{ readonly healthy: boolean; readonly version: string }>;
  createSession(input: CreateSessionInput): Promise<OpenCodeSession>;
  getSession(sessionId: string, directory?: string): Promise<OpenCodeSession>;
  promptAsync(input: PromptInput): Promise<void>;
  /**
   * 回复权限请求。主路径是 fixture 实证的
   * `POST /session/:id/permissions/:permissionID`（1.18.25 的 OpenAPI 已把它标
   * deprecated），404/405/410/501 时自动改走新端点 `POST /permission/:id/reply`
   * ——这是版本漂移的第一道防线，见 server.ts 对 R3 风险的整体说明。
   */
  respondPermission(
    sessionId: string,
    permissionId: string,
    reply: OpenCodePermissionReply,
  ): Promise<void>;
  abort(sessionId: string, directory?: string): Promise<boolean>;
  /** 订阅全局事件流；返回原始字节块流，交给 sse.ts 解码。 */
  subscribeEvents(init?: {
    readonly directory?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<AsyncIterable<Uint8Array>>;
}

/** 默认普通请求超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** basic auth 的固定用户名（1.18.25 实测）。 */
export const OPENCODE_BASIC_AUTH_USER = "opencode";

const BODY_SNIPPET_LIMIT = 512;

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | undefined>,
): string {
  const search = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${baseUrl}${path}${search === "" ? "" : `?${search}`}`;
}

/** Web ReadableStream → AsyncIterable<Uint8Array>（不依赖 Node 版本是否实现流的异步迭代）。 */
async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
    // 消费方 break / 上层 abort 时主动销毁，避免连接悬挂。
    await body.cancel().catch(() => undefined);
  }
}

/** 创建客户端。 */
export function createOpenCodeClient(options: OpenCodeClientOptions): OpenCodeClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const authHeader =
    options.password === undefined || options.password === ""
      ? undefined
      : `Basic ${Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${options.password}`).toString("base64")}`;

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: "application/json",
      ...(authHeader === undefined ? {} : { authorization: authHeader }),
      ...extra,
    };
  }

  async function request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: headers(body === undefined ? undefined : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new OpenCodeHttpError({
        message: `${method} ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
        method,
        url,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    return { status: response.status, text };
  }

  async function requestOk(method: string, url: string, body?: unknown): Promise<string> {
    const { status, text } = await request(method, url, body);
    if (status < 200 || status >= 300) {
      throw new OpenCodeHttpError({
        message: `${method} ${url} 返回 ${status}`,
        method,
        url,
        status,
        body: text.slice(0, BODY_SNIPPET_LIMIT),
      });
    }
    return text;
  }

  async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
    const text = await requestOk(method, url, body);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new OpenCodeHttpError({
        message: `${method} ${url} 响应不是合法 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
        method,
        url,
        body: text.slice(0, BODY_SNIPPET_LIMIT),
      });
    }
  }

  return {
    baseUrl,

    health: (): Promise<{ healthy: boolean; version: string }> =>
      requestJson("GET", `${baseUrl}/global/health`),

    createSession: (input: CreateSessionInput): Promise<OpenCodeSession> =>
      requestJson("POST", buildUrl(baseUrl, "/session", { directory: input.directory }), {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      }),

    getSession: (sessionId: string, directory?: string): Promise<OpenCodeSession> =>
      requestJson(
        "GET",
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory }),
      ),

    async promptAsync(input: PromptInput): Promise<void> {
      await requestOk(
        "POST",
        buildUrl(baseUrl, `/session/${encodeURIComponent(input.sessionId)}/prompt_async`, {
          directory: input.directory,
        }),
        {
          parts: [{ type: "text", text: input.text }],
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
        },
      );
    },

    async respondPermission(
      sessionId: string,
      permissionId: string,
      reply: OpenCodePermissionReply,
    ): Promise<void> {
      const legacyUrl = `${baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`;
      const { status, text } = await request("POST", legacyUrl, { response: reply });
      if (status >= 200 && status < 300) {
        return;
      }
      if (status !== 404 && status !== 405 && status !== 410 && status !== 501) {
        throw new OpenCodeHttpError({
          message: `POST ${legacyUrl} 返回 ${status}`,
          method: "POST",
          url: legacyUrl,
          status,
          body: text.slice(0, BODY_SNIPPET_LIMIT),
        });
      }
      await requestOk("POST", `${baseUrl}/permission/${encodeURIComponent(permissionId)}/reply`, {
        reply,
      });
    },

    async abort(sessionId: string, directory?: string): Promise<boolean> {
      const text = await requestOk(
        "POST",
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, { directory }),
      );
      return text.trim() === "true";
    },

    async subscribeEvents(init?: {
      directory?: string | undefined;
      signal?: AbortSignal | undefined;
    }): Promise<AsyncIterable<Uint8Array>> {
      const url = buildUrl(baseUrl, "/event", { directory: init?.directory });
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "GET",
          headers: headers({ accept: "text/event-stream" }),
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        });
      } catch (error) {
        throw new OpenCodeHttpError({
          message: `GET ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
          method: "GET",
          url,
        });
      }
      if (!response.ok) {
        throw new OpenCodeHttpError({
          message: `GET ${url} 返回 ${response.status}`,
          method: "GET",
          url,
          status: response.status,
          body: (await response.text()).slice(0, BODY_SNIPPET_LIMIT),
        });
      }
      if (response.body === null) {
        throw new OpenCodeHttpError({
          message: `GET ${url} 没有响应体，无法订阅事件流`,
          method: "GET",
          url,
          status: response.status,
        });
      }
      return iterateBody(response.body);
    },
  };
}
