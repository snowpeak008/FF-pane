import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCategory, MemoryEntry, MemoryEntryId, MemoryStatus } from "@ff-pane/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeIndexDb,
  DEFAULT_BUSY_TIMEOUT_MS,
  deleteMemoryEntry,
  type IndexDbMigration,
  IndexDbVersionError,
  openIndexDb,
  quoteFtsQueryLiteral,
  readUserVersion,
  rebuildIndex,
  runMigrations,
  searchMemoryIndex,
  upsertMemoryEntry,
} from "../src/index.js";

/** 每个测试自理资源,afterEach 统一关库、删临时目录(Windows 下须先关再删)。 */
const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

function track(db: Database.Database): Database.Database {
  openDbs.push(db);
  return db;
}

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ff-pane-index-db-"));
  tempDirs.push(dir);
  return join(dir, "index.sqlite");
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    closeIndexDb(db);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/** 中英混合的固定语料,多个测试共用。 */
function fixtureEntries(): MemoryEntry[] {
  return [
    makeEntry({
      id: "mem-zh-lesson",
      category: "lesson",
      status: "active",
      title: "Windows 下的测试入口",
      body: "本项目必须用 pnpm 运行测试命令,npm test 在 Windows 下会挂",
      tags: ["测试命令", "windows"],
    }),
    makeEntry({
      id: "mem-zh-rule",
      category: "rule",
      status: "active",
      title: "遗留目录禁改",
      body: "src/legacy/ 目录禁止修改,历史包袱等待整体迁移",
    }),
    makeEntry({
      id: "mem-zh-state",
      category: "state",
      status: "candidate",
      title: "登录模块状态",
      body: "登录模块完成,Token 刷新有遗留 bug,测试命令暂时跳过该用例",
    }),
    makeEntry({
      id: "mem-en-decision",
      category: "decision",
      status: "active",
      title: "Storage engine decision",
      body: "Use SQLite with the build pipeline, not PostgreSQL",
      tags: ["sqlite", "storage"],
    }),
    makeEntry({
      id: "mem-en-archived",
      category: "decision",
      status: "archived",
      title: "Old build pipeline note",
      body: "The legacy build pipeline used webpack before the migration",
    }),
  ];
}

describe("index-db 连接基座", () => {
  it("openIndexDb 启用 WAL 并设置 busy_timeout,迁移到最新版本", () => {
    const db = track(openIndexDb({ filePath: makeTempDbPath() }));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    expect(readUserVersion(db)).toBe(1);
  });

  it("busy_timeout 可注入覆盖", () => {
    const db = track(openIndexDb({ filePath: ":memory:", busyTimeoutMs: 250 }));
    expect(db.pragma("busy_timeout", { simple: true })).toBe(250);
  });

  it("closeIndexDb 幂等,重复关闭不抛错", () => {
    const db = openIndexDb({ filePath: ":memory:" });
    closeIndexDb(db);
    expect(() => closeIndexDb(db)).not.toThrow();
    expect(db.open).toBe(false);
  });

  it("重新打开既有 DB 文件时数据仍在,且不重复建表", () => {
    const filePath = makeTempDbPath();
    const first = openIndexDb({ filePath });
    upsertMemoryEntry(first, makeEntry({ id: "mem-persist", body: "持久化验证正文" }));
    closeIndexDb(first);

    const second = track(openIndexDb({ filePath }));
    const hits = searchMemoryIndex(second, { match: quoteFtsQueryLiteral("持久化验证") });
    expect(hits.map((h) => h.id)).toEqual(["mem-persist"]);
  });
});

