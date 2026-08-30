/**
 * T6.3 嵌入管道单测：两种方言客户端（mock 端点，真实走网络栈）+ 批次规划 +
 * 块指纹 + Provider 配置降级 + 批量续传调度（批量 / 并发限制 / 重试 / 失败隔离 / 取消）。
 *
 * 客户端测试沿用 W1.5c 的做法：用 node:http 起本地 mock 服务，
 * 断言真实的请求方法、路径、请求头与请求体——打桩 fetch 测不出 URL 拼错这类问题。
 * 调度测试则用打桩 Embedder，不碰网络：那一层要验的是调度决策，不是 HTTP。
 */

import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Provider } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EmbeddedChunk,
  Embedder,
  EmbeddingVector,
  EmbedRequestOptions,
} from "../src/index.js";
import {
  createEmbedder,
  createOllamaEmbedder,
  createOpenAiEmbedder,
  EmbedConfigError,
  EmbedDimensionError,
  EmbedHttpError,
  EmbedInputError,
  EmbedResponseError,
  EmbedTimeoutError,
  embedChunks,
  embedderConfigFromProvider,
  embeddingFingerprint,
  hashText,
  isFatalEmbedError,
  isRetriableEmbedError,
  OLLAMA_DEFAULT_BASE_URL,
  ollamaApiRoot,
  planBatches,
  resolveProviderEmbedder,
} from "../src/index.js";

const API_KEY = "sk-ffpane-embed-test-1a2b3c4d";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface MockServer {
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

const openServers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((mock) => mock.close()));
});

/** 起一个记录全部请求的本地 mock 服务，afterEach 自动关闭。 */
async function startMockServer(
  handler: (request: RecordedRequest, res: ServerResponse) => void,
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(requests[requests.length - 1] as RecordedRequest, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
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

/** 回一段 JSON。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** openai 形状的成功响应：每个 input 回一个固定维度的向量。 */
function openAiPayload(count: number, dimensions = 3): unknown {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dimensions }, (_, position) => index + position / 10),
    })),
  };
}

