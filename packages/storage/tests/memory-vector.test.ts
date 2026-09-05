/**
 * T8.7 记忆向量索引与混合检索单测。
 *
 * 覆盖：迁移 v3（含旧库升级无损）· 记忆向量表两后端（describe.each 同一套用例，
 * 与知识库同一纪律）· 嵌入状态记账与差额判定（断点续传 / 编辑后重嵌入同一段代码）·
 * 增删改钩子的向量同步 · 混合检索 RRF 融合（假向量驱动，零真机）· 纯 FTS 降级 ·
 * 与知识库向量表的共存独立性。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCategory, MemoryEntry, MemoryEntryId, MemoryStatus } from "@ff-pane/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeIndexDb,
  countMemoryEmbeddingState,
  deleteMemoryEntry,
  dropMemoryVectorIndex,
  ensureMemoryVectorIndex,
  ensureVectorIndex,
  findMemoryEntryRowid,
  INDEX_DB_MIGRATIONS,
  initProjectLayout,
  listMemoryRowsForEmbedding,
  loadVectorExtension,
  memoryEmbeddingText,
  memoryTextHash,
  openIndexDb,
  openMemoryVectorIndex,
  quoteFtsQueryLiteral,
  readMemoryVectorState,
  readUserVersion,
  rebuildIndex,
  reconcileIndexFromStore,
  resolveEntryFilePath,
  runMigrations,
  saveEntry,
  searchMemoryHybrid,
  searchMemoryIndex,
  storeMemoryVector,
  upsertMemoryEntry,
  type VectorIndex,
} from "../src/index.js";

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    closeIndexDb(db);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function track(db: Database.Database): Database.Database {
  openDbs.push(db);
  return db;
}

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ff-pane-mem-vec-"));
  tempDirs.push(dir);
  return join(dir, "index.sqlite");
}

let entrySeq = 0;

interface EntryOverrides {
  readonly id?: string;
  readonly category?: MemoryCategory;
  readonly status?: MemoryStatus;
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
}

function makeEntry(overrides: EntryOverrides = {}): MemoryEntry {
  entrySeq += 1;
  const base: MemoryEntry = {
    id: (overrides.id ?? `mem-${entrySeq}`) as MemoryEntryId,
    category: overrides.category ?? "decision",
    title: overrides.title ?? `条目标题 ${entrySeq}`,
    body: overrides.body ?? "缺省正文内容",
    status: overrides.status ?? "active",
    source: { kind: "user_manual" },
    confidence: "high",
    createdAt: 1_756_000_000_000,
    updatedAt: 1_756_000_000_000,
  };
  return overrides.tags === undefined ? base : { ...base, tags: overrides.tags };
}

const DIMS = 4;
const MODEL = "fake-embed";

/**
 * 确定性假嵌入：按语义分组把文本映射到固定向量——「跑测试」语义组与「部署」语义组
 * 各占一个正交方向。零字面重合的两句话落进同一方向，正是语义检索要证明的那件事。
 */
function fakeEmbed(text: string): number[] {
  if (text.includes("vitest") || text.includes("单测") || text.includes("跑测试")) {
    return [1, 0, 0, 0];
  }
  if (text.includes("部署") || text.includes("上线")) {
    return [0, 1, 0, 0];
  }
  return [0, 0, 1, 0];
}