describe("index-db 迁移框架", () => {
  const stepOne: IndexDbMigration = {
    toVersion: 1,
    description: "建表 alpha",
    up: (db) => {
      db.exec("CREATE TABLE alpha (x INTEGER)");
    },
  };
  const stepTwo: IndexDbMigration = {
    toVersion: 2,
    description: "建表 beta(依赖 alpha 已存在)",
    up: (db) => {
      db.exec("INSERT INTO alpha (x) VALUES (1)");
      db.exec("CREATE TABLE beta (y INTEGER)");
    },
  };

  it("从 0 逐级升到最新,user_version 落位", () => {
    const db = track(new Database(":memory:"));
    const result = runMigrations(db, [stepOne, stepTwo]);
    expect(result).toEqual({ fromVersion: 0, toVersion: 2 });
    expect(readUserVersion(db)).toBe(2);
    expect(() => db.prepare("SELECT * FROM beta").all()).not.toThrow();
  });

  it("已在中间版本时只补执行缺失层级", () => {
    const db = track(new Database(":memory:"));
    runMigrations(db, [stepOne]);
    expect(readUserVersion(db)).toBe(1);

    // 若 stepOne 被重复执行,CREATE TABLE alpha 会因重名报错。
    const result = runMigrations(db, [stepOne, stepTwo]);
    expect(result).toEqual({ fromVersion: 1, toVersion: 2 });
    expect(readUserVersion(db)).toBe(2);
  });

  it("已是最新版本时重跑为空操作", () => {
    const db = track(new Database(":memory:"));
    runMigrations(db, [stepOne, stepTwo]);
    const again = runMigrations(db, [stepOne, stepTwo]);
    expect(again).toEqual({ fromVersion: 2, toVersion: 2 });
  });

  it("文件版本高于已知最新版本时抛 IndexDbVersionError 拒开", () => {
    const db = track(new Database(":memory:"));
    db.pragma("user_version = 7");
    expect(() => runMigrations(db, [stepOne, stepTwo])).toThrow(IndexDbVersionError);
    try {
      runMigrations(db, [stepOne, stepTwo]);
      expect.unreachable();
    } catch (thrown) {
      const error = thrown as IndexDbVersionError;
      expect(error.fileVersion).toBe(7);
      expect(error.latestKnownVersion).toBe(2);
    }
  });

  it("openIndexDb 对高版本 DB 文件拒开且不改动文件", () => {
    const filePath = makeTempDbPath();
    closeIndexDb(openIndexDb({ filePath }));

    const raw = new Database(filePath);
    raw.pragma("user_version = 99");
    raw.close();

    expect(() => openIndexDb({ filePath })).toThrow(IndexDbVersionError);

    const inspect = track(new Database(filePath));
    expect(readUserVersion(inspect)).toBe(99);
  });

  it("迁移中途失败时该层级整体回滚,已完成层级保留", () => {
    const db = track(new Database(":memory:"));
    const broken: IndexDbMigration = {
      toVersion: 2,
      description: "先建表后故意失败",
      up: (inner) => {
        inner.exec("CREATE TABLE gamma (z INTEGER)");
        throw new Error("迁移演习故障");
      },
    };
    expect(() => runMigrations(db, [stepOne, broken])).toThrow("迁移演习故障");
    expect(readUserVersion(db)).toBe(1);
    expect(() => db.prepare("SELECT * FROM gamma").all()).toThrow();
  });

  it("迁移表不从 1 连续递增时立即报错", () => {
    const db = track(new Database(":memory:"));
    const skipped: IndexDbMigration = { ...stepTwo, toVersion: 3 };
    expect(() => runMigrations(db, [stepOne, skipped])).toThrow(/迁移表损坏/);
  });
});

describe("memory-index 全文检索(R4:trigram 中文)", () => {
  it("中文关键词命中包含该词的 body", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("测试命令") });
    expect(hits.map((h) => h.id).sort()).toEqual(["mem-zh-lesson", "mem-zh-state"]);
  });

  it("中文子串命中长词内部片段(trigram 特性)", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    // "止修改" 是 "禁止修改" 的内部子串,词典分词无法命中,trigram 可以。
    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("止修改") });
    expect(hits.map((h) => h.id)).toEqual(["mem-zh-rule"]);
  });

  it("中文不存在的词不误命中", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());
    expect(searchMemoryIndex(db, { match: quoteFtsQueryLiteral("数据库分片") })).toEqual([]);
  });

  it("英文关键词命中且大小写不敏感", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const lower = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("pipeline") });
    expect(lower.map((h) => h.id).sort()).toEqual(["mem-en-archived", "mem-en-decision"]);

    const upper = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("PIPELINE") });
    expect(upper.map((h) => h.id).sort()).toEqual(["mem-en-archived", "mem-en-decision"]);
  });

  it("tags 参与检索", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("sqlite") });
    expect(hits.map((h) => h.id)).toContain("mem-en-decision");
  });

  it("BM25 排序:关键词密度高(含标题命中)的条目排在前", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, [
      makeEntry({
        id: "mem-dense",
        title: "错误处理约定",
        body: "错误处理必须走统一通道;错误处理禁止吞异常",
      }),
      makeEntry({
        id: "mem-sparse",
        title: "部署流程备忘",
        body: "部署脚本里有一段错误处理逻辑,其余步骤与错误无关,详见流水线配置说明文档",
      }),
    ]);

    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("错误处理") });
    expect(hits.map((h) => h.id)).toEqual(["mem-dense", "mem-sparse"]);
    const [first, second] = hits;
    expect(first !== undefined && second !== undefined && first.score < second.score).toBe(true);
  });

  it("limit 生效", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());
    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral("测试命令"), limit: 1 });
    expect(hits).toHaveLength(1);
  });

  it("quoteFtsQueryLiteral 把 FTS5 语法字符按字面处理", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, [makeEntry({ id: "mem-quote", body: '包含 "AND" 引号的正文片段' })]);

    const hits = searchMemoryIndex(db, { match: quoteFtsQueryLiteral('"AND" 引号') });
    expect(hits.map((h) => h.id)).toEqual(["mem-quote"]);
    // 未转义的裸语法词不会命中任何字面内容,也不该抛语法错误之外的行为——这里确认转义路径无异常即可。
    expect(() => searchMemoryIndex(db, { match: quoteFtsQueryLiteral("NEAR(") })).not.toThrow();
  });
});