describe("openai 方言客户端", () => {
  it("POST {baseUrl}/embeddings，带 Bearer 与 float 编码，向量与入参同序", async () => {
    const mock = await startMockServer((req, res) => {
      const parsed = JSON.parse(req.body) as { input: string[] };
      sendJson(res, 200, openAiPayload(parsed.input.length));
    });
    const embedder = createOpenAiEmbedder({
      api: "openai",
      baseUrl: `${mock.origin}/v1`,
      model: "text-embedding-3-small",
      apiKey: API_KEY,
    });

    const vectors = await embedder.embed(["第一块", "第二块"]);

    expect(vectors).toEqual([
      [0, 0.1, 0.2],
      [1, 1.1, 1.2],
    ]);
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0] as RecordedRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/embeddings");
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(request.body)).toEqual({
      model: "text-embedding-3-small",
      input: ["第一块", "第二块"],
      encoding_format: "float",
    });
    expect(embedder.dimensions).toBe(3);
  });

  it("响应乱序时按 index 归位，而不是按数组顺序", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 200, {
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      });
    });
    const embedder = createOpenAiEmbedder({
      api: "openai",
      baseUrl: `${mock.origin}/v1`,
      model: "m",
    });

    expect(await embedder.embed(["a", "b"])).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("缺 apiKey 时不带 Authorization 头（本地服务无鉴权）", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, openAiPayload(1)));
    await createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" }).embed(["x"]);

    expect((mock.requests[0] as RecordedRequest).headers.authorization).toBeUndefined();
  });

  it("条目数与请求不符 → invalid-response", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, openAiPayload(1)));
    const embedder = createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" });

    await expect(embedder.embed(["a", "b"])).rejects.toThrow(EmbedResponseError);
  });

  it("向量含非有限数 → invalid-response（NaN 混进索引会让相似度静默失真）", async () => {
    const mock = await startMockServer((_req, res) => {
      sendJson(res, 200, { data: [{ index: 0, embedding: [1, null, 3] }] });
    });
    const embedder = createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" });

    await expect(embedder.embed(["a"])).rejects.toThrow(EmbedResponseError);
  });

  it("2xx 但非 JSON → invalid-response，且原文进错误信息", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>网关登录页</html>");
    });
    const embedder = createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" });

    await expect(embedder.embed(["a"])).rejects.toThrow(/网关登录页/);
  });

  it("401 不可重试且属致命；429 与 5xx 可重试", async () => {
    const statuses = [401, 429, 503];
    const mock = await startMockServer((req, res) => {
      const status = statuses[JSON.parse(req.body).input.length - 1] as number;
      sendJson(res, status, { error: "服务端原文" });
    });
    const embedder = createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" });

    const unauthorized = await embedder.embed(["a"]).catch((error: unknown) => error);
    const rateLimited = await embedder.embed(["a", "b"]).catch((error: unknown) => error);
    const unavailable = await embedder.embed(["a", "b", "c"]).catch((error: unknown) => error);

    expect(unauthorized).toBeInstanceOf(EmbedHttpError);
    expect((unauthorized as EmbedHttpError).status).toBe(401);
    expect((unauthorized as EmbedHttpError).message).toContain("服务端原文");
    expect(isRetriableEmbedError(unauthorized)).toBe(false);
    expect(isFatalEmbedError(unauthorized)).toBe(true);
    expect(isRetriableEmbedError(rateLimited)).toBe(true);
    expect(isFatalEmbedError(rateLimited)).toBe(false);
    expect(isRetriableEmbedError(unavailable)).toBe(true);
  });

  it("超时抛 EmbedTimeoutError", async () => {
    const mock = await startMockServer(() => {
      // 故意不响应
    });
    const embedder = createOpenAiEmbedder({
      api: "openai",
      baseUrl: mock.origin,
      model: "m",
      timeoutS: 0.3,
    });

    await expect(embedder.embed(["a"])).rejects.toThrow(EmbedTimeoutError);
  });

  it("维度与 expectedDimensions 不符 → dimension-mismatch（换模型必须重建索引）", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, openAiPayload(1, 4)));
    const embedder = createOpenAiEmbedder({
      api: "openai",
      baseUrl: mock.origin,
      model: "m",
      expectedDimensions: 3,
    });

    const error = await embedder.embed(["a"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbedDimensionError);
    expect((error as EmbedDimensionError).actual).toBe(4);
    expect(isFatalEmbedError(error)).toBe(true);
  });

  it("空数组不发请求；空白文本抛 invalid-input", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, openAiPayload(1)));
    const embedder = createOpenAiEmbedder({ api: "openai", baseUrl: mock.origin, model: "m" });

    expect(await embedder.embed([])).toEqual([]);
    await expect(embedder.embed(["a", "   "])).rejects.toThrow(EmbedInputError);
    expect(mock.requests).toHaveLength(0);
  });

  it("baseUrl 非法在构造时就抛，不留到第一次请求", () => {
    expect(() => createOpenAiEmbedder({ api: "openai", baseUrl: "", model: "m" })).toThrow(
      EmbedConfigError,
    );
    expect(() =>
      createOpenAiEmbedder({ api: "openai", baseUrl: "ftp://x/v1", model: "m" }),
    ).toThrow(EmbedConfigError);
    expect(() =>
      createOpenAiEmbedder({ api: "openai", baseUrl: "http://x/v1", model: "  " }),
    ).toThrow(EmbedConfigError);
  });
});