/** 建库 + 建向量索引（fallback 后端：单测不依赖 sqlite-vec 加载）。 */
function openWithFallbackIndex(): { db: Database.Database; index: VectorIndex } {
  const db = track(openIndexDb({ filePath: ":memory:" }));
  const result = ensureMemoryVectorIndex(db, {
    dimensions: DIMS,
    model: MODEL,
    extensionLoaded: false,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return { db, index: result.index };
}

/** 灌一条到影子表并按差额流程嵌入（真实调用路径的最小重演）。 */
function seedEmbedded(db: Database.Database, index: VectorIndex, entry: MemoryEntry): void {
  upsertMemoryEntry(db, entry, index);
  for (const row of listMemoryRowsForEmbedding(db)) {
    storeMemoryVector(db, index, row.entryRowid, fakeEmbed(row.text), row.textHash);
  }
}

describe("迁移 v3", () => {
  it("新库打开即升到 v3，记忆向量状态表齐备", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    expect(readUserVersion(db)).toBe(3);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        readonly name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["memory_vector_state", "memory_embedding_state"]),
    );
  });

  it("旧库（v2）升级无损：既有记忆索引行原样保留，版本落 3", () => {
    const filePath = makeTempDbPath();
    // 造一个停在 v2 的旧库：只执行前两级迁移并写入一条记忆
    const legacy = new Database(filePath);
    runMigrations(legacy, INDEX_DB_MIGRATIONS.slice(0, 2));
    expect(readUserVersion(legacy)).toBe(2);
    upsertMemoryEntry(legacy, makeEntry({ id: "mem-legacy", body: "旧库升级保真验证正文" }));
    legacy.close();

    const upgraded = track(openIndexDb({ filePath }));
    expect(readUserVersion(upgraded)).toBe(3);
    const hits = searchMemoryIndex(upgraded, { match: quoteFtsQueryLiteral("升级保真") });
    expect(hits.map((hit) => hit.id)).toEqual(["mem-legacy"]);
    // 新表就位且为空
    expect(countMemoryEmbeddingState(upgraded)).toBe(0);
    expect(readMemoryVectorState(upgraded)).toBeUndefined();
  });
});

describe("嵌入文本与哈希", () => {
  it("拼接口径：title + body + tags，tags 为空省略该行", () => {
    expect(memoryEmbeddingText("标题", "正文", "标签甲 标签乙")).toBe("标题\n正文\n标签甲 标签乙");
    expect(memoryEmbeddingText("标题", "正文", "")).toBe("标题\n正文");
  });

  it("哈希对文本敏感且确定", () => {
    const first = memoryTextHash("同一段文本");
    expect(memoryTextHash("同一段文本")).toBe(first);
    expect(memoryTextHash("另一段文本")).not.toBe(first);
  });
});

/** 两后端同一套用例：退路的意义是「扩展没了功能还在」（T6.4 同一纪律）。 */
describe.each([
  ["fallback", false],
  ["vec0", true],
] as const)("记忆向量索引（%s 后端）", (_name, wantExtension) => {
  async function openBackend(): Promise<{ db: Database.Database; index: VectorIndex } | null> {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    if (wantExtension) {
      const loaded = await loadVectorExtension(db);
      if (!loaded.ok) {
        // 环境缺 sqlite-vec 时跳过 vec0 组（与 knowledge 侧同款处置）
        return null;
      }
    }
    const result = ensureMemoryVectorIndex(db, {
      dimensions: DIMS,
      model: MODEL,
      extensionLoaded: wantExtension,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return { db, index: result.index };
  }

  it("写入、KNN 检索、按候选预过滤、删除", async () => {
    const opened = await openBackend();
    if (opened === null) {
      return;
    }
    const { db, index } = opened;
    const a = makeEntry({ id: "mem-a", body: "执行 vitest 命令跑测试" });
    const b = makeEntry({ id: "mem-b", body: "部署脚本上线流程" });
    upsertMemoryEntry(db, a);
    upsertMemoryEntry(db, b);
    const rowidA = findMemoryEntryRowid(db, a.id);
    const rowidB = findMemoryEntryRowid(db, b.id);
    expect(rowidA).toBeDefined();
    expect(rowidB).toBeDefined();
    if (rowidA === undefined || rowidB === undefined) {
      return;
    }
    index.put(rowidA, [1, 0, 0, 0]);
    index.put(rowidB, [0, 1, 0, 0]);
    expect(index.count()).toBe(2);

    const near = index.search({ vector: [0.9, 0.1, 0, 0], limit: 1 });
    expect(near.map((n) => n.chunkRowid)).toEqual([rowidA]);

    // 候选预过滤：只允许 b，即便 a 更近也不该出现
    const filtered = index.search({ vector: [0.9, 0.1, 0, 0], limit: 2, candidates: [rowidB] });
    expect(filtered.map((n) => n.chunkRowid)).toEqual([rowidB]);

    index.deleteMany([rowidA]);
    expect(index.count()).toBe(1);
    expect(index.existingRowids([rowidA, rowidB])).toEqual(new Set([rowidB]));
  });

  it("openMemoryVectorIndex 按状态行还原；规格不符拒绝复用", async () => {
    const opened = await openBackend();
    if (opened === null) {
      return;
    }
    const { db } = opened;
    const reopened = openMemoryVectorIndex(db, wantExtension);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.index.backend).toBe(wantExtension ? "vec0" : "fallback");
      expect(reopened.index.dimensions).toBe(DIMS);
      expect(reopened.index.model).toBe(MODEL);
    }

    // 换模型：拒绝复用并提示重建
    const mismatch = ensureMemoryVectorIndex(db, {
      dimensions: DIMS,
      model: "another-model",
      extensionLoaded: wantExtension,
    });
    expect(mismatch.ok).toBe(false);

    // 换维度：同样拒绝
    const wrongDims = ensureMemoryVectorIndex(db, {
      dimensions: DIMS + 1,
      model: MODEL,
      extensionLoaded: wantExtension,
    });
    expect(wrongDims.ok).toBe(false);
  });
});

