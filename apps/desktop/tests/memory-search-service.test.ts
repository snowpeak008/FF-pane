/**
 * T8.7 记忆语义检索服务单测（createMemoryIndexService）。
 *
 * 嵌入端点用 node:http mock（openai 方言，沿用 rag embed.test 的做法——打桩 fetch
 * 测不出 URL 拼错），向量语义由「按语义分组的确定性假向量」承载：零字面重合的查询
 * 与目标条目落进同一方向，语义召回是否成立就能在断言里说清。
 *
 * 覆盖：存量批量回填 + 语义召回（关键词零命中的对照组）· 断点续传（第二次检索
 * 零新请求）· 编辑后重嵌入 · 删除钩子 · 未配嵌入来源纯 FTS 降级（blocker 码）·
 * 嵌入端点故障时退化不抛 · 首次打开对账捡起未接钩子时期的存量。
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryEntryId, ModelId, Provider, ProviderId } from "@ff-pane/shared";
import { initProjectLayout, type ProjectLayout, saveEntry } from "@ff-pane/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryIndexService, type MemoryIndexService } from "../src/main/memory-index";

const MODEL = "fake-bge" as ModelId;

/** 与 rag embed.test 同源的 fetch 坏端口名单（动态端口范围内的那部分）。 */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

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
  throw new Error("连续 64 次 listen(0) 都落在 fetch 坏端口上");
}

/** 确定性假嵌入：语义分组 → 固定方向（与 storage 侧单测同一手法）。 */
function fakeEmbed(text: string): number[] {
  if (text.includes("vitest") || text.includes("单测") || text.includes("跑测试")) {
    return [1, 0, 0, 0];
  }
  if (text.includes("部署") || text.includes("上线")) {
    return [0, 1, 0, 0];
  }
  return [0, 0, 1, 0];
}

interface MockEmbedServer {
  readonly origin: string;
  /** 服务端收到的全部 input 文本（按请求顺序拼接）。 */
  readonly embedded: string[];
  close(): Promise<void>;
}

/** openai 方言的假嵌入端点。 */
async function startEmbedServer(): Promise<MockEmbedServer> {
  const embedded: string[] = [];
  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      embedded.push(...body.input);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: body.input.map((text, index) => ({ index, embedding: fakeEmbed(text) })),
        }),
      );
    });
  });
  const port = await listenOnFetchablePort(server);
  const mock: MockEmbedServer = {
    origin: `http://127.0.0.1:${port}`,
    embedded,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  openServers.push(mock);
  return mock;
}

function makeProvider(baseUrl: string): Provider {
  return {
    id: "prov-embed" as ProviderId,
    name: "Fake Embeddings",
    type: "openai_compatible",
    baseUrl: `${baseUrl}/v1`,
    models: [],
    embeddingModel: MODEL,
    enabled: true,
  };
}

let entrySeq = 0;

function makeEntry(
  overrides: Partial<Omit<MemoryEntry, "id">> & { readonly id?: string },
): MemoryEntry {
  entrySeq += 1;
  const { id, ...rest } = overrides;
  return {
    id: (id ?? `mem-${entrySeq}`) as MemoryEntryId,
    category: "lesson",
    title: `条目 ${entrySeq}`,
    body: "缺省正文",
    status: "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1_756_000_000_000,
    updatedAt: 1_756_000_000_000,
    ...rest,
  } as MemoryEntry;
}

const openServers: MockEmbedServer[] = [];
const openServices: MemoryIndexService[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const service of openServices.splice(0)) {
    service.close();
  }
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  // Windows 下 close() 的连接释放是异步的，稍等再删临时目录
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

interface TestRig {
  readonly layout: ProjectLayout;
  readonly projectRoot: string;
  readonly service: MemoryIndexService;
}

async function makeRig(providers: readonly Provider[]): Promise<TestRig> {
  const root = await mkdtemp(join(tmpdir(), "ff-pane-mem-svc-"));
  tempRoots.push(root);
  const projectRoot = join(root, "语义检索·项目");
  const layout = await initProjectLayout(projectRoot);
  const service = createMemoryIndexService({
    listProviders: () => Promise.resolve(providers),
    revealSecret: () => Promise.resolve(undefined),
  });
  openServices.push(service);
  return { layout, projectRoot, service };
}

/** 语料：目标条目与查询「怎么跑单测」零字面重合、语义同组；干扰条目在另一语义组。 */
async function seedCorpus(layout: ProjectLayout): Promise<void> {
  await saveEntry(
    layout,
    makeEntry({ id: "mem-t", title: "执行 vitest 命令", body: "本仓一律 pnpm exec vitest run" }),
  );
  await saveEntry(
    layout,
    makeEntry({ id: "mem-d", title: "部署流程", body: "上线前逐项核对部署清单", category: "rule" }),
  );
}

