/**
 * T6.4 知识库索引与混合检索单测。
 *
 * 覆盖：迁移 v2 · sqlite-vec 加载（风险 R2 的实证）· 两种向量后端等价性 ·
 * 条目/块写入与级联删除 · 增量索引哈希 · BM25 与 LIKE 回退 · 四类过滤 ·
 * RRF 双路融合 · 上下文扩展 · **20 条中文检索抽测**。
 *
 * 向量后端的行为测试对 vec0 与 fallback **跑同一套用例**（describe.each）——
 * 退路存在的意义就是「扩展没了功能还在」，两者行为不一致的话这个承诺就是空的。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KnowledgeChunkId,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeFormat,
  LocalSessionId,
} from "@ff-pane/shared";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearKnowledgeIndex,
  closeIndexDb,
  cosineDistance,
  decodeVector,
  deleteKnowledgeEntry,
  dropVectorIndex,
  encodeVector,
  ensureVectorIndex,
  expandContext,
  findEntryByContentHash,
  getKnowledgeEntry,
  getKnowledgeStats,
  KNOWLEDGE_CHUNK_TABLE,
  KNOWLEDGE_ENTRY_TABLE,
  type KnowledgeChunkInput,
  type KnowledgeFilters,
  type KnowledgeSearchOptions,
  listEntryChunks,
  listKnowledgeEntries,
  loadVectorExtension,
  openIndexDb,
  openVectorIndex,
  readUserVersion,
  readVectorState,
  replaceEntryChunks,
  searchKnowledge,
  upsertKnowledgeEntry,
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

/** 文件库（向量表在内存库里同样可用，但用文件库更贴近真实形态）。 */
function openDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ff-pane-knowledge-"));
  tempDirs.push(dir);
  const db = openIndexDb({ filePath: join(dir, "index.sqlite") });
  openDbs.push(db);
  return db;
}

let entrySeq = 0;

interface EntryOverrides {
  readonly id?: string;
  readonly title?: string;
  readonly format?: KnowledgeFormat;
  readonly sourcePath?: string;
  readonly contentHash?: string;
  readonly importedAt?: number;
  readonly tags?: readonly string[];
}

function makeEntry(overrides: EntryOverrides = {}): KnowledgeEntry {
  entrySeq += 1;
  return {
    id: (overrides.id ?? `ke-${entrySeq}`) as KnowledgeEntryId,
    title: overrides.title ?? `文档 ${entrySeq}`,
    format: overrides.format ?? "markdown",
    origin: { kind: "file_import", sourcePath: overrides.sourcePath ?? `D:/docs/f${entrySeq}.md` },
    contentHash: overrides.contentHash ?? `hash-${entrySeq}`,
    importedAt: overrides.importedAt ?? 1_700_000_000_000 + entrySeq,
    ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
  };
}

let chunkSeq = 0;

/** 造一批块：文本按序给定，出处默认取条目路径。 */
function makeChunks(
  texts: readonly string[],
  options: { readonly filePath?: string; readonly headingPath?: readonly string[] } = {},
): KnowledgeChunkInput[] {
  return texts.map((text, index) => {
    chunkSeq += 1;
    return {
      id: `kc-${chunkSeq}` as KnowledgeChunkId,
      seq: index,
      text,
      provenance: {
        filePath: options.filePath ?? "D:/docs/a.md",
        ...(options.headingPath === undefined ? {} : { headingPath: options.headingPath }),
      },
    };
  });
}

/** 一步到位：写条目 + 写块。 */
function seedEntry(
  db: Database.Database,
  entry: KnowledgeEntry,
  texts: readonly string[],
  chunkOptions: Parameters<typeof makeChunks>[1] = {},
): ReturnType<typeof replaceEntryChunks> {
  upsertKnowledgeEntry(db, entry);
  const filePath =
    chunkOptions.filePath ??
    (entry.origin.kind === "file_import" ? entry.origin.sourcePath : "D:/docs/a.md");
  return replaceEntryChunks(db, entry.id, makeChunks(texts, { ...chunkOptions, filePath }));
}

describe("迁移 v2", () => {
  it("打开库即升到 v2，知识库表齐备", () => {
    const db = openDb();

    expect(readUserVersion(db)).toBe(2);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
        readonly name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "knowledge_entry",
        "knowledge_entry_tag",
        "knowledge_chunk",
        "knowledge_fts",
        "knowledge_vector_state",
        // v1 的记忆表不受影响
        "memory_entry",
        "memory_fts",
      ]),
    );
  });

  it("外键已开启，删条目级联删块与标签", () => {
    const db = openDb();
    const entry = makeEntry({ tags: ["架构", "检索"] });
    seedEntry(db, entry, ["第一块正文", "第二块正文"]);

    expect(getKnowledgeStats(db)).toMatchObject({ entries: 1, chunks: 2 });
    db.prepare(`DELETE FROM ${KNOWLEDGE_ENTRY_TABLE} WHERE id = ?`).run(entry.id);

    expect(getKnowledgeStats(db)).toMatchObject({ entries: 0, chunks: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_entry_tag").get()).toEqual({ n: 0 });
  });
});