describe("嵌入状态记账与差额判定（断点续传语义）", () => {
  it("新条目进差额；storeMemoryVector 记账后不再出现", () => {
    const { db, index } = openWithFallbackIndex();
    upsertMemoryEntry(db, makeEntry({ id: "mem-p1", title: "跑测试", body: "执行 vitest 命令" }));
    upsertMemoryEntry(db, makeEntry({ id: "mem-p2", title: "部署", body: "上线流程" }));

    const pending = listMemoryRowsForEmbedding(db);
    expect(pending.map((row) => row.id).sort()).toEqual(["mem-p1", "mem-p2"]);
    // 嵌入文本走规范拼接
    expect(pending[0]?.text).toContain("跑测试");

    const [first] = pending;
    if (first === undefined) {
      throw new Error("差额为空");
    }
    storeMemoryVector(db, index, first.entryRowid, fakeEmbed(first.text), first.textHash);

    const rest = listMemoryRowsForEmbedding(db);
    expect(rest.map((row) => row.id)).toEqual(["mem-p2"]);
    expect(countMemoryEmbeddingState(db)).toBe(1);
    expect(index.count()).toBe(1);
  });

  it("崩溃语义守卫：put 抛错（维度不符）后记账零残留、条目留在差额（先向量后记账 + 同事务）", () => {
    const { db, index } = openWithFallbackIndex();
    upsertMemoryEntry(db, makeEntry({ id: "mem-guard", body: "崩溃语义守卫正文" }));
    const [row] = listMemoryRowsForEmbedding(db);
    if (row === undefined) {
      throw new Error("差额为空");
    }
    // 维度不符（3 维 vs 索引 4 维）令 put 抛 RangeError——此刻记账语句尚未执行，
    // 事务整体回滚后不得出现「记了账没向量」的假完成
    expect(() => storeMemoryVector(db, index, row.entryRowid, [1, 0, 0], row.textHash)).toThrow(
      RangeError,
    );
    expect(countMemoryEmbeddingState(db)).toBe(0);
    expect(index.count()).toBe(0);
    // 条目仍在差额里，下轮幂等重算
    expect(listMemoryRowsForEmbedding(db).map((pending) => pending.id)).toEqual(["mem-guard"]);
  });

  it("编辑条目正文 → 旧向量作废、重新进差额（哈希失配即重嵌入）", () => {
    const { db, index } = openWithFallbackIndex();
    const entry = makeEntry({ id: "mem-edit", body: "初版正文" });
    seedEmbedded(db, index, entry);
    expect(listMemoryRowsForEmbedding(db)).toEqual([]);
    expect(index.count()).toBe(1);

    upsertMemoryEntry(db, { ...entry, body: "改版正文语义已变" }, index);
    // 旧向量与记账行同事务出清
    expect(index.count()).toBe(0);
    expect(countMemoryEmbeddingState(db)).toBe(0);
    expect(listMemoryRowsForEmbedding(db).map((row) => row.id)).toEqual(["mem-edit"]);
  });

  it("仅状态流转（status 不进嵌入文本）不作废向量", () => {
    const { db, index } = openWithFallbackIndex();
    const entry = makeEntry({ id: "mem-status", status: "candidate", body: "状态流转不该重算" });
    seedEmbedded(db, index, entry);

    upsertMemoryEntry(db, { ...entry, status: "active" }, index);
    expect(index.count()).toBe(1);
    expect(listMemoryRowsForEmbedding(db)).toEqual([]);
  });

  it("删除条目连带删向量与记账行（幂等）", () => {
    const { db, index } = openWithFallbackIndex();
    const entry = makeEntry({ id: "mem-del", body: "待删除条目" });
    seedEmbedded(db, index, entry);
    expect(index.count()).toBe(1);

    deleteMemoryEntry(db, entry.id, index);
    expect(index.count()).toBe(0);
    expect(countMemoryEmbeddingState(db)).toBe(0);
    expect(() => deleteMemoryEntry(db, entry.id, index)).not.toThrow();
  });

  it("rebuildIndex 清空向量（rowid 换新，旧向量失去属主）", () => {
    const { db, index } = openWithFallbackIndex();
    seedEmbedded(db, index, makeEntry({ id: "mem-rb", body: "重建前的条目" }));
    expect(index.count()).toBe(1);

    rebuildIndex(db, [makeEntry({ id: "mem-rb", body: "重建后的条目" })], index);
    expect(index.count()).toBe(0);
    // CASCADE 出清记账行 → 全部条目重新进差额
    expect(countMemoryEmbeddingState(db)).toBe(0);
    expect(listMemoryRowsForEmbedding(db).map((row) => row.id)).toEqual(["mem-rb"]);
  });

  it("dropMemoryVectorIndex 清掉向量表、状态行与记账行", () => {
    const { db, index } = openWithFallbackIndex();
    seedEmbedded(db, index, makeEntry({ id: "mem-drop", body: "即将被丢弃" }));

    dropMemoryVectorIndex(db);
    expect(readMemoryVectorState(db)).toBeUndefined();
    expect(countMemoryEmbeddingState(db)).toBe(0);
    const reopened = openMemoryVectorIndex(db, false);
    expect(reopened.ok).toBe(false);
  });
});