describe("memory:search 服务（真 HTTP mock 嵌入端点）", () => {
  it("语义召回端到端：零字面重合的查询靠向量路命中；存量条目被批量回填", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);

    const result = await rig.service.search({
      projectRoot: rig.projectRoot,
      query: "怎么跑单测",
    });

    expect(result.usedVector).toBe(true);
    expect(result.usedFts).toBe(true);
    // 语义目标排第一，命中来自向量路
    expect(result.hits[0]?.id).toBe("mem-t");
    expect(result.hits[0]?.sources).toContain("vector");
    // 存量回填真的发生了：2 条条目 + 1 条查询都经过嵌入端点
    expect(mock.embedded.filter((text) => text.includes("vitest"))).toHaveLength(1);
    expect(mock.embedded).toContain("怎么跑单测");
  });

  it("断点续传：第二次检索不再重嵌已入库的条目（只有查询本身发请求）", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);

    await rig.service.search({ projectRoot: rig.projectRoot, query: "怎么跑单测" });
    const afterFirst = mock.embedded.length;
    await rig.service.search({ projectRoot: rig.projectRoot, query: "上线要注意什么" });
    // 第二轮只多一条查询文本，条目零重算
    expect(mock.embedded.length).toBe(afterFirst + 1);
    expect(mock.embedded.slice(afterFirst)).toEqual(["上线要注意什么"]);
  });

  it("entrySaved 钩子：编辑条目后旧向量作废、下轮检索只重嵌那一条", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);
    await rig.service.search({ projectRoot: rig.projectRoot, query: "怎么跑单测" });
    const afterFirst = mock.embedded.length;

    const edited = makeEntry({
      id: "mem-t",
      title: "执行 vitest 命令",
      body: "改为 vitest watch 模式",
    });
    await saveEntry(rig.layout, edited);
    await rig.service.entrySaved(rig.projectRoot, edited);

    await rig.service.search({ projectRoot: rig.projectRoot, query: "怎么跑单测" });
    const delta = mock.embedded.slice(afterFirst);
    // 恰好重嵌 mem-t 一条 + 一条查询；mem-d 不动
    expect(delta.filter((text) => text.includes("vitest watch"))).toHaveLength(1);
    expect(delta.some((text) => text.includes("部署"))).toBe(false);
  });

  it("entryDeleted 钩子：删除后既不再命中、也不再被回填", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);
    await rig.service.search({ projectRoot: rig.projectRoot, query: "怎么跑单测" });

    await rm(join(rig.layout.memoryCategoryDirs.lesson, "mem-t.md"));
    await rig.service.entryDeleted(rig.projectRoot, "mem-t" as MemoryEntryId);

    const afterDelete = mock.embedded.length;
    const result = await rig.service.search({ projectRoot: rig.projectRoot, query: "怎么跑单测" });
    expect(result.hits.map((hit) => hit.id)).not.toContain("mem-t");
    // 删除的条目不进回填差额
    expect(mock.embedded.length).toBe(afterDelete + 1);
  });

  it("未配嵌入来源：纯关键词检索照常可用，blocker 如实为 no-provider", async () => {
    const rig = await makeRig([]);
    await seedCorpus(rig.layout);

    const keyword = await rig.service.search({ projectRoot: rig.projectRoot, query: "vitest" });
    expect(keyword.usedVector).toBe(false);
    expect(keyword.embeddingBlocker).toBe("no-provider");
    expect(keyword.hits.map((hit) => hit.id)).toEqual(["mem-t"]);
    expect(keyword.hits[0]?.sources).toEqual(["fts"]);

    // 对照组：语义查询在纯 FTS 下零命中——这正是向量路要补的那块
    const semantic = await rig.service.search({
      projectRoot: rig.projectRoot,
      query: "怎么跑单测",
    });
    expect(semantic.hits).toEqual([]);
  });

  it("嵌入端点故障：检索退化为纯关键词、不抛错，端点恢复后下轮补齐", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);
    // 先把端点关掉再首查：回填与查询嵌入都会失败
    await mock.close();
    openServers.splice(openServers.indexOf(mock), 1);

    const degraded = await rig.service.search({ projectRoot: rig.projectRoot, query: "vitest" });
    expect(degraded.usedVector).toBe(false);
    expect(degraded.hits.map((hit) => hit.id)).toEqual(["mem-t"]);
  });

  it("过滤与 limit 透传：category 过滤在两路都生效", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);

    const result = await rig.service.search({
      projectRoot: rig.projectRoot,
      query: "怎么跑单测",
      categories: ["rule"],
    });
    // mem-t（语义第 1 名）是 lesson，被预过滤排除
    expect(result.hits.map((hit) => hit.id)).not.toContain("mem-t");
    expect(result.hits.every((hit) => hit.category === "rule")).toBe(true);
  });

  it("空白查询返回空结果不触网", async () => {
    const mock = await startEmbedServer();
    const rig = await makeRig([makeProvider(mock.origin)]);
    await seedCorpus(rig.layout);
    const result = await rig.service.search({ projectRoot: rig.projectRoot, query: "   " });
    expect(result).toEqual({ hits: [], usedFts: false, usedVector: false });
    expect(mock.embedded).toEqual([]);
  });
});