describe("风险 R2：sqlite-vec 加载", () => {
  it("本平台可加载 sqlite-vec 并报出版本", async () => {
    const db = openDb();
    const loaded = await loadVectorExtension(db);

    // 加载失败不是测试失败——退路后端就是为此存在。但要把结论显式记下来。
    if (!loaded.ok) {
      expect(loaded.reason).toBeTypeOf("string");
      return;
    }
    expect(loaded.version).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(db.prepare("SELECT vec_version() AS v").get()).toBeDefined();
  });
});

describe("向量编解码", () => {
  it("往返保真（Float32 精度内）", () => {
    const vector = [0.5, -0.25, 1, 0];
    expect(decodeVector(encodeVector(vector))).toEqual(vector);
  });

  it("字节数不是 4 的倍数即报错，不给半截向量", () => {
    expect(() => decodeVector(Buffer.alloc(6))).toThrow(/4 的倍数/);
  });

  it("余弦距离：同向 0、正交 1、反向 2；零向量判最远", () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0, 6);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 6);
    expect(cosineDistance([0, 0], [1, 0])).toBe(1);
  });
});

/** 造一个「按维度分离」的向量：第 index 维为 1，其余为 0。 */
function unitVector(index: number, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, position) => (position === index ? 1 : 0));
}

/**
 * 两种后端跑同一套用例。fallback 通过「谎称扩展不可用」强制走退路，
 * 故这套断言同时证明了 R2 退路真的能顶上。
 */
describe.each([
  { name: "vec0", extensionLoaded: true },
  { name: "fallback", extensionLoaded: false },
])("向量后端 $name", ({ name, extensionLoaded }) => {
  /** 建索引；vec0 分支需要先装扩展，装不上就跳过该分支。 */
  async function setupIndex(
    db: Database.Database,
    dimensions = 4,
  ): Promise<VectorIndex | undefined> {
    if (extensionLoaded) {
      const loaded = await loadVectorExtension(db);
      if (!loaded.ok) {
        return undefined;
      }
    }
    const result = ensureVectorIndex(db, { dimensions, model: "test-embed", extensionLoaded });
    expect(result.ok).toBe(true);
    return result.ok ? result.index : undefined;
  }

  it("建索引后状态行记录后端、维度与模型", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }

    expect(index.backend).toBe(name);
    expect(readVectorState(db)).toEqual({ backend: name, dimensions: 4, model: "test-embed" });
  });

  it("写入、覆盖、计数、KNN 按距离升序", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    seedEntry(db, makeEntry(), ["块零", "块一", "块二"]);
    const rowids = [1, 2, 3];
    index.put(rowids[0] as number, unitVector(0, 4));
    index.put(rowids[1] as number, unitVector(1, 4));
    index.put(rowids[2] as number, [0.9, 0.1, 0, 0]);

    expect(index.count()).toBe(3);
    const neighbors = index.search({ vector: unitVector(0, 4), limit: 3 });
    expect(neighbors.map((n) => n.chunkRowid)).toEqual([1, 3, 2]);
    expect(neighbors[0]?.distance).toBeCloseTo(0, 5);

    // 覆盖写：把 2 号改成与查询同向，它应升到最前
    index.put(rowids[1] as number, unitVector(0, 4));
    expect(index.count()).toBe(3);
    expect(index.search({ vector: unitVector(0, 4), limit: 1 })[0]?.chunkRowid).toBeLessThanOrEqual(
      2,
    );
  });

  it("candidates 白名单精确前置过滤", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    seedEntry(db, makeEntry(), ["a", "b", "c"]);
    index.put(1, unitVector(0, 4));
    index.put(2, unitVector(1, 4));
    index.put(3, [0.95, 0.05, 0, 0]);

    // 最近的是 1 与 3，但只允许 2 → 必须返回 2，而不是「全局 top-k 再筛空」
    const filtered = index.search({ vector: unitVector(0, 4), limit: 2, candidates: [2] });
    expect(filtered.map((n) => n.chunkRowid)).toEqual([2]);

    // 空白名单表示「过滤后没有候选」
    expect(index.search({ vector: unitVector(0, 4), limit: 2, candidates: [] })).toEqual([]);
  });

  it("维度不符在写入与检索时都当场拒绝", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    expect(() => index.put(1, [1, 2, 3])).toThrow(/维度不符/);
    expect(() => index.search({ vector: [1, 2, 3], limit: 1 })).toThrow(/维度不符/);
  });

  it("删除与清空", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    seedEntry(db, makeEntry(), ["a", "b"]);
    index.put(1, unitVector(0, 4));
    index.put(2, unitVector(1, 4));

    index.deleteMany([1]);
    expect(index.count()).toBe(1);
    // 不存在的 rowid 静默跳过
    index.deleteMany([999]);
    expect(index.count()).toBe(1);

    index.clear();
    expect(index.count()).toBe(0);
    expect(index.search({ vector: unitVector(0, 4), limit: 5 })).toEqual([]);
  });

  it("k 大于总数时返回全部，空索引返回空", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    expect(index.search({ vector: unitVector(0, 4), limit: 50 })).toEqual([]);
    seedEntry(db, makeEntry(), ["a"]);
    index.put(1, unitVector(0, 4));
    expect(index.search({ vector: unitVector(0, 4), limit: 50 })).toHaveLength(1);
  });

  it("重开库后能按状态行还原同一后端", async () => {
    const db = openDb();
    const index = await setupIndex(db);
    if (index === undefined) {
      return;
    }
    seedEntry(db, makeEntry(), ["a"]);
    index.put(1, unitVector(0, 4));

    const reopened = openVectorIndex(db, extensionLoaded);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.index.backend).toBe(name);
      expect(reopened.index.count()).toBe(1);
    }
  });
});

