/**
 * W1.5c Provider 连接探测测试：用 node:http 起本地 mock 服务，真实走网络栈。
 * 不发任何真实外网请求；覆盖成功、错误原文透传（含中文体）、超时、/models 解析
 * 与 kind 推断、404 回退 chat 探测、baseUrl 尾斜杠与 /v1 变体，
 * 并断言所有失败路径的输出不含传入的明文 key（密钥红线，§4.3）。
 */

import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchModels,
  inferModelKind,
  joinAnthropicV1,
  joinUrl,
  normalizeBaseUrl,
  RAW_ERROR_MAX_LENGTH,
  REDACTED_KEY_PLACEHOLDER,
  testConnection,
} from "../src/index.js";

/** 特征明显的假 key：断言失败输出不含它。 */
const API_KEY = "sk-ffpane-test-secret-9f8e7d6c5b4a";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type MockHandler = (request: RecordedRequest, res: ServerResponse) => void;

interface MockServer {
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

const openServers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((mock) => mock.close()));
});

/**
 * WHATWG fetch 的「坏端口」黑名单（https://fetch.spec.whatwg.org/#bad-port-blocklist）
 * 中落在操作系统动态端口范围内的那些。清单里 1024 以下的项一并省去——动态端口范围
 * 不会低于 1024，`listen(0)` 拿不到那些端口。
 *
 * 为什么测试需要认识这张表：fetch 规范要求实现对黑名单端口**在建立连接之前**就返回
 * 网络错误，undici 的形态是 `TypeError: fetch failed` 且 cause 的 message 恰为
 * `bad port`。而 `listen(0)` 给的是动态端口范围里的任意一个——本机（Windows，
 * `netsh int ipv4 show dynamicport tcp`）是 1024~15000，与黑名单有 19 处交集，
 * 下表即在该范围上逐端口实测枚举得出。抽中其中之一时 mock 服务照常在听、端口也确实
 * 空闲，但 fetch 永远到不了它，于是本该断言 HTTP 状态的用例会收到 `network` 阶段的
 * 失败。这正是 §4.5 登记的「全量并发下偶发 `fetch failed ← bad port`」的根因：
 * 一次全量约 50 次绑定，命中概率 1-(1-19/13977)^50 ≈ 7%，与实测的约 1/7 吻合。
 *
 * 处置是**消除这个碰运气的前提**而不是给请求加重试：黑名单是端口的静态属性，换一个
 * 端口即可确定性地绕开，而重试请求只会把一个必然失败的调用重试到超时。
 */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** 绑定一个 fetch 真的到得了的本地端口（抽到黑名单上的端口就换一个再绑）。 */
async function listenOnFetchablePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BAD_PORTS.has(port)) {
      return port;
    }
    server.close();
    await once(server, "close");
  }
  throw new Error("连续 64 次 listen(0) 都落在 fetch 坏端口上，无法起 mock 服务");
}

/** 起一个记录全部请求的本地 mock 服务，afterEach 自动关闭。 */
async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  const port = await listenOnFetchablePort(server);
  const mock: MockServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  openServers.push(mock);
  return mock;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const openAiProvider = (baseUrl: string, defaultModel?: string) => ({
  type: "openai_compatible" as const,
  baseUrl,
  timeoutS: 5,
  ...(defaultModel === undefined ? {} : { defaultModel }),
});

const anthropicProvider = (baseUrl: string, defaultModel?: string) => ({
  type: "anthropic" as const,
  baseUrl,
  timeoutS: 5,
  ...(defaultModel === undefined ? {} : { defaultModel }),
});