describe("ollama 方言客户端", () => {
  it("POST {baseUrl}/api/embed，响应 embeddings 按序取用", async () => {
    const mock = await startMockServer((req, res) => {
      const parsed = JSON.parse(req.body) as { input: string[] };
      sendJson(res, 200, {
        embeddings: parsed.input.map((_text, index) => [index, index + 0.5]),
      });
    });
    const embedder = createOllamaEmbedder({
      api: "ollama",
      baseUrl: mock.origin,
      model: "nomic-embed-text",
    });

    expect(await embedder.embed(["甲", "乙"])).toEqual([
      [0, 0.5],
      [1, 1.5],
    ]);
    const request = mock.requests[0] as RecordedRequest;
    expect(request.url).toBe("/api/embed");
    expect(JSON.parse(request.body)).toEqual({ model: "nomic-embed-text", input: ["甲", "乙"] });
  });

  it("baseUrl 误带 /v1 时仍打到原生端点", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, { embeddings: [[1]] }));
    await createOllamaEmbedder({
      api: "ollama",
      baseUrl: `${mock.origin}/v1/`,
      model: "m",
    }).embed(["a"]);

    expect((mock.requests[0] as RecordedRequest).url).toBe("/api/embed");
    expect(ollamaApiRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaApiRoot(OLLAMA_DEFAULT_BASE_URL)).toBe(OLLAMA_DEFAULT_BASE_URL);
  });

  it("embeddings 条数不符 → invalid-response", async () => {
    const mock = await startMockServer((_req, res) => sendJson(res, 200, { embeddings: [[1]] }));
    const embedder = createEmbedder({ api: "ollama", baseUrl: mock.origin, model: "m" });

    await expect(embedder.embed(["a", "b"])).rejects.toThrow(EmbedResponseError);
  });
});

describe("批次规划（planBatches）", () => {
  const tokensOf = (item: { readonly tokens: number }): number => item.tokens;

  it("按条数上限切批，保序且不重不漏", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: index, tokens: 1 }));
    const batches = planBatches(items, tokensOf, { maxItems: 3, maxTokens: 1000 });

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toEqual(items);
  });

  it("按 token 上限切批", () => {
    const items = [{ tokens: 400 }, { tokens: 400 }, { tokens: 400 }];
    const batches = planBatches(items, tokensOf, { maxItems: 100, maxTokens: 800 });

    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("单项超过 token 上限时独占一批，绝不丢块", () => {
    const items = [{ tokens: 10 }, { tokens: 5000 }, { tokens: 10 }];
    const batches = planBatches(items, tokensOf, { maxItems: 100, maxTokens: 800 });

    expect(batches).toEqual([[{ tokens: 10 }], [{ tokens: 5000 }], [{ tokens: 10 }]]);
  });

  it("空输入得空批次；参数非法即抛", () => {
    expect(planBatches([], tokensOf, { maxItems: 4, maxTokens: 10 })).toEqual([]);
    expect(() => planBatches([], tokensOf, { maxItems: 0, maxTokens: 10 })).toThrow(RangeError);
    expect(() => planBatches([], tokensOf, { maxItems: 4, maxTokens: 0 })).toThrow(RangeError);
  });
});

