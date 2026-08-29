/**
 * W1.3b 单测：记忆索引同步钩子 + 业务检索 API。
 * 索引用内存库，真实源走 mkdtemp 临时目录真实读写（沿用 memory.test.ts 约定）。
 * 覆盖：三个钩子与索引一致性、增量同步与全量重建的等价性、
 * 短查询 LIKE 回退（中文双字词）、matchKind 标注、hydrate 回读与损坏跳过、issues 传递。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryEntryId } from "@ff-pane/shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemorySearchHit, MemorySearchResult, ProjectLayout } from "../src/index.js";
import {
  closeIndexDb,
  initProjectLayout,
  MEMORY_FTS_MIN_QUERY_CODE_POINTS,
  openIndexDb,
  rebuildIndexFromStore,
  resolveEntryFilePath,
  saveEntry,
  searchMemory,
  searchMemoryIndex,
  syncEntryDeleted,
  syncEntrySaved,
  syncEntryStatusChanged,
  updateEntryStatus,
  upsertMemoryEntry,
} from "../src/index.js";

let tempRoot: string;
let layout: ProjectLayout;
let db: Database.Database;
const extraDbs: Database.Database[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-index-sync-"));
  layout = await initProjectLayout(join(tempRoot, "记忆索引·项目"));
  db = openIndexDb({ filePath: ":memory:" });
});

afterEach(async () => {
  closeIndexDb(db);
  for (const extra of extraDbs.splice(0)) {
    closeIndexDb(extra);
  }
  await rm(tempRoot, { recursive: true, force: true });
});

function openExtraDb(): Database.Database {
  const extra = openIndexDb({ filePath: ":memory:" });
  extraDbs.push(extra);
  return extra;
}

const BASE_ENTRY: MemoryEntry = {
  id: "mem-00" as MemoryEntryId,
  category: "decision",
  title: "缺省标题",
  body: "缺省正文",
  status: "active",
  source: { kind: "user_manual" },
  confidence: "high",
  createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
  updatedAt: Date.parse("2026-08-02T00:00:00.000Z"),
};

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { ...BASE_ENTRY, ...overrides } as MemoryEntry;
}

/**
 * 固定语料（全部可落盘，故不含 category=state）。「测试」的命中位置刻意分散：
 * mem-01/04 在标题、mem-06 只在标签、mem-05 只在正文，用于验证 LIKE 回退的排序档位；
 * mem-07 带 % 与 _、mem-08 带反斜杠，用于验证 LIKE 通配符转义。
 */
const FIXTURES: readonly MemoryEntry[] = [
  makeEntry({
    id: "mem-01" as MemoryEntryId,
    category: "lesson",
    status: "active",
    title: "Windows 下的测试入口",
    body: "本项目必须用 pnpm 运行测试命令，npm test 在 Windows 下会挂",
    tags: ["测试命令", "windows"],
  }),
  makeEntry({
    id: "mem-02" as MemoryEntryId,
    category: "rule",
    status: "active",
    title: "遗留目录禁改",
    body: "src/legacy/ 目录禁止修改，历史包袱等待整体迁移",
  }),
  makeEntry({
    id: "mem-03" as MemoryEntryId,
    category: "decision",
    status: "active",
    title: "Storage engine decision",
    body: "Use SQLite with FTS5, not PostgreSQL",
    tags: ["sqlite", "storage"],
  }),
  makeEntry({
    id: "mem-04" as MemoryEntryId,
    category: "lesson",
    status: "candidate",
    title: "候选：测试用例待补",
    body: "登录模块缺集成用例",
  }),
  makeEntry({
    id: "mem-05" as MemoryEntryId,
    category: "decision",
    status: "archived",
    title: "旧版构建备忘",
    body: "上线脚本末尾跑一次测试，该做法已废弃",
  }),
  makeEntry({
    id: "mem-06" as MemoryEntryId,
    category: "decision",
    status: "active",
    title: "部署核对清单",
    body: "上线前逐项核对",
    tags: ["测试", "发布"],
  }),
  makeEntry({
    id: "mem-07" as MemoryEntryId,
    category: "rule",
    status: "active",
    title: "覆盖率红线",
    body: "覆盖率不得低于 80%，标识符命名用 snake_case",
  }),
  makeEntry({
    id: "mem-08" as MemoryEntryId,
    category: "lesson",
    status: "active",
    title: "路径写法",
    body: "Windows 路径写成 C:\\Users 形式，跨平台代码须归一化",
  }),
];