function expectSuccess<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败：${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

function expectFailure<T extends { ok: boolean }>(result: T): Extract<T, { ok: false }> {
  if (result.ok) {
    throw new Error(`预期失败，实际成功：${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: false }>;
}

describe("testConnection · openai_compatible", () => {
  it("GET /models 返回 200 即成功，请求携带 Bearer 头", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        sendJson(res, 200, { object: "list", data: [] });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const success = expectSuccess(result);
    expect(success.latencyMs).toBeGreaterThanOrEqual(0);
    expect(success.detail).toContain("HTTP 200");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.url).toBe("/v1/models");
    expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("401 时透传 HTTP 状态与响应体原文（含中文），且不含 key", async () => {
    const rawBody = '{"error":{"message":"无效的 API 密钥：请到控制台重新生成"}}';
    const mock = await startMockServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(rawBody);
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 401");
    expect(failure.rawError).toContain("无效的 API 密钥：请到控制台重新生成");
    expect(failure.rawError).not.toContain(API_KEY);
  });

  it("超过 timeoutS 未响应时 stage=timeout", async () => {
    const mock = await startMockServer(() => {
      // 故意不响应，等客户端超时中止。
    });
    const result = await testConnection({
      provider: { ...openAiProvider(`${mock.origin}/v1`), timeoutS: 0.3 },
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("timeout");
    expect(failure.rawError).toContain("超时");
    expect(failure.rawError).not.toContain(API_KEY);
  });

  it("/models 404 时回退最小 chat 请求（用 defaultModel，max_tokens=1）", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        sendJson(res, 200, { id: "chatcmpl-probe" });
        return;
      }
      sendJson(res, 500, {});
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`, "probe-model"),
      apiKey: API_KEY,
    });
    const success = expectSuccess(result);
    expect(success.detail).toContain("回退");
    expect(mock.requests).toHaveLength(2);
    const chatRequest = mock.requests[1];
    expect(chatRequest?.url).toBe("/v1/chat/completions");
    expect(chatRequest?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const chatBody = JSON.parse(chatRequest?.body ?? "{}") as Record<string, unknown>;
    expect(chatBody["model"]).toBe("probe-model");
    expect(chatBody["max_tokens"]).toBe(1);
  });

  it("调用方指定的 model 优先于 defaultModel", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.method === "GET") {
        sendJson(res, 405, {});
        return;
      }
      sendJson(res, 200, { id: "ok" });
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`, "default-model"),
      apiKey: API_KEY,
      model: "override-model",
    });
    expectSuccess(result);
    const chatBody = JSON.parse(mock.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(chatBody["model"]).toBe("override-model");
  });

  it("405 也触发回退；回退再失败时两段错误原文都保留", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed");
        return;
      }
      sendJson(res, 401, { error: "密钥无效" });
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`, "probe-model"),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 405");
    expect(failure.rawError).toContain("HTTP 401");
    expect(failure.rawError).toContain("密钥无效");
    expect(failure.rawError).not.toContain(API_KEY);
  });

  it("404 且无任何模型 ID 可用时不回退，rawError 说明原因", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 404, { error: "no models endpoint" });
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 404");
    expect(failure.rawError).toContain("无法回退");
    expect(failure.rawError).not.toContain(API_KEY);
    expect(mock.requests).toHaveLength(1);
  });

  it("baseUrl 尾斜杠归一：{origin}/v1/ 命中 /v1/models 而非 /v1//models", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === "/v1/models") {
        sendJson(res, 200, { data: [] });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1/`),
      apiKey: API_KEY,
    });
    expectSuccess(result);
    expect(mock.requests[0]?.url).toBe("/v1/models");
  });

  it("baseUrl 不含 /v1 时按用户所填前缀拼接（命中 /models）", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === "/models") {
        sendJson(res, 200, { data: [] });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await testConnection({
      provider: openAiProvider(mock.origin),
      apiKey: API_KEY,
    });
    expectSuccess(result);
    expect(mock.requests[0]?.url).toBe("/models");
  });
});

describe("testConnection · anthropic", () => {
  it("最小 messages 请求：x-api-key + anthropic-version，baseUrl 无 /v1 时自动补", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        sendJson(res, 200, { id: "msg_probe", type: "message" });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await testConnection({
      provider: anthropicProvider(mock.origin, "claude-test-model"),
      apiKey: API_KEY,
    });
    const success = expectSuccess(result);
    expect(success.latencyMs).toBeGreaterThanOrEqual(0);
    const request = mock.requests[0];
    expect(request?.url).toBe("/v1/messages");
    expect(request?.headers["x-api-key"]).toBe(API_KEY);
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("claude-test-model");
    expect(body["max_tokens"]).toBe(1);
  });

  it("baseUrl 已含 /v1（含尾斜杠）不重复补段", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === "/v1/messages") {
        sendJson(res, 200, { id: "msg_probe" });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await testConnection({
      provider: anthropicProvider(`${mock.origin}/v1/`, "claude-test-model"),
      apiKey: API_KEY,
    });
    expectSuccess(result);
    expect(mock.requests[0]?.url).toBe("/v1/messages");
  });

  it("缺模型 ID 时 stage=invalid-config 且不发请求", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 200, {});
    });
    const result = await testConnection({
      provider: anthropicProvider(mock.origin),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("invalid-config");
    expect(failure.rawError).not.toContain(API_KEY);
    expect(mock.requests).toHaveLength(0);
  });

  it("401 时透传中文错误体原文，且不含 key", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 401, {
        type: "error",
        error: { type: "authentication_error", message: "密钥无效或已过期" },
      });
    });
    const result = await testConnection({
      provider: anthropicProvider(mock.origin, "claude-test-model"),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 401");
    expect(failure.rawError).toContain("密钥无效或已过期");
    expect(failure.rawError).not.toContain(API_KEY);
  });
});

describe("testConnection · 不支持的类型与非法配置", () => {
  it("cli_login / custom 返回 stage=unsupported", async () => {
    const cliResult = await testConnection({ provider: { type: "cli_login" } });
    expect(expectFailure(cliResult).stage).toBe("unsupported");
    const customResult = await testConnection({ provider: { type: "custom" } });
    expect(expectFailure(customResult).stage).toBe("unsupported");
  });

  it("缺 baseUrl / 非法 URL / 非 http 协议均为 invalid-config", async () => {
    const missing = await testConnection({ provider: { type: "openai_compatible" } });
    expect(expectFailure(missing).stage).toBe("invalid-config");
    const malformed = await testConnection({
      provider: openAiProvider("这不是一个 URL"),
      apiKey: API_KEY,
    });
    expect(expectFailure(malformed).stage).toBe("invalid-config");
    const wrongProtocol = await testConnection({
      provider: openAiProvider("ftp://127.0.0.1/v1"),
      apiKey: API_KEY,
    });
    expect(expectFailure(wrongProtocol).stage).toBe("invalid-config");
  });

  it("连接被拒时 stage=network，rawError 保留 cause 链原始 message", async () => {
    // 先占一个 fetch 可达的端口再放掉：端口本身必须不在坏端口黑名单里，否则 fetch
    // 会在连接之前就拒绝，这条用例就变成了在验证 bad port 而不是在验证连接被拒。
    const server = createServer(() => {});
    const port = await listenOnFetchablePort(server);
    server.close();
    await once(server, "close");

    const result = await testConnection({
      provider: openAiProvider(`http://127.0.0.1:${port}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("network");
    expect(failure.rawError).toMatch(/ECONNREFUSED|fetch failed/);
    expect(failure.rawError).not.toContain(API_KEY);
  });
});

