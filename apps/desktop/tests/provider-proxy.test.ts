/**
 * Provider.proxy 消费的单测（v0.8.x 清债二单）。
 *
 * 做法沿用 W1.5c：起本地 mock 服务真实走网络栈，不打桩 fetch——本单要验证的恰恰是
 * "请求真的从代理出去"这件事，桩掉 fetch 就把被测对象一起桩掉了。全部流量止于
 * 127.0.0.1，零外网请求。
 *
 * mock 代理两种形态都实现：undici 的 ProxyAgent 对 http/https 目标统一走 CONNECT
 * 隧道，绝对形式（`GET http://host/path`）是 HTTP 代理的另一种合法形态——两条都记账，
 * 断言只看"代理有没有见到这次请求"，不把实现细节写死进断言。
 */

import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect as netConnect, type Socket } from "node:net";
import type { ConnectionTestResult, FetchModelsResult } from "@ff-pane/core";
import { fetchModels, testConnection } from "@ff-pane/core";
import { afterEach, describe, expect, it } from "vitest";
import { redactProxyCredentials, resolveProbeOutlet } from "../src/main/provider-proxy";

/** 特征明显的假 key：断言它照旧到达目标服务端（代理不该动 Authorization）。 */
const API_KEY = "sk-ffpane-proxy-test-1a2b3c4d";

/**
 * WHATWG fetch 坏端口黑名单 ∩ 动态端口范围（清债一单根治的那 19 个，
 * 详见 packages/core/tests/provider-probe.test.ts 的长注释）。抽中即 `fetch failed
 * ← bad port`，换绑一个即可确定性绕开。
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

interface RecordedRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

interface MockOrigin {
  readonly origin: string;
  readonly authority: string;
  readonly requests: readonly RecordedRequest[];
}

interface MockProxy {
  readonly url: string;
  /** 代理见到的每一次转发：CONNECT 的 `host:port` 或绝对形式的完整 URL。 */
  readonly seen: readonly string[];
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** 目标服务：记录收到的请求，一律回 200 + 模型列表。 */
async function startMockOrigin(): Promise<MockOrigin> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res: ServerResponse) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "probe-model" }] }));
  });
  const port = await listenOnFetchablePort(server);
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    authority: `127.0.0.1:${port}`,
    requests,
  };
}