describe("块指纹", () => {
  it("同模型同文稳定，换模型或换文即变", () => {
    const text = "混合检索把关键词召回与向量召回合起来排序。";
    const a = embeddingFingerprint("text-embedding-3-small", text);

    expect(a).toBe(embeddingFingerprint("text-embedding-3-small", text));
    expect(a).toHaveLength(64);
    expect(a).not.toBe(embeddingFingerprint("bge-m3", text));
    expect(a).not.toBe(embeddingFingerprint("text-embedding-3-small", `${text}。`));
  });

  it("分隔符消除拼接歧义（model+text 的边界不可移动）", () => {
    expect(embeddingFingerprint("ab", "c")).not.toBe(embeddingFingerprint("a", "bc"));
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});

describe("Provider → 嵌入配置（未配置即降级）", () => {
  const base: Provider = {
    id: "p1" as Provider["id"],
    name: "本地",
    type: "openai_compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    embeddingModel: "bge-m3" as Provider["embeddingModel"],
    enabled: true,
  };

  it("配齐即产出配置，并能直接造出嵌入器", () => {
    const config = embedderConfigFromProvider(base, { apiKey: API_KEY, expectedDimensions: 1024 });

    expect(config).toEqual({
      api: "openai",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "bge-m3",
      apiKey: API_KEY,
      expectedDimensions: 1024,
    });
    const embedder = resolveProviderEmbedder(base, { apiKey: API_KEY });
    expect(embedder?.model).toBe("bge-m3");
    expect(embedder?.api).toBe("openai");
  });

  it("未启用 / 无嵌入模型 / 无 baseUrl / 类型不支持 → undefined（调用方走纯 FTS）", () => {
    expect(embedderConfigFromProvider({ ...base, enabled: false })).toBeUndefined();
    const withoutModel: Provider = { ...base };
    expect(
      embedderConfigFromProvider({ ...withoutModel, embeddingModel: undefined }),
    ).toBeUndefined();
    expect(embedderConfigFromProvider({ ...base, baseUrl: "  " })).toBeUndefined();
    expect(embedderConfigFromProvider({ ...base, type: "anthropic" })).toBeUndefined();
    expect(embedderConfigFromProvider({ ...base, type: "cli_login" })).toBeUndefined();
    expect(resolveProviderEmbedder({ ...base, type: "custom" })).toBeUndefined();
  });
});

/** 打桩嵌入器：记录每批入参，按 handler 决定成败。调度测试不碰网络。 */
function stubEmbedder(
  handler: (texts: readonly string[], call: number) => Promise<readonly EmbeddingVector[]>,
  overrides: Partial<Pick<Embedder, "maxBatchSize" | "maxBatchTokens" | "model">> = {},
): Embedder & { readonly calls: readonly (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    api: "openai",
    model: overrides.model ?? "stub-embed",
    maxBatchSize: overrides.maxBatchSize ?? 32,
    maxBatchTokens: overrides.maxBatchTokens ?? 8000,
    dimensions: 2,
    calls,
    async embed(
      texts: readonly string[],
      options?: EmbedRequestOptions,
    ): Promise<readonly EmbeddingVector[]> {
      calls.push(texts);
      const vectors = await handler(texts, calls.length);
      if (options?.signal?.aborted === true) {
        throw new Error("aborted");
      }
      return vectors;
    },
  };
}

/** 每个文本回一个可辨识的二维向量。 */
const echoVectors = (texts: readonly string[]): Promise<readonly EmbeddingVector[]> =>
  Promise.resolve(texts.map((text) => [text.length, 1]));

/** n 个互不相同的块。 */
function chunksOf(count: number, prefix = "块"): readonly { readonly text: string }[] {
  return Array.from({ length: count }, (_, index) => ({ text: `${prefix}${index}` }));
}

describe("批量续传调度（embedChunks）", () => {
  it("按 maxBatchSize 切批，结果逐块交付且带原块与下标", async () => {
    const embedder = stubEmbedder(echoVectors);
    const results: EmbeddedChunk<{ readonly text: string }>[] = [];

    const report = await embedChunks(chunksOf(10), {
      embedder,
      maxBatchSize: 4,
      concurrency: 1,
      onEmbedded: (result) => {
        results.push(result);
      },
    });

    expect(embedder.calls.map((call) => call.length)).toEqual([4, 4, 2]);
    expect(report).toMatchObject({ total: 10, embedded: 10, skipped: 0, failed: 0, requests: 3 });
    expect(results).toHaveLength(10);
    expect(results.map((result) => result.index).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(results[0]?.chunk.text).toBe("块0");
    expect(results[0]?.fingerprint).toBe(embeddingFingerprint("stub-embed", "块0"));
  });

  it("断点续传：指纹已在库的块直接跳过，不进任何请求", async () => {
    const embedder = stubEmbedder(echoVectors);
    const done = new Set([embeddingFingerprint("stub-embed", "块1")]);

    const report = await embedChunks(chunksOf(3), {
      embedder,
      maxBatchSize: 10,
      isEmbedded: (fingerprint) => done.has(fingerprint),
    });

    expect(report).toMatchObject({ total: 3, embedded: 2, skipped: 1 });
    expect(embedder.calls).toEqual([["块0", "块2"]]);
  });

  it("同一轮内重复文本只算一次，结果扇出到每个下标", async () => {
    const embedder = stubEmbedder(echoVectors);
    const seen: number[] = [];

    const report = await embedChunks([{ text: "同一段" }, { text: "另一段" }, { text: "同一段" }], {
      embedder,
      onEmbedded: (result) => {
        seen.push(result.index);
      },
    });

    expect(embedder.calls).toEqual([["同一段", "另一段"]]);
    expect(report).toMatchObject({ embedded: 3, requests: 1 });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("空白块不发请求也不算失败", async () => {
    const embedder = stubEmbedder(echoVectors);

    const report = await embedChunks([{ text: "  \n " }, { text: "有内容" }, { text: "" }], {
      embedder,
    });

    expect(report).toMatchObject({ total: 3, blank: 2, embedded: 1 });
    expect(embedder.calls).toEqual([["有内容"]]);
  });

  it("限流退避后成功：重试到第三次，退避时长指数增长", async () => {
    const embedder = stubEmbedder((texts, call) =>
      call <= 2
        ? Promise.reject(new EmbedHttpError(429, "Too Many Requests", "POST /e", "限流"))
        : echoVectors(texts),
    );
    const waits: number[] = [];

    const report = await embedChunks(chunksOf(2), {
      embedder,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000 },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(report).toMatchObject({ embedded: 2, failed: 0, requests: 3 });
    expect(waits).toEqual([10, 20]);
  });

  it("重试用尽的批次记账后不中断其余批次", async () => {
    const embedder = stubEmbedder((texts) =>
      texts.includes("块2")
        ? Promise.reject(new EmbedHttpError(503, "", "POST /e", "网关抖动"))
        : echoVectors(texts),
    );

    const report = await embedChunks(chunksOf(6), {
      embedder,
      maxBatchSize: 2,
      concurrency: 1,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });

    expect(report).toMatchObject({ total: 6, embedded: 4, failed: 2 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ indexes: [2, 3], attempts: 2 });
    // 3 批 + 失败批的一次重试
    expect(report.requests).toBe(4);
  });

  it("致命错误（401）立即收工，不再取新批次", async () => {
    const embedder = stubEmbedder(() =>
      Promise.reject(new EmbedHttpError(401, "Unauthorized", "POST /e", "invalid api key")),
    );

    const report = await embedChunks(chunksOf(20), {
      embedder,
      maxBatchSize: 2,
      concurrency: 1,
      sleep: () => Promise.resolve(),
    });

    expect(report.fatal).toBeInstanceOf(EmbedHttpError);
    expect(report.requests).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.embedded).toBe(0);
  });

  it("并发不超过 concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const embedder = stubEmbedder(async (texts) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return texts.map(() => [1, 2]);
    });

    const report = await embedChunks(chunksOf(12), {
      embedder,
      maxBatchSize: 1,
      concurrency: 3,
    });

    expect(report.requests).toBe(12);
    expect(peak).toBe(3);
  });

  it("取消后停止取新批次，已交付结果保留", async () => {
    const controller = new AbortController();
    const embedder = stubEmbedder((texts, call) => {
      if (call === 2) {
        controller.abort();
      }
      return echoVectors(texts);
    });

    const report = await embedChunks(chunksOf(10), {
      embedder,
      maxBatchSize: 2,
      concurrency: 1,
      signal: controller.signal,
    });

    expect(report.aborted).toBe(true);
    expect(report.embedded).toBeGreaterThan(0);
    expect(report.embedded).toBeLessThan(10);
  });

  it("落库回调抛出即中止整轮并向上抛（不能让「已算」与「已存」错位）", async () => {
    const embedder = stubEmbedder(echoVectors);

    await expect(
      embedChunks(chunksOf(4), {
        embedder,
        maxBatchSize: 1,
        concurrency: 1,
        onEmbedded: (result) => {
          if (result.index === 2) {
            throw new Error("落库失败：磁盘已满");
          }
        },
      }),
    ).rejects.toThrow("落库失败：磁盘已满");
  });

  it("空输入与全部命中续传都是正常返回", async () => {
    const embedder = stubEmbedder(echoVectors);

    expect(await embedChunks([], { embedder })).toMatchObject({ total: 0, requests: 0 });
    expect(
      await embedChunks(chunksOf(3), { embedder, isEmbedded: () => Promise.resolve(true) }),
    ).toMatchObject({ total: 3, skipped: 3, requests: 0 });
    expect(embedder.calls).toHaveLength(0);
  });

  it("进度回调逐批推进到总数", async () => {
    const embedder = stubEmbedder(echoVectors);
    const progress: number[] = [];

    await embedChunks(chunksOf(6), {
      embedder,
      maxBatchSize: 2,
      concurrency: 1,
      onProgress: (snapshot) => progress.push(snapshot.done),
    });

    expect(progress).toEqual([2, 4, 6]);
  });
});