describe("fetchModels · openai_compatible", () => {
  it("解析 data[].id 并推断 kind（含 embed → embedding），异形条目跳过", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 200, {
        object: "list",
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "text-embedding-3-small", object: "model" },
          { id: "nomic-embed-text", object: "model" },
          { object: "model" },
        ],
      });
    });
    const result = await fetchModels({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const success = expectSuccess(result);
    expect(success.models).toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", kind: "chat" },
      { id: "text-embedding-3-small", displayName: "text-embedding-3-small", kind: "embedding" },
      { id: "nomic-embed-text", displayName: "nomic-embed-text", kind: "embedding" },
    ]);
  });

  it("HTTP 失败时透传原文，不含 key", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 403, { error: "配额已用尽" });
    });
    const result = await fetchModels({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 403");
    expect(failure.rawError).toContain("配额已用尽");
    expect(failure.rawError).not.toContain(API_KEY);
  });

  it("200 但响应体非 JSON 时 stage=invalid-response 且附原文片段", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>服务器错误页</html>");
    });
    const result = await fetchModels({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("invalid-response");
    expect(failure.rawError).toContain("<html>服务器错误页</html>");
    expect(failure.rawError).not.toContain(API_KEY);
  });

  it("200 但缺 data 数组时 stage=invalid-response", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 200, { models: ["a"] });
    });
    const result = await fetchModels({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    expect(expectFailure(result).stage).toBe("invalid-response");
  });

  it("cli_login / custom 直接 unsupported（上层走手动输入回退）", async () => {
    const result = await fetchModels({ provider: { type: "cli_login" } });
    expect(expectFailure(result).stage).toBe("unsupported");
  });
});