function fixtureById(id: string): MemoryEntry {
  const entry = FIXTURES.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`语料缺少 ${id}`);
  }
  return entry;
}

/** 把全部语料写入真实源（Markdown）。 */
async function seedStore(): Promise<void> {
  for (const entry of FIXTURES) {
    await saveEntry(layout, entry);
  }
}

/** 按「宿主写盘成功后调钩子」的约定，逐条增量同步到指定索引。 */
function seedIncremental(target: Database.Database): void {
  for (const entry of FIXTURES) {
    syncEntrySaved(target, entry);
  }
}

function ids(result: MemorySearchResult): string[] {
  return result.hits.map((hit) => hit.id);
}

function expectOk<T, E extends Error>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败: ${result.error.message}`);
  }
  return result.value;
}

describe("W1.3b 同步钩子与索引一致性", () => {
  it("syncEntrySaved 新增后可检索，再次调用为整行覆盖（旧词出清、不膨胀）", async () => {
    const entry = makeEntry({ id: "mem-h1" as MemoryEntryId, body: "初版正文含旧关键词甲乙丙" });
    syncEntrySaved(db, entry);
    expect(ids(await searchMemory(db, { query: "旧关键词" }))).toEqual(["mem-h1"]);

    syncEntrySaved(db, { ...entry, body: "改版正文含新关键词丁戊己" });
    expect(ids(await searchMemory(db, { query: "旧关键词" }))).toEqual([]);
    expect(ids(await searchMemory(db, { query: "新关键词" }))).toEqual(["mem-h1"]);
    const count = db.prepare("SELECT COUNT(*) AS n FROM memory_entry").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("syncEntryStatusChanged 落到索引：状态过滤随之改变，正文不受影响", async () => {
    const candidate = makeEntry({
      id: "mem-h2" as MemoryEntryId,
      status: "candidate",
      body: "候选条目的正文关键词壬癸",
    });
    syncEntrySaved(db, candidate);
    expect(ids(await searchMemory(db, { query: "关键词壬癸", statuses: ["candidate"] }))).toEqual([
      "mem-h2",
    ]);

    syncEntryStatusChanged(db, { ...candidate, status: "active" });
    expect(ids(await searchMemory(db, { query: "关键词壬癸", statuses: ["candidate"] }))).toEqual(
      [],
    );
    expect(ids(await searchMemory(db, { query: "关键词壬癸", statuses: ["active"] }))).toEqual([
      "mem-h2",
    ]);
  });

  it("syncEntryDeleted 移除索引行且幂等", async () => {
    const entry = makeEntry({ id: "mem-h3" as MemoryEntryId, body: "待删除条目的检索正文" });
    syncEntrySaved(db, entry);
    syncEntryDeleted(db, entry.id);
    expect(ids(await searchMemory(db, { query: "待删除条目" }))).toEqual([]);
    expect(() => syncEntryDeleted(db, entry.id)).not.toThrow();
  });
});

describe("W1.3b rebuildIndexFromStore（真实源 → 索引）", () => {
  it("全量灌入 listEntries 的合法条目，返回条数，结果可检索", async () => {
    await seedStore();
    const result = await rebuildIndexFromStore(layout, db);
    expect(result.indexed).toBe(FIXTURES.length);
    expect(result.issues).toEqual([]);
    expect(ids(await searchMemory(db, { query: "测试命令" }))).toEqual(["mem-01"]);
  });

  it("清空重灌：真实源已不存在的陈旧索引行被出清", async () => {
    await seedStore();
    upsertMemoryEntry(
      db,
      makeEntry({ id: "mem-stale" as MemoryEntryId, body: "陈旧幽灵条目正文" }),
    );
    expect(ids(await searchMemory(db, { query: "幽灵条目" }))).toEqual(["mem-stale"]);

    await rebuildIndexFromStore(layout, db);
    expect(ids(await searchMemory(db, { query: "幽灵条目" }))).toEqual([]);
  });

  it("损坏文件不阻断重建：合法条目照常入索引，issues 原样上传", async () => {
    await seedStore();
    const corruptPath = join(layout.memoryCategoryDirs.rule, "mem-坏.md");
    await writeFile(corruptPath, "随手写的纯 Markdown，没有 frontmatter\n", "utf8");

    const result = await rebuildIndexFromStore(layout, db);
    expect(result.indexed).toBe(FIXTURES.length);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(corruptPath);
    expect(result.issues[0]?.error.code).toBe("frontmatter-syntax");
  });

  it("空真实源重建为 0 条，不抛错", async () => {
    const result = await rebuildIndexFromStore(layout, db);
    expect(result).toEqual({ indexed: 0, issues: [] });
    expect(ids(await searchMemory(db, { query: "测试" }))).toEqual([]);
  });

  it("增量同步与全量重建等价：同一批数据两条路径查询结果完全相同", async () => {
    const rebuilt = openExtraDb();
    const queries = [
      { query: "测试" },
      { query: "测试命令" },
      { query: "禁止修改" },
      { query: "测试", categories: ["decision"] as const },
      { query: "测试", statuses: ["active"] as const },
      { query: "pipeline" },
    ];
    const compare = async (): Promise<void> => {
      for (const query of queries) {
        const incremental = await searchMemory(db, query);
        const full = await searchMemory(rebuilt, query);
        expect(full.hits).toEqual(incremental.hits);
      }
    };

    // 1) 新建：写盘 + 逐条钩子 vs 写盘 + 全量重建
    await seedStore();
    seedIncremental(db);
    expect((await rebuildIndexFromStore(layout, rebuilt)).indexed).toBe(FIXTURES.length);
    await compare();
    expect(ids(await searchMemory(db, { query: "测试" })).length).toBeGreaterThan(0);

    // 2) 状态流转：钩子 vs 重建
    const moved = expectOk(await updateEntryStatus(layout, "mem-04" as MemoryEntryId, "active"));
    syncEntryStatusChanged(db, moved);
    await rebuildIndexFromStore(layout, rebuilt);
    await compare();
    expect(ids(await searchMemory(db, { query: "测试", statuses: ["candidate"] }))).toEqual([]);

    // 3) 删除：钩子 vs 重建
    const removed = fixtureById("mem-02");
    await rm(resolveEntryFilePath(layout, removed));
    syncEntryDeleted(db, removed.id);
    await rebuildIndexFromStore(layout, rebuilt);
    await compare();
    expect(ids(await searchMemory(db, { query: "禁止修改" }))).toEqual([]);
  });
});

describe("W1.3b searchMemory 路径选择与 matchKind", () => {
  it("≥3 码点走 FTS，标注 fts 并带 BM25 分", async () => {
    seedIncremental(db);
    const result = await searchMemory(db, { query: "测试命令" });
    expect(ids(result)).toEqual(["mem-01"]);
    const [hit] = result.hits;
    expect(hit?.matchKind).toBe("fts");
    expect(typeof hit?.score).toBe("number");
  });

  it("中文双字词（<3 码点）回退 LIKE：能查到东西，标注 like-fallback 且无打分", async () => {
    seedIncremental(db);
    // 同一个词直接进 FTS 恒零命中（trigram 下限），这正是回退存在的理由。
    expect(searchMemoryIndex(db, { match: '"测试"' })).toEqual([]);

    const result = await searchMemory(db, { query: "测试" });
    expect(ids(result)).toEqual(["mem-01", "mem-04", "mem-06", "mem-05"]);
    expect(result.hits.every((hit) => hit.matchKind === "like-fallback")).toBe(true);
    expect(result.hits.every((hit) => hit.score === undefined)).toBe(true);
  });

  it("LIKE 回退按「标题 > 标签 > 正文」的确定性档位排序", async () => {
    seedIncremental(db);
    const result = await searchMemory(db, { query: "测试" });
    // mem-01/04 标题命中、mem-06 仅标签命中、mem-05 仅正文命中。
    expect(ids(result)).toEqual(["mem-01", "mem-04", "mem-06", "mem-05"]);
  });

  it("LIKE 回退保持 category / status 过滤与 limit", async () => {
    seedIncremental(db);
    expect(ids(await searchMemory(db, { query: "测试", categories: ["decision"] }))).toEqual([
      "mem-06",
      "mem-05",
    ]);
    expect(ids(await searchMemory(db, { query: "测试", statuses: ["candidate"] }))).toEqual([
      "mem-04",
    ]);
    expect(
      ids(await searchMemory(db, { query: "测试", categories: ["lesson"], statuses: ["active"] })),
    ).toEqual(["mem-01"]);
    expect(ids(await searchMemory(db, { query: "测试", limit: 2 }))).toEqual(["mem-01", "mem-04"]);
    // 空数组等同不过滤（与 W1.3a 的 FTS 路径同口径）。
    expect(ids(await searchMemory(db, { query: "测试", categories: [], statuses: [] }))).toEqual([
      "mem-01",
      "mem-04",
      "mem-06",
      "mem-05",
    ]);
  });

  it("LIKE 回退转义通配符：% / _ / 反斜杠按字面匹配", async () => {
    seedIncremental(db);
    expect(ids(await searchMemory(db, { query: "%" }))).toEqual(["mem-07"]);
    expect(ids(await searchMemory(db, { query: "_" }))).toEqual(["mem-07"]);
    expect(ids(await searchMemory(db, { query: "\\" }))).toEqual(["mem-08"]);
  });

  it("首尾空白去除后判定路径；纯空白查询返回空结果且不抛错", async () => {
    seedIncremental(db);
    expect(ids(await searchMemory(db, { query: "  测试  " }))).toEqual([
      "mem-01",
      "mem-04",
      "mem-06",
      "mem-05",
    ]);
    expect(await searchMemory(db, { query: "" })).toEqual({ hits: [], issues: [] });
    expect(await searchMemory(db, { query: "   \n\t " })).toEqual({ hits: [], issues: [] });
    expect(await searchMemory(db, { query: " ", hydrate: true, layout })).toEqual({
      hits: [],
      issues: [],
    });
  });

  it("用户输入的 FTS5 语法字符按字面处理，不构成查询语法", async () => {
    syncEntrySaved(
      db,
      makeEntry({ id: "mem-q" as MemoryEntryId, body: '正文包含 "AND" 引号的片段' }),
    );
    expect(ids(await searchMemory(db, { query: '"AND" 引号' }))).toEqual(["mem-q"]);
    await expect(searchMemory(db, { query: "NEAR(" })).resolves.toEqual({ hits: [], issues: [] });
  });

  it("码点下限常量与实际分档一致", () => {
    expect(MEMORY_FTS_MIN_QUERY_CODE_POINTS).toBe(3);
  });
});

describe("W1.3b searchMemory hydrate（凭 id 回读真实源）", () => {
  it("hydrate: false（缺省）不回读，entry 缺席、issues 为空", async () => {
    await seedStore();
    await rebuildIndexFromStore(layout, db);
    const result = await searchMemory(db, { query: "测试命令" });
    expect(result.issues).toEqual([]);
    expect(result.hits[0]?.entry).toBeUndefined();
  });

  it("hydrate: true 回读完整条目（含正文与标签），命中顺序不变", async () => {
    await seedStore();
    await rebuildIndexFromStore(layout, db);
    const result = await searchMemory(db, { query: "测试", hydrate: true, layout });
    expect(ids(result)).toEqual(["mem-01", "mem-04", "mem-06", "mem-05"]);
    expect(result.issues).toEqual([]);
    expect(result.hits[0]?.entry).toStrictEqual(fixtureById("mem-01"));
    expect(result.hits.every((hit) => hit.entry !== undefined)).toBe(true);
  });

  it("损坏文件只跳过该条：其余命中照常返回，失败原因进 issues", async () => {
    await seedStore();
    await rebuildIndexFromStore(layout, db);
    await writeFile(
      resolveEntryFilePath(layout, fixtureById("mem-01")),
      "被外部编辑器写坏的内容，没有 frontmatter\n",
      "utf8",
    );

    const result = await searchMemory(db, { query: "测试", hydrate: true, layout });
    expect(ids(result)).toEqual(["mem-04", "mem-06", "mem-05"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.entryId).toBe("mem-01");
    expect(result.issues[0]?.error.code).toBe("frontmatter-syntax");
  });

  it("索引陈旧（文件已删、钩子漏调）：该条进 issues 报 entry-not-found，不整体失败", async () => {
    await seedStore();
    await rebuildIndexFromStore(layout, db);
    await rm(resolveEntryFilePath(layout, fixtureById("mem-04")));

    const result = await searchMemory(db, { query: "测试", hydrate: true, layout });
    expect(ids(result)).toEqual(["mem-01", "mem-06", "mem-05"]);
    expect(result.issues.map((issue) => issue.entryId)).toEqual(["mem-04"]);
    expect(result.issues[0]?.error.code).toBe("entry-not-found");
  });

  it("hydrate 对 FTS 路径同样生效", async () => {
    await seedStore();
    await rebuildIndexFromStore(layout, db);
    const result = await searchMemory(db, { query: "禁止修改", hydrate: true, layout });
    const [hit]: readonly (MemorySearchHit | undefined)[] = result.hits;
    expect(hit?.id).toBe("mem-02");
    expect(hit?.matchKind).toBe("fts");
    expect(hit?.entry).toStrictEqual(fixtureById("mem-02"));
  });
});