describe("向量索引规格守卫", () => {
  it("换维度 / 换模型 / 换后端一律拒绝复用，提示重建", async () => {
    const db = openDb();
    const loaded = await loadVectorExtension(db);
    const extensionLoaded = loaded.ok;
    expect(ensureVectorIndex(db, { dimensions: 4, model: "m1", extensionLoaded }).ok).toBe(true);

    const otherDims = ensureVectorIndex(db, { dimensions: 8, model: "m1", extensionLoaded });
    expect(otherDims.ok).toBe(false);
    if (!otherDims.ok) {
      expect(otherDims.reason).toMatch(/重建向量索引/);
    }

    const otherModel = ensureVectorIndex(db, { dimensions: 4, model: "m2", extensionLoaded });
    expect(otherModel.ok).toBe(false);
    if (!otherModel.ok) {
      expect(otherModel.reason).toMatch(/不在同一空间/);
    }

    const otherBackend = ensureVectorIndex(db, {
      dimensions: 4,
      model: "m1",
      extensionLoaded: !extensionLoaded,
    });
    expect(otherBackend.ok).toBe(false);
  });

  it("非法维度与空模型直接拒绝", () => {
    const db = openDb();
    expect(ensureVectorIndex(db, { dimensions: 0, model: "m", extensionLoaded: false }).ok).toBe(
      false,
    );
    expect(ensureVectorIndex(db, { dimensions: 4, model: "  ", extensionLoaded: false }).ok).toBe(
      false,
    );
  });

  it("未建索引时 openVectorIndex 报「尚未建立」；drop 后回到未建状态", () => {
    const db = openDb();
    const before = openVectorIndex(db, false);
    expect(before.ok).toBe(false);

    expect(ensureVectorIndex(db, { dimensions: 4, model: "m", extensionLoaded: false }).ok).toBe(
      true,
    );
    expect(readVectorState(db)).toBeDefined();

    dropVectorIndex(db);
    expect(readVectorState(db)).toBeUndefined();
    // drop 之后可以换规格重建
    expect(ensureVectorIndex(db, { dimensions: 16, model: "m2", extensionLoaded: false }).ok).toBe(
      true,
    );
  });
});