describe("混合检索 searchMemoryHybrid（假向量驱动）", () => {
  /** 语料：mem-t 是语义目标（与查询零字面重合），mem-d 是干扰项。 */
  function seedCorpus(db: Database.Database, index: VectorIndex): void {
    seedEmbedded(
      db,
      index,
      makeEntry({
        id: "mem-t",
        category: "lesson",
        title: "执行 vitest 命令",
        body: "本仓一律 pnpm exec vitest run",
      }),
    );
    seedEmbedded(
      db,
      index,
      makeEntry({
        id: "mem-d",
        category: "rule",
        title: "部署流程",
        body: "上线前逐项核对部署清单",
      }),
    );
  }

  it("语义召回：零字面重合的查询靠向量路命中（纯 FTS 恒零命中的对照）", () => {
    const { db, index } = openWithFallbackIndex();
    seedCorpus(db, index);
    const query = "怎么跑单测";

    // 对照组：不带向量 → 关键词路零命中
    const ftsOnly = searchMemoryHybrid(db, { query });
    expect(ftsOnly.usedVector).toBe(false);
    expect(ftsOnly.hits).toEqual([]);

    // 实验组：同一查询带上查询向量 → 语义命中排第一
    // （KNN 无距离阈值，语义无关的 mem-d 仍会占据后位名次——这是 KNN 的正常语义，
    //  断言排序而不是排他）
    const hybrid = searchMemoryHybrid(db, {
      query,
      queryVector: fakeEmbed(query),
      vectorIndex: index,
    });
    expect(hybrid.usedVector).toBe(true);
    expect(hybrid.hits[0]?.id).toBe("mem-t");
    expect(hybrid.hits[0]?.sources).toEqual(["vector"]);
    expect(hybrid.hits[0]?.ranks["vector"]).toBe(1);
  });

  it("双路命中融合靠前：关键词与语义一致的条目压过单路命中", () => {
    const { db, index } = openWithFallbackIndex();
    seedCorpus(db, index);
    // 再放一条只有关键词命中的条目（语义在另一方向）
    seedEmbedded(
      db,
      index,
      makeEntry({ id: "mem-k", title: "vitest 配置备忘", body: "上线部署时跳过 vitest 阶段" }),
    );

    const result = searchMemoryHybrid(db, {
      query: "vitest 命令",
      queryVector: [1, 0, 0, 0],
      vectorIndex: index,
    });
    const [top] = result.hits;
    expect(top?.id).toBe("mem-t");
    expect(top?.sources).toEqual(expect.arrayContaining(["fts", "vector"]));
  });

  it("过滤下推到向量路：category 过滤把语义最近的条目排除在召回之外", () => {
    const { db, index } = openWithFallbackIndex();
    seedCorpus(db, index);

    const result = searchMemoryHybrid(db, {
      query: "怎么跑单测",
      queryVector: [1, 0, 0, 0],
      vectorIndex: index,
      categories: ["rule"],
    });
    // mem-t（语义第 1 名）是 lesson，被预过滤排除——它绝不能出现；
    // rule 类的 mem-d 作为过滤后的 KNN 近邻照常返回（KNN 无距离阈值）
    expect(result.hits.map((hit) => hit.id)).not.toContain("mem-t");
    expect(result.hits.every((hit) => hit.category === "rule")).toBe(true);
  });

  it("短查询（<3 码点）回退 LIKE 路，融合照常，usedFts 如实为 false", () => {
    const { db, index } = openWithFallbackIndex();
    seedCorpus(db, index);

    const result = searchMemoryHybrid(db, {
      query: "部署",
      queryVector: [0, 1, 0, 0],
      vectorIndex: index,
    });
    expect(result.usedFts).toBe(false);
    expect(result.usedVector).toBe(true);
    expect(result.hits[0]?.id).toBe("mem-d");
    expect(result.hits[0]?.sources).toEqual(expect.arrayContaining(["like-fallback", "vector"]));
  });

  it("未配嵌入来源：向量路整条缺席，结果即关键词顺序（纯 FTS 一等状态）", () => {
    const { db } = openWithFallbackIndex();
    upsertMemoryEntry(db, makeEntry({ id: "mem-f", body: "包含 vitest 关键词的正文" }));

    const result = searchMemoryHybrid(db, { query: "vitest" });
    expect(result.usedVector).toBe(false);
    expect(result.hits.map((hit) => hit.id)).toEqual(["mem-f"]);
    expect(result.hits[0]?.sources).toEqual(["fts"]);
  });

  it("空白查询与 limit=0 返回空结果不抛错", () => {
    const { db, index } = openWithFallbackIndex();
    seedCorpus(db, index);
    expect(searchMemoryHybrid(db, { query: "  " })).toEqual({
      hits: [],
      usedFts: false,
      usedVector: false,
    });
    expect(
      searchMemoryHybrid(db, {
        query: "vitest",
        limit: 0,
        queryVector: [1, 0, 0, 0],
        vectorIndex: index,
      }).hits,
    ).toEqual([]);
  });

  it("limit 生效且融合池取超额召回（深位语义命中被救回）", () => {
    const { db, index } = openWithFallbackIndex();
    // 灌 4 条部署语义 + 1 条测试语义；关键词都命中「流程」。
    // mem-vt 在关键词路排第 5（超出 limit=3）、向量路排第 1——
    // 若每路只取 limit 条，它进不了融合池；超额召回（×4）把它救回前三。
    for (let i = 0; i < 4; i += 1) {
      seedEmbedded(
        db,
        index,
        makeEntry({ id: `mem-dep-${i}`, title: `部署流程 ${i}`, body: `上线流程第 ${i} 步` }),
      );
    }
    seedEmbedded(
      db,
      index,
      makeEntry({ id: "mem-vt", title: "测试流程", body: "跑测试用 vitest 命令" }),
    );

    const result = searchMemoryHybrid(db, {
      query: "流程",
      queryVector: [1, 0, 0, 0],
      vectorIndex: index,
      limit: 3,
    });
    expect(result.hits).toHaveLength(3);
    expect(result.hits.map((hit) => hit.id)).toContain("mem-vt");
  });
});