describe("fetchModels · anthropic", () => {
  it("官方 /v1/models：display_name 优先作显示名，limit=1000 免翻页", async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        sendJson(res, 200, {
          data: [
            { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" },
            { id: "claude-haiku-4", type: "model" },
          ],
          has_more: false,
        });
        return;
      }
      sendJson(res, 404, {});
    });
    const result = await fetchModels({
      provider: anthropicProvider(mock.origin),
      apiKey: API_KEY,
    });
    const success = expectSuccess(result);
    expect(success.models).toEqual([
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", kind: "chat" },
      { id: "claude-haiku-4", displayName: "claude-haiku-4", kind: "chat" },
    ]);
    const request = mock.requests[0];
    expect(request?.url).toContain("limit=1000");
    expect(request?.headers["x-api-key"]).toBe(API_KEY);
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("端点不可用（404）时 ok:false 透传原文，上层走手动输入回退", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 404, { error: "接口不存在" });
    });
    const result = await fetchModels({
      provider: anthropicProvider(mock.origin),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.stage).toBe("http");
    expect(failure.rawError).toContain("HTTP 404");
    expect(failure.rawError).toContain("接口不存在");
    expect(failure.rawError).not.toContain(API_KEY);
  });
});

describe("密钥红线与原文截断", () => {
  it("服务端把 Authorization 头回显进错误体时，rawError 兜底脱敏", async () => {
    const mock = await startMockServer((req, res) => {
      sendJson(res, 500, { error: `bad token: ${req.headers.authorization ?? ""}` });
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.rawError).not.toContain(API_KEY);
    expect(failure.rawError).toContain(REDACTED_KEY_PLACEHOLDER);
  });

  it("超长响应体截断到 RAW_ERROR_MAX_LENGTH 并标注，原文前缀不改写", async () => {
    const hugeBody = "错误详情".repeat(1500);
    const mock = await startMockServer((_req, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(hugeBody);
    });
    const result = await testConnection({
      provider: openAiProvider(`${mock.origin}/v1`),
      apiKey: API_KEY,
    });
    const failure = expectFailure(result);
    expect(failure.rawError).toContain("已截断");
    expect(failure.rawError).toContain("错误详情错误详情");
    expect(failure.rawError.length).toBeLessThan(RAW_ERROR_MAX_LENGTH + 200);
  });
});

describe("URL 组装与 kind 推断（纯函数）", () => {
  it("normalizeBaseUrl 去除首尾空白与全部尾斜杠", () => {
    expect(normalizeBaseUrl(" http://x/v1/ ")).toBe("http://x/v1");
    expect(normalizeBaseUrl("http://x///")).toBe("http://x");
    expect(normalizeBaseUrl("http://x")).toBe("http://x");
  });

  it("joinUrl 前缀式拼接，不吞 basePath", () => {
    expect(joinUrl("http://x/v1", "models")).toBe("http://x/v1/models");
    expect(joinUrl("http://x/v1/", "/models")).toBe("http://x/v1/models");
    expect(joinUrl("http://x", "chat/completions")).toBe("http://x/chat/completions");
  });

  it("joinAnthropicV1 对 /v1 归一，不出现 /v1/v1", () => {
    expect(joinAnthropicV1("http://x", "messages")).toBe("http://x/v1/messages");
    expect(joinAnthropicV1("http://x/v1", "messages")).toBe("http://x/v1/messages");
    expect(joinAnthropicV1("http://x/v1/", "models")).toBe("http://x/v1/models");
  });

  it("inferModelKind：id 含 embed（不分大小写）→ embedding，其余 chat", () => {
    expect(inferModelKind("text-embedding-3-large")).toBe("embedding");
    expect(inferModelKind("EMBED-english-v3")).toBe("embedding");
    expect(inferModelKind("deepseek-chat")).toBe("chat");
    expect(inferModelKind("claude-haiku-4")).toBe("chat");
  });
});