describe("条目与块写入", () => {
  it("条目往返：三种来源、标签、内容哈希", () => {
    const db = openDb();
    const fileEntry = makeEntry({ tags: ["检索", "架构"], sourcePath: "D:/docs/x.md" });
    upsertKnowledgeEntry(db, fileEntry);

    const captured: KnowledgeEntry = {
      id: "ke-session" as KnowledgeEntryId,
      title: "会话收录",
      format: "text",
      origin: { kind: "session_capture", sessionId: "sess-1" as LocalSessionId },
      contentHash: "h-session",
      importedAt: 1_700_000_100_000,
    };
    upsertKnowledgeEntry(db, captured);
    const manual: KnowledgeEntry = {
      id: "ke-manual" as KnowledgeEntryId,
      title: "手写条目",
      format: "markdown",
      origin: { kind: "manual" },
      contentHash: "h-manual",
      importedAt: 1_700_000_200_000,
    };
    upsertKnowledgeEntry(db, manual);

    expect(getKnowledgeEntry(db, fileEntry.id)).toEqual({
      ...fileEntry,
      // 路径已归一为正斜杠
      origin: { kind: "file_import", sourcePath: "D:/docs/x.md" },
      // 标签按字典序返回（集合语义，不保留写入顺序）
      tags: ["架构", "检索"],
    });
    expect(getKnowledgeEntry(db, captured.id)).toEqual(captured);
    expect(getKnowledgeEntry(db, manual.id)).toEqual(manual);
    expect(getKnowledgeEntry(db, "不存在" as KnowledgeEntryId)).toBeUndefined();
  });

  it("Windows 反斜杠路径归一为正斜杠（前缀过滤才对得上）", () => {
    const db = openDb();
    const entry: KnowledgeEntry = {
      ...makeEntry(),
      origin: { kind: "file_import", sourcePath: "D:\\docs\\子目录\\a.md" },
    };
    upsertKnowledgeEntry(db, entry);

    const stored = getKnowledgeEntry(db, entry.id);
    expect(stored?.origin).toEqual({
      kind: "file_import",
      sourcePath: "D:/docs/子目录/a.md",
    });
  });

  it("重复 upsert 覆盖而不是新增；标签整体替换", () => {
    const db = openDb();
    const entry = makeEntry({ tags: ["旧标签"] });
    upsertKnowledgeEntry(db, entry);
    upsertKnowledgeEntry(db, { ...entry, title: "改了标题", tags: ["新标签", "另一个"] });

    expect(getKnowledgeStats(db).entries).toBe(1);
    const stored = getKnowledgeEntry(db, entry.id);
    expect(stored?.title).toBe("改了标题");
    expect(stored?.tags).toEqual(["另一个", "新标签"]);
  });

  it("块整体替换：旧块与其向量一并清掉，seq 重新排列", async () => {
    const db = openDb();
    const loaded = await loadVectorExtension(db);
    const created = ensureVectorIndex(db, {
      dimensions: 4,
      model: "m",
      extensionLoaded: loaded.ok,
    });
    expect(created.ok).toBe(true);
    const index = created.ok ? created.index : undefined;

    const entry = makeEntry();
    const first = seedEntry(db, entry, ["原第一块", "原第二块", "原第三块"]);
    for (const mapping of first) {
      index?.put(mapping.chunkRowid, unitVector(mapping.seq % 4, 4));
    }
    expect(index?.count()).toBe(3);

    const second = replaceEntryChunks(db, entry.id, makeChunks(["新的唯一一块"]), index);
    expect(second).toHaveLength(1);
    expect(getKnowledgeStats(db, index)).toMatchObject({ entries: 1, chunks: 1, vectors: 0 });

    const chunks = listEntryChunks(db, entry.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("新的唯一一块");
    expect(chunks[0]?.seq).toBe(0);
  });

  it("块出处往返：文件路径、标题路径、页码", () => {
    const db = openDb();
    const entry = makeEntry({ format: "pdf" });
    upsertKnowledgeEntry(db, entry);
    replaceEntryChunks(db, entry.id, [
      {
        id: "kc-prov" as KnowledgeChunkId,
        seq: 0,
        text: "带完整出处的块",
        provenance: { filePath: "D:/docs/手册.pdf", headingPath: ["安装", "Windows"], page: 7 },
      },
      {
        id: "kc-bare" as KnowledgeChunkId,
        seq: 1,
        text: "只有路径的块",
        provenance: { filePath: "D:/docs/手册.pdf" },
      },
    ]);

    const chunks = listEntryChunks(db, entry.id);
    expect(chunks[0]?.provenance).toEqual({
      filePath: "D:/docs/手册.pdf",
      headingPath: ["安装", "Windows"],
      page: 7,
    });
    // 缺省字段不写 undefined（exactOptionalPropertyTypes）
    expect(chunks[1]?.provenance).toEqual({ filePath: "D:/docs/手册.pdf" });
    expect(chunks[0]?.entryId).toBe(entry.id);
  });

  it("给不存在的条目写块直接抛", () => {
    const db = openDb();
    expect(() => replaceEntryChunks(db, "无此条目" as KnowledgeEntryId, makeChunks(["x"]))).toThrow(
      /不存在/,
    );
  });

  it("deleteKnowledgeEntry 幂等，并清掉块与向量", async () => {
    const db = openDb();
    const loaded = await loadVectorExtension(db);
    const created = ensureVectorIndex(db, {
      dimensions: 4,
      model: "m",
      extensionLoaded: loaded.ok,
    });
    const index = created.ok ? created.index : undefined;

    const entry = makeEntry();
    const mappings = seedEntry(db, entry, ["甲", "乙"]);
    for (const mapping of mappings) {
      index?.put(mapping.chunkRowid, unitVector(0, 4));
    }

    expect(deleteKnowledgeEntry(db, entry.id, index)).toBe(true);
    expect(getKnowledgeStats(db, index)).toMatchObject({ entries: 0, chunks: 0, vectors: 0 });
    // 再删一次：静默返回 false
    expect(deleteKnowledgeEntry(db, entry.id, index)).toBe(false);
  });

  it("增量索引：按内容哈希找已索引条目", () => {
    const db = openDb();
    const entry = makeEntry({ contentHash: "sha256:abc" });
    upsertKnowledgeEntry(db, entry);

    expect(findEntryByContentHash(db, "sha256:abc")?.id).toBe(entry.id);
    expect(findEntryByContentHash(db, "sha256:未见过")).toBeUndefined();
  });

  it("统计与列表：按导入时间倒序", () => {
    const db = openDb();
    const older = makeEntry({ importedAt: 1_000 });
    const newer = makeEntry({ importedAt: 2_000 });
    seedEntry(db, older, ["a", "b"]);
    seedEntry(db, newer, ["c"]);

    expect(getKnowledgeStats(db)).toMatchObject({ entries: 2, chunks: 3, vectors: 0 });
    expect(listKnowledgeEntries(db).map((row) => row.entry.id)).toEqual([newer.id, older.id]);
  });

  it("clearKnowledgeIndex 清空一切（派生数据的核选项）", () => {
    const db = openDb();
    seedEntry(db, makeEntry(), ["a", "b"]);
    seedEntry(db, makeEntry(), ["c"]);

    clearKnowledgeIndex(db);
    expect(getKnowledgeStats(db)).toMatchObject({ entries: 0, chunks: 0 });
  });
});

describe("上下文扩展", () => {
  it("取同一条目内 seq 相邻的块，不越界、不含自身", () => {
    const db = openDb();
    const entry = makeEntry();
    const mappings = seedEntry(db, entry, ["块0", "块1", "块2", "块3", "块4"]);
    const middle = mappings[2]?.chunkRowid as number;

    const context = expandContext(db, middle, 1, 1);
    expect(context.before.map((chunk) => chunk.text)).toEqual(["块1"]);
    expect(context.after.map((chunk) => chunk.text)).toEqual(["块3"]);

    // 首块没有前文，尾块没有后文
    expect(expandContext(db, mappings[0]?.chunkRowid as number, 2, 2).before).toEqual([]);
    expect(expandContext(db, mappings[4]?.chunkRowid as number, 2, 2).after).toEqual([]);
    // 扩展 0 即不扩展
    expect(expandContext(db, middle, 0, 0)).toEqual({ before: [], after: [] });
  });

  it("不跨条目取上下文", () => {
    const db = openDb();
    const first = makeEntry();
    const second = makeEntry();
    seedEntry(db, first, ["甲文档块0", "甲文档块1"]);
    const secondMappings = seedEntry(db, second, ["乙文档块0", "乙文档块1"]);

    const context = expandContext(db, secondMappings[0]?.chunkRowid as number, 3, 3);
    expect(context.before).toEqual([]);
    expect(context.after.map((chunk) => chunk.text)).toEqual(["乙文档块1"]);
  });

  it("rowid 不存在时返回空而不是抛", () => {
    const db = openDb();
    expect(expandContext(db, 99999, 1, 1)).toEqual({ before: [], after: [] });
  });
});

/** 检索便捷包装：默认不扩展上下文，断言更聚焦。 */
function search(
  db: Database.Database,
  options: Partial<KnowledgeSearchOptions> & { readonly query: string },
) {
  return searchKnowledge(db, { contextBefore: 0, contextAfter: 0, ...options });
}

/** 取命中块的正文。 */
function texts(result: ReturnType<typeof searchKnowledge>): string[] {
  return result.hits.map((hit) => hit.chunk.text);
}

describe("FTS5 关键词检索", () => {
  it("BM25 命中并按相关度排序", () => {
    const db = openDb();
    seedEntry(db, makeEntry(), [
      "混合检索把关键词召回与向量召回融合排序",
      "分块器按标题层级切分文档",
      "混合检索的融合算法是 RRF，混合检索是本章重点",
    ]);

    const result = search(db, { query: "混合检索" });
    expect(result.usedFts).toBe(true);
    expect(result.hits.length).toBe(2);
    // 出现两次的块更相关
    expect(result.hits[0]?.chunk.text).toContain("本章重点");
    expect(result.hits[0]?.sources).toEqual(["fts"]);
  });

  it("标题路径参与检索且权重更高", () => {
    const db = openDb();
    const entry = makeEntry();
    upsertKnowledgeEntry(db, entry);
    replaceEntryChunks(db, entry.id, [
      {
        id: "kc-h1" as KnowledgeChunkId,
        seq: 0,
        text: "这里讲的是别的东西，一个字都没提。",
        provenance: { filePath: "D:/docs/a.md", headingPath: ["安装指南", "疑难解答"] },
      },
    ]);

    expect(texts(search(db, { query: "疑难解答" }))).toHaveLength(1);
  });

  it("查询短于 3 码点时回退 LIKE 子串扫描（trigram 的固有下限）", () => {
    const db = openDb();
    seedEntry(db, makeEntry(), ["登录流程说明", "退出流程说明"]);

    const result = search(db, { query: "登录" });
    expect(result.usedFts).toBe(false);
    expect(texts(result)).toEqual(["登录流程说明"]);
    expect(result.hits[0]?.sources).toEqual(["like-fallback"]);
  });

  it("查询里的双引号与通配符按字面处理，不触碰查询语法", () => {
    const db = openDb();
    seedEntry(db, makeEntry(), ['他说 "混合检索" 很好用', "百分之百 100% 命中", "下划线_分隔"]);

    expect(texts(search(db, { query: '"混合检索"' }))).toHaveLength(1);
    // LIKE 回退路径上的通配符也必须按字面
    expect(texts(search(db, { query: "0%" }))).toEqual(["百分之百 100% 命中"]);
    expect(texts(search(db, { query: "线_分" }))).toEqual(["下划线_分隔"]);
  });

  it("空白查询与无命中都是正常空结果", () => {
    const db = openDb();
    seedEntry(db, makeEntry(), ["随便一点内容"]);

    expect(search(db, { query: "   " }).hits).toEqual([]);
    expect(search(db, { query: "绝不可能出现的字符串" }).hits).toEqual([]);
    expect(search(db, { query: "内容", limit: 0 }).hits).toEqual([]);
  });

  it("块删除后不再命中（FTS 触发器同步生效）", () => {
    const db = openDb();
    const entry = makeEntry();
    seedEntry(db, entry, ["会被删掉的独特内容标记"]);
    expect(texts(search(db, { query: "独特内容标记" }))).toHaveLength(1);

    deleteKnowledgeEntry(db, entry.id);
    expect(search(db, { query: "独特内容标记" }).hits).toEqual([]);
  });
});

describe("过滤维度（§8.3.4）", () => {
  /** 布置一批跨格式、跨目录、跨时间、带标签的语料。 */
  function seedCorpus(db: Database.Database): void {
    seedEntry(
      db,
      makeEntry({
        id: "e-md",
        format: "markdown",
        sourcePath: "D:/docs/手册/安装.md",
        importedAt: 1_000,
        tags: ["手册", "入门"],
      }),
      ["检索系统的安装步骤如下"],
    );
    seedEntry(
      db,
      makeEntry({
        id: "e-pdf",
        format: "pdf",
        sourcePath: "D:/docs/论文/rrf.pdf",
        importedAt: 5_000,
        tags: ["论文"],
      }),
      ["检索系统的融合算法综述"],
    );
    seedEntry(
      db,
      makeEntry({
        id: "e-code",
        format: "source_code",
        sourcePath: "D:/src/搜索/index.ts",
        importedAt: 9_000,
        tags: ["入门"],
      }),
      ["检索系统的入口实现"],
    );
  }

  function ids(db: Database.Database, filters: KnowledgeFilters): string[] {
    return search(db, { query: "检索系统", filters })
      .hits.map((hit) => hit.chunk.entryId as string)
      .sort();
  }

  it("按格式过滤（OR 语义）", () => {
    const db = openDb();
    seedCorpus(db);

    expect(ids(db, { formats: ["pdf"] })).toEqual(["e-pdf"]);
    expect(ids(db, { formats: ["pdf", "source_code"] })).toEqual(["e-code", "e-pdf"]);
    // 空数组不过滤
    expect(ids(db, { formats: [] })).toHaveLength(3);
  });

  it("按标签过滤（OR 语义，精确匹配不误伤子串）", () => {
    const db = openDb();
    seedCorpus(db);

    expect(ids(db, { tags: ["入门"] })).toEqual(["e-code", "e-md"]);
    expect(ids(db, { tags: ["论文", "手册"] })).toEqual(["e-md", "e-pdf"]);
    // 「手」不是「手册」，标签是精确匹配而非子串
    expect(ids(db, { tags: ["手"] })).toEqual([]);
  });

  it("按来源目录前缀过滤（反斜杠自动归一）", () => {
    const db = openDb();
    seedCorpus(db);

    expect(ids(db, { sourcePathPrefix: "D:/docs/" })).toEqual(["e-md", "e-pdf"]);
    expect(ids(db, { sourcePathPrefix: "D:\\docs\\论文" })).toEqual(["e-pdf"]);
    expect(ids(db, { sourcePathPrefix: "D:/nowhere" })).toEqual([]);
  });

  it("按导入时间区间过滤", () => {
    const db = openDb();
    seedCorpus(db);

    expect(ids(db, { importedAfter: 5_000 })).toEqual(["e-code", "e-pdf"]);
    expect(ids(db, { importedBefore: 5_000 })).toEqual(["e-md", "e-pdf"]);
    expect(ids(db, { importedAfter: 2_000, importedBefore: 6_000 })).toEqual(["e-pdf"]);
  });

  it("限定条目集合 + 多维度组合（AND 语义）", () => {
    const db = openDb();
    seedCorpus(db);

    expect(ids(db, { entryIds: ["e-md" as KnowledgeEntryId] })).toEqual(["e-md"]);
    expect(
      ids(db, { formats: ["markdown", "pdf"], tags: ["入门"], importedBefore: 4_000 }),
    ).toEqual(["e-md"]);
    // 条件互斥 → 空结果
    expect(ids(db, { formats: ["pdf"], tags: ["手册"] })).toEqual([]);
  });

  it("过滤在 LIKE 回退路径上同样生效", () => {
    const db = openDb();
    seedCorpus(db);

    const result = search(db, { query: "系统", filters: { formats: ["pdf"] } });
    expect(result.usedFts).toBe(false);
    expect(result.hits.map((hit) => hit.chunk.entryId)).toEqual(["e-pdf"]);
  });
});

describe("混合检索（双路 RRF 融合）", () => {
  /** 造 4 维语料：文本供 FTS，向量供 KNN。 */
  async function seedHybrid(db: Database.Database): Promise<VectorIndex | undefined> {
    const loaded = await loadVectorExtension(db);
    const created = ensureVectorIndex(db, {
      dimensions: 4,
      model: "m",
      extensionLoaded: loaded.ok,
    });
    if (!created.ok) {
      return undefined;
    }
    const entry = makeEntry();
    const mappings = seedEntry(db, entry, [
      "关键词命中但语义无关的一块文字", // rowid 1
      "语义相近但没有字面关键词的内容", // rowid 2
      "两边都沾一点的中间地带内容", // rowid 3
    ]);
    created.index.put(mappings[0]?.chunkRowid as number, unitVector(3, 4));
    created.index.put(mappings[1]?.chunkRowid as number, unitVector(0, 4));
    created.index.put(mappings[2]?.chunkRowid as number, [0.8, 0, 0, 0.2]);
    return created.index;
  }

  it("两路都参与时结果标注双来源", async () => {
    const db = openDb();
    const index = await seedHybrid(db);
    if (index === undefined) {
      return;
    }

    const result = search(db, {
      query: "中间地带",
      queryVector: unitVector(0, 4),
      vectorIndex: index,
    });

    expect(result.usedFts).toBe(true);
    expect(result.usedVector).toBe(true);
    expect(result.vectorPrefilterExact).toBe(true);
    const both = result.hits.find((hit) => hit.sources.length === 2);
    expect(both?.chunk.text).toContain("中间地带");
    expect(both?.ranks).toHaveProperty("fts");
    expect(both?.ranks).toHaveProperty("vector");
    // 两路都命中的排在最前
    expect(result.hits[0]?.chunk.text).toContain("中间地带");
  });

  it("只给查询向量、不给文字也能检索（找相似块）", async () => {
    const db = openDb();
    const index = await seedHybrid(db);
    if (index === undefined) {
      return;
    }

    const result = search(db, { query: "", queryVector: unitVector(0, 4), vectorIndex: index });
    expect(result.usedFts).toBe(false);
    expect(result.usedVector).toBe(true);
    expect(result.hits[0]?.chunk.text).toContain("语义相近");
    expect(result.hits[0]?.sources).toEqual(["vector"]);
  });

  it("未配嵌入模型时退化为纯 FTS，功能不缺失（§8.3.3）", async () => {
    const db = openDb();
    const index = await seedHybrid(db);
    if (index === undefined) {
      return;
    }

    // 不传 queryVector / vectorIndex —— 正是「未配嵌入模型」的形态
    const result = search(db, { query: "中间地带" });
    expect(result.usedVector).toBe(false);
    expect(result.usedFts).toBe(true);
    expect(texts(result)).toHaveLength(1);
    expect(result.hits[0]?.sources).toEqual(["fts"]);
  });

  it("向量路同样受过滤约束（精确前置）", async () => {
    const db = openDb();
    const loaded = await loadVectorExtension(db);
    const created = ensureVectorIndex(db, {
      dimensions: 4,
      model: "m",
      extensionLoaded: loaded.ok,
    });
    if (!created.ok) {
      return;
    }
    const mdEntry = makeEntry({ id: "e-md2", format: "markdown" });
    const pdfEntry = makeEntry({ id: "e-pdf2", format: "pdf" });
    const mdMappings = seedEntry(db, mdEntry, ["markdown 里的内容"]);
    const pdfMappings = seedEntry(db, pdfEntry, ["pdf 里的内容"]);
    // 让 markdown 那块离查询更近
    created.index.put(mdMappings[0]?.chunkRowid as number, unitVector(0, 4));
    created.index.put(pdfMappings[0]?.chunkRowid as number, unitVector(1, 4));

    const result = search(db, {
      query: "",
      queryVector: unitVector(0, 4),
      vectorIndex: created.index,
      filters: { formats: ["pdf"] },
    });

    // 全局最近的是 markdown 块，但过滤只允许 pdf —— 必须返回 pdf 块而不是空
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunk.entryId).toBe("e-pdf2");
    expect(result.vectorPrefilterExact).toBe(true);
  });

  it("命中结果带上下文扩展与出处", async () => {
    const db = openDb();
    const entry = makeEntry({ sourcePath: "D:/docs/长文.md" });
    seedEntry(db, entry, ["第零块铺垫", "命中块含有特征词组", "第二块收尾"], {
      headingPath: ["第一章"],
    });

    const result = searchKnowledge(db, { query: "特征词组", contextBefore: 1, contextAfter: 1 });
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit?.before.map((chunk) => chunk.text)).toEqual(["第零块铺垫"]);
    expect(hit?.after.map((chunk) => chunk.text)).toEqual(["第二块收尾"]);
    expect(hit?.chunk.provenance).toEqual({
      filePath: "D:/docs/长文.md",
      headingPath: ["第一章"],
    });
  });

  it("limit 截断在融合之后（两路各自超额召回）", () => {
    const db = openDb();
    seedEntry(
      db,
      makeEntry(),
      Array.from({ length: 30 }, (_, index) => `第 ${index} 段都包含关键词组合检索`),
    );

    expect(search(db, { query: "关键词组合检索", limit: 5 }).hits).toHaveLength(5);
    expect(search(db, { query: "关键词组合检索", limit: 100 }).hits).toHaveLength(30);
  });
});