/** 最小 HTTP 代理：CONNECT 隧道 + 绝对形式转发，两种都记账。 */
async function startMockProxy(): Promise<MockProxy> {
  const seen: string[] = [];
  const sockets: Socket[] = [];

  const server = createServer((req, res) => {
    const target = req.url ?? "";
    seen.push(target);
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const upstream = httpRequest(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: req.method ?? "GET",
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    const authority = req.url ?? "";
    seen.push(authority);
    const [host = "", port = ""] = authority.split(":");
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.push(clientSocket, upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  const port = await listenOnFetchablePort(server);
  closers.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return { url: `http://127.0.0.1:${port}`, seen };
}

/** 解析出口 → 跑一次探测 → 关掉出口（dispose 是调用方的义务，见 data.ts 的 finally）。 */
async function probeThrough(
  proxy: string | undefined,
  baseUrl: string,
  probe: "test-connection" | "fetch-models" = "test-connection",
): Promise<ConnectionTestResult | FetchModelsResult> {
  const outlet = resolveProbeOutlet(proxy);
  if (!outlet.ok) {
    return outlet.failure;
  }
  const params = {
    provider: { type: "openai_compatible" as const, baseUrl, timeoutS: 5 },
    apiKey: API_KEY,
    ...(outlet.fetchImpl !== undefined ? { fetchImpl: outlet.fetchImpl } : {}),
  };
  try {
    return probe === "test-connection" ? await testConnection(params) : await fetchModels(params);
  } finally {
    await outlet.dispose?.();
  }
}

describe("resolveProbeOutlet · 出口解析", () => {
  it("未配 / 空串 / 全空白一律视为直连：无 fetchImpl、无需 dispose", () => {
    for (const value of [undefined, "", "   "]) {
      const outlet = resolveProbeOutlet(value);
      expect(outlet.ok).toBe(true);
      if (outlet.ok) {
        expect(outlet.fetchImpl).toBeUndefined();
        expect(outlet.dispose).toBeUndefined();
      }
    }
  });

  it("合法代理给出 fetchImpl 与 dispose（连接不会随每次探测累积）", async () => {
    const outlet = resolveProbeOutlet("http://127.0.0.1:7890");
    expect(outlet.ok).toBe(true);
    if (!outlet.ok) {
      return;
    }
    expect(outlet.fetchImpl).toBeTypeOf("function");
    expect(outlet.dispose).toBeTypeOf("function");
    await outlet.dispose?.();
  });

  it("非法 URL（含漏写 scheme 的常见笔误）→ invalid-config，文案给出格式示例", () => {
    for (const value of ["这不是一个 URL", "127.0.0.1:7890"]) {
      const outlet = resolveProbeOutlet(value);
      expect(outlet.ok).toBe(false);
      if (outlet.ok) {
        return;
      }
      expect(outlet.failure.stage).toBe("invalid-config");
      expect(outlet.failure.rawError).toContain("http://127.0.0.1:7890");
    }
  });

  it("非 http/https 协议（socks5）→ invalid-config 并说明暂不支持", () => {
    const outlet = resolveProbeOutlet("socks5://127.0.0.1:1080");
    expect(outlet.ok).toBe(false);
    if (outlet.ok) {
      return;
    }
    expect(outlet.failure.stage).toBe("invalid-config");
    expect(outlet.failure.rawError).toContain("http/https");
    expect(outlet.failure.rawError).toContain("socks");
  });

  it("错误文案抹掉代理 URL 里的凭据段", () => {
    const outlet = resolveProbeOutlet("http://alice:sup3r-secret@");
    expect(outlet.ok).toBe(false);
    if (outlet.ok) {
      return;
    }
    expect(outlet.failure.rawError).not.toContain("sup3r-secret");
    expect(outlet.failure.rawError).toContain("//***@");
  });

  it("redactProxyCredentials 只吃凭据段，不动其余部分", () => {
    expect(redactProxyCredentials("http://u:p@127.0.0.1:7890")).toBe("http://***@127.0.0.1:7890");
    expect(redactProxyCredentials("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });
});

describe("探测流量的实际出口", () => {
  it("配了 proxy：连接测试经代理发出，Authorization 头照旧到达目标", async () => {
    const target = await startMockOrigin();
    const proxy = await startMockProxy();

    const result = await probeThrough(proxy.url, `${target.origin}/v1`);

    expect(result.ok).toBe(true);
    expect(proxy.seen.some((entry) => entry.includes(target.authority))).toBe(true);
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]?.url).toBe("/v1/models");
    expect(target.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("没配 proxy：直连目标，代理零记录", async () => {
    const target = await startMockOrigin();
    const proxy = await startMockProxy();

    const result = await probeThrough(undefined, `${target.origin}/v1`);

    expect(result.ok).toBe(true);
    expect(proxy.seen).toEqual([]);
    expect(target.requests).toHaveLength(1);
  });

  it("拉取模型同样经代理（本单接的是探测与 /models 两条路）", async () => {
    const target = await startMockOrigin();
    const proxy = await startMockProxy();

    const result = await probeThrough(proxy.url, `${target.origin}/v1`, "fetch-models");

    expect(result.ok).toBe(true);
    if (result.ok && "models" in result) {
      expect(result.models.map((model) => model.id)).toEqual(["probe-model"]);
    }
    expect(proxy.seen.some((entry) => entry.includes(target.authority))).toBe(true);
  });

  it("代理地址非法时一次请求都不发出去", async () => {
    const target = await startMockOrigin();

    const result = await probeThrough("http://", `${target.origin}/v1`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("invalid-config");
    }
    expect(target.requests).toEqual([]);
  });
});