describe("reconcileIndexFromStore（对账：rowid 稳定、向量只作废真变了的）", () => {
  it("新增入索引、消失出清、内容未变的条目向量原样保留、变了的作废", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-pane-mem-reconcile-"));
    tempDirs.push(dir);
    const layout = await initProjectLayout(join(dir, "对账项目"));
    const { db, index } = openWithFallbackIndex();

    const keep = makeEntry({ id: "mem-keep", body: "保持不变的正文" });
    const edit = makeEntry({ id: "mem-edit2", body: "对账前的正文" });
    const gone = makeEntry({ id: "mem-gone", body: "即将从真实源消失" });
    for (const entry of [keep, edit, gone]) {
      await saveEntry(layout, entry);
      seedEmbedded(db, index, entry);
    }
    expect(index.count()).toBe(3);
    const keepRowid = findMemoryEntryRowid(db, keep.id);

    // 真实源演化：edit 改正文、gone 删除、fresh 新增
    const edited = { ...edit, body: "对账后的新正文" };
    await saveEntry(layout, edited);
    await rm(resolveEntryFilePath(layout, gone));
    const fresh = makeEntry({ id: "mem-fresh", body: "对账新增的条目" });
    await saveEntry(layout, fresh);

    const result = await reconcileIndexFromStore(layout, db, index);
    expect(result.indexed).toBe(3);
    expect(result.issues).toEqual([]);

    // keep：rowid 稳定、向量保留
    expect(findMemoryEntryRowid(db, keep.id)).toBe(keepRowid);
    if (keepRowid !== undefined) {
      expect(index.existingRowids([keepRowid]).has(keepRowid)).toBe(true);
    }
    // edit：向量作废，进差额等待回填
    const pending = listMemoryRowsForEmbedding(db).map((row) => row.id);
    expect(pending.sort()).toEqual(["mem-edit2", "mem-fresh"]);
    // gone：索引行与向量出清
    expect(findMemoryEntryRowid(db, gone.id)).toBeUndefined();
    expect(index.count()).toBe(1);
    // 检索面照常
    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("对账新增") });
    expect(hits.map((hit) => hit.id)).toEqual(["mem-fresh"]);
  });
});

describe("与知识库向量表共存", () => {
  it("同一连接上两套向量索引互不干扰", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    const memory = ensureMemoryVectorIndex(db, {
      dimensions: 4,
      model: "mem-model",
      extensionLoaded: false,
    });
    const knowledge = ensureVectorIndex(db, {
      dimensions: 8,
      model: "kb-model",
      extensionLoaded: false,
    });
    expect(memory.ok).toBe(true);
    expect(knowledge.ok).toBe(true);
    if (!memory.ok || !knowledge.ok) {
      return;
    }
    // 各自的规格独立登记（维度/模型都不同也互不触发规格守卫）
    expect(readMemoryVectorState(db)?.model).toBe("mem-model");
    expect(memory.index.dimensions).toBe(4);
    expect(knowledge.index.dimensions).toBe(8);

    // 记忆侧 drop 不影响知识库侧
    dropMemoryVectorIndex(db);
    expect(readMemoryVectorState(db)).toBeUndefined();
    expect(knowledge.index.count()).toBe(0);
    expect(() => knowledge.index.put(1, new Array(8).fill(0.5))).toThrow();
    // （knowledge_chunk 里没有 rowid=1 的块，外键拒绝——恰好证明表还在、约束还在）
  });
});