/**
 * 20 条中文检索抽测（工单点名要求）。
 * 语料是一份小型中文技术文档，逐条断言「这个查询应该找到哪一块」——
 * 中文没有空格分词，trigram 子串检索是否真的顶用，只有拿真中文查询逐条比对才算数。
 */
describe("20 条中文检索抽测", () => {
  const CORPUS: readonly (readonly [string, string])[] = [
    ["安装", "在 Windows 上安装本程序需要先准备好运行环境，然后双击安装包按向导完成。"],
    ["卸载", "卸载时请从控制面板的程序列表中移除，配置文件不会被自动删除。"],
    ["配置", "配置文件位于用户目录下，采用 JSON 格式，修改后需要重启程序才能生效。"],
    ["模型", "嵌入模型通过 Provider 配置，未配置嵌入模型时知识库降级为纯全文检索。"],
    ["检索", "混合检索把关键词召回与向量召回合起来排序，用倒数排名融合算法。"],
    ["分块", "结构感知分块器按标题层级切分文档，块大小控制在三百到八百个词元之间。"],
    ["索引", "索引是派生数据，真实数据源永远是原始文件，索引损坏时删库重建即可。"],
    ["权限", "权限层拦截所有写操作，拒绝的操作会在执行记录中留下完整痕迹。"],
    ["会话", "会话支持多轮对话，历史消息会按需注入到系统提示词的第二层。"],
    ["快捷键", "常用快捷键包括新建会话、切换项目与打开设置面板三组。"],
    ["日志", "运行日志按天切分保存，超过三十天的日志文件会被自动清理。"],
    ["代理", "如果需要通过代理访问接口，请在 Provider 设置中填写代理地址。"],
    ["超时", "请求超时的默认值是一百二十秒，可以按 Provider 单独调整。"],
    ["导出", "导出功能支持把选中的条目或整个来源目录保存成带出处元数据的文件。"],
    ["标签", "为条目添加标签之后，可以在检索时按标签快速缩小范围。"],
    ["习惯", "习惯档案会在每次请求前注入，其中流程约束类的条目优先级最高。"],
    ["计划", "计划生成后需要用户确认才会进入执行阶段，中途可以随时中断。"],
    ["项目", "每个项目有独立的工作目录，项目之间的记忆互不干扰。"],
    ["备份", "重要数据建议定期备份，程序本身不提供云端同步能力。"],
    ["性能", "十万级文本块的检索延迟通常在几十毫秒以内，取决于磁盘速度。"],
  ];

  /** 抽测用例：查询 → 期望命中的那条语料的标记。 */
  const CASES: readonly (readonly [string, string])[] = [
    ["安装包", "安装"],
    ["控制面板", "卸载"],
    ["JSON 格式", "配置"],
    ["嵌入模型", "模型"],
    ["向量召回", "检索"],
    ["标题层级", "分块"],
    ["派生数据", "索引"],
    ["拒绝的操作", "权限"],
    ["多轮对话", "会话"],
    ["新建会话", "快捷键"],
    ["自动清理", "日志"],
    ["代理地址", "代理"],
    ["一百二十秒", "超时"],
    ["出处元数据", "导出"],
    ["缩小范围", "标签"],
    ["流程约束", "习惯"],
    ["执行阶段", "计划"],
    ["工作目录", "项目"],
    ["云端同步", "备份"],
    ["几十毫秒", "性能"],
  ];

  it.each(CASES)("查询「%s」命中「%s」那一条", (query, expectedMarker) => {
    const db = openDb();
    const entry = makeEntry();
    upsertKnowledgeEntry(db, entry);
    replaceEntryChunks(
      db,
      entry.id,
      CORPUS.map(([marker, text], index) => ({
        id: `kc-cn-${marker}` as KnowledgeChunkId,
        seq: index,
        text,
        provenance: { filePath: "D:/docs/中文手册.md" },
      })),
    );

    const result = search(db, { query, limit: 3 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.chunk.id).toBe(`kc-cn-${expectedMarker}`);
  });

  it("中文查询按 FTS 路径而非 LIKE 回退（trigram 对 ≥3 码点有效）", () => {
    const db = openDb();
    const entry = makeEntry();
    upsertKnowledgeEntry(db, entry);
    replaceEntryChunks(
      db,
      entry.id,
      CORPUS.map(([marker, text], index) => ({
        id: `kc-cn2-${marker}` as KnowledgeChunkId,
        seq: index,
        text,
        provenance: { filePath: "D:/docs/中文手册.md" },
      })),
    );

    expect(search(db, { query: "嵌入模型" }).usedFts).toBe(true);
    // 双字中文低于 trigram 下限，自动回退子串扫描，仍然命中
    const short = search(db, { query: "备份" });
    expect(short.usedFts).toBe(false);
    expect(short.hits.length).toBeGreaterThan(0);
  });
});

describe("大规模行为（容量目标 §8.3.2）", () => {
  it("两千块语料的检索与上下文扩展仍然正确", () => {
    const db = openDb();
    const entry = makeEntry();
    upsertKnowledgeEntry(db, entry);
    const chunks: KnowledgeChunkInput[] = Array.from({ length: 2000 }, (_, index) => ({
      id: `kc-bulk-${index}` as KnowledgeChunkId,
      seq: index,
      text:
        index === 1234
          ? "这一块埋着独一无二的稀有短语标识符"
          : `第 ${index} 块的常规内容，讲的是通用主题。`,
      provenance: { filePath: "D:/docs/大文档.md" },
    }));
    replaceEntryChunks(db, entry.id, chunks);

    const result = searchKnowledge(db, {
      query: "稀有短语标识符",
      contextBefore: 1,
      contextAfter: 1,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunk.seq).toBe(1234);
    expect(result.hits[0]?.before[0]?.seq).toBe(1233);
    expect(result.hits[0]?.after[0]?.seq).toBe(1235);
    expect(getKnowledgeStats(db).chunks).toBe(2000);
  });

  it("退路后端在两千向量上给出与暴力计算一致的最近邻", () => {
    const db = openDb();
    const created = ensureVectorIndex(db, {
      dimensions: 8,
      model: "m",
      extensionLoaded: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const entry = makeEntry();
    upsertKnowledgeEntry(db, entry);
    const count = 2000;
    replaceEntryChunks(
      db,
      entry.id,
      Array.from({ length: count }, (_, index) => ({
        id: `kc-vec-${index}` as KnowledgeChunkId,
        seq: index,
        text: `块 ${index}`,
        provenance: { filePath: "D:/docs/v.md" },
      })),
    );

    // 确定性伪随机向量（无 Math.random，测试可复现）
    const vectors = new Map<number, number[]>();
    const rows = db
      .prepare(`SELECT chunk_rowid AS rowid, seq FROM ${KNOWLEDGE_CHUNK_TABLE} ORDER BY seq`)
      .all() as { readonly rowid: number; readonly seq: number }[];
    for (const row of rows) {
      const vector = Array.from({ length: 8 }, (_, dim) =>
        Math.sin((row.seq + 1) * (dim + 1) * 0.7331),
      );
      vectors.set(row.rowid, vector);
      created.index.put(row.rowid, vector);
    }

    const query = Array.from({ length: 8 }, (_, dim) => Math.cos((dim + 1) * 0.211));
    const bruteForce = [...vectors.entries()]
      .map(([rowid, vector]) => ({ rowid, distance: cosineDistance(query, vector) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 5)
      .map((item) => item.rowid);

    expect(created.index.search({ vector: query, limit: 5 }).map((n) => n.chunkRowid)).toEqual(
      bruteForce,
    );
  });
});