describe("memory-index 过滤组合", () => {
  it("category 过滤", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const hits = searchMemoryIndex(db, {
      match: quoteFtsQueryLiteral("测试命令"),
      categories: ["lesson"],
    });
    expect(hits.map((h) => h.id)).toEqual(["mem-zh-lesson"]);
  });

  it("status 过滤", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const hits = searchMemoryIndex(db, {
      match: quoteFtsQueryLiteral("pipeline"),
      statuses: ["archived"],
    });
    expect(hits.map((h) => h.id)).toEqual(["mem-en-archived"]);
  });

  it("category + status 组合过滤(交集)", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const hits = searchMemoryIndex(db, {
      match: quoteFtsQueryLiteral("测试命令"),
      categories: ["lesson", "state"],
      statuses: ["candidate"],
    });
    expect(hits.map((h) => h.id)).toEqual(["mem-zh-state"]);
  });

  it("多值过滤为 OR 语义,空数组等同不过滤", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    rebuildIndex(db, fixtureEntries());

    const multi = searchMemoryIndex(db, {
      match: quoteFtsQueryLiteral("测试命令"),
      categories: ["lesson", "state"],
    });
    expect(multi.map((h) => h.id).sort()).toEqual(["mem-zh-lesson", "mem-zh-state"]);

    const empty = searchMemoryIndex(db, {
      match: quoteFtsQueryLiteral("测试命令"),
      categories: [],
    });
    expect(empty.map((h) => h.id).sort()).toEqual(["mem-zh-lesson", "mem-zh-state"]);
  });
});

describe("memory-index 单条原语与重建", () => {
  it("upsert 覆盖更新:旧词消失、新词可查,行数不膨胀", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    upsertMemoryEntry(db, makeEntry({ id: "mem-up", body: "初版正文包含旧关键词甲乙丙" }));
    upsertMemoryEntry(db, makeEntry({ id: "mem-up", body: "改版正文换成新关键词丁戊己" }));

    expect(searchMemoryIndex(db, { match: quoteFtsQueryLiteral("甲乙丙") })).toEqual([]);
    expect(
      searchMemoryIndex(db, { match: quoteFtsQueryLiteral("丁戊己") }).map((h) => h.id),
    ).toEqual(["mem-up"]);

    const count = db.prepare("SELECT COUNT(*) AS n FROM memory_entry").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("delete 移除索引行且幂等", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    const entry = makeEntry({ id: "mem-del", body: "待删除的检索正文" });
    upsertMemoryEntry(db, entry);
    deleteMemoryEntry(db, entry.id);
    expect(searchMemoryIndex(db, { match: quoteFtsQueryLiteral("待删除的检索") })).toEqual([]);
    expect(() => deleteMemoryEntry(db, entry.id)).not.toThrow();
  });

  it("rebuildIndex 清空重灌:旧条目出清,返回灌入条数", () => {
    const db = track(openIndexDb({ filePath: ":memory:" }));
    upsertMemoryEntry(db, makeEntry({ id: "mem-old", body: "重建前的旧条目残留验证" }));

    const next = [makeEntry({ id: "mem-new", body: "重建后的新条目正文" })];
    expect(rebuildIndex(db, next)).toBe(1);

    expect(searchMemoryIndex(db, { match: quoteFtsQueryLiteral("旧条目残留") })).toEqual([]);
    expect(
      searchMemoryIndex(db, { match: quoteFtsQueryLiteral("新条目正文") }).map((h) => h.id),
    ).toEqual(["mem-new"]);
  });

  it("删除 DB 文件后 rebuildIndex,查询结果与原索引完全一致(§8.4 可重建性)", () => {
    const entries = fixtureEntries();
    const queries: MemoryIndexSearchOptionsList = [
      { match: quoteFtsQueryLiteral("测试命令") },
      { match: quoteFtsQueryLiteral("pipeline"), statuses: ["active"] },
      { match: quoteFtsQueryLiteral("登录模块"), categories: ["state"] },
    ];

    const filePath = makeTempDbPath();
    const first = openIndexDb({ filePath });
    rebuildIndex(first, entries);
    const before = queries.map((q) => searchMemoryIndex(first, q));
    closeIndexDb(first);

    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${filePath}${suffix}`;
      if (existsSync(target)) {
        unlinkSync(target);
      }
    }
    expect(existsSync(filePath)).toBe(false);

    const second = track(openIndexDb({ filePath }));
    rebuildIndex(second, entries);
    const after = queries.map((q) => searchMemoryIndex(second, q));

    expect(after).toEqual(before);
    expect(before.some((hits) => hits.length > 0)).toBe(true);
  });
});

type MemoryIndexSearchOptionsList = Parameters<typeof searchMemoryIndex>[1][];
