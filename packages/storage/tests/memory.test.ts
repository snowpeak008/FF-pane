/**
 * W1.2c 单测：受控 frontmatter 编解码 + 记忆条目落位/移动 + state 快照。
 * 全部走 mkdtemp 临时目录真实读写（沿用 fs.test.ts 约定），
 * 覆盖中文标题/正文/标签的完整往返（开发计划 §12 风险 R5）。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryEntryId, PlanVersion, TaskId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FrontmatterDocument, ProjectLayout } from "../src/index.js";
import {
  decodeMemoryEntryFile,
  encodeFrontmatterDocument,
  encodeMemoryEntryFile,
  initProjectLayout,
  listEntries,
  loadEntry,
  loadStateSnapshot,
  MemoryStateCategoryError,
  parseFrontmatterDocument,
  saveEntry,
  saveStateSnapshot,
  updateEntryStatus,
} from "../src/index.js";

let tempRoot: string;
let layout: ProjectLayout;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-memory-"));
  layout = await initProjectLayout(join(tempRoot, "记忆·项目"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const CREATED_AT = Date.parse("2026-08-01T08:00:00.000Z");
const UPDATED_AT = Date.parse("2026-08-02T09:30:00.500Z");

const baseEntry: MemoryEntry = {
  id: "mem-0001" as MemoryEntryId,
  category: "decision",
  title: "存储选型：SQLite（FTS5），不引入向量库",
  body: "## 理由\n\n- 单机、零运维\n- 短文本 + 分类标签，全文检索够用\n\n中文引号“测试”与 emoji 🀄 混排。",
  status: "active",
  source: { kind: "task", taskId: "task-42" as TaskId },
  confidence: "high",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  supersedes: "mem-0000" as MemoryEntryId,
  tags: ["架构", "数据库, 检索", "SQLite"],
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...baseEntry, ...overrides } as MemoryEntry;
}

function expectOk<T, E extends Error>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败: ${result.error.message}`);
  }
  return result.value;
}

function expectErr<T, E extends Error>(
  result: { ok: true; value: T } | { ok: false; error: E },
): E {
  if (result.ok) {
    throw new Error("预期失败结果，实际成功");
  }
  return result.error;
}

describe("受控 frontmatter 编解码器（类别无关，Phase 5 复用）", () => {
  it("标量 / 数组 / 引号字符串 / 数字 / 布尔完整往返", () => {
    const doc: FrontmatterDocument = {
      frontmatter: {
        name: "音智体美劳",
        quoted: 'a, [b]: "c"\n换行与\t制表符',
        numeric_string: "007",
        count: 42,
        ratio: -0.5,
        enabled: true,
        disabled: false,
        empty_list: [],
        tags: ["中文", "带, 逗号", "x[1]", 3, true],
      },
      body: "第一行\n\n第三行\n",
    };
    const text = encodeFrontmatterDocument(doc);
    const parsed = parseFrontmatterDocument(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toStrictEqual(doc);
    }
    // 与数字/布尔同形的字符串必须落为引号语法，往返后类型不漂移
    expect(text).toContain('numeric_string: "007"');
    expect(text).toContain("count: 42");
  });

  it("正文逐字符往返：空正文、空行开头、结尾多换行", () => {
    for (const body of ["", "\n以空行开头", "结尾双换行\n\n", "# 正文里的标题\n---\n分隔线"]) {
      const text = encodeFrontmatterDocument({ frontmatter: { k: "v" }, body });
      const parsed = parseFrontmatterDocument(text);
      expect(parsed.ok && parsed.value.body).toBe(body);
    }
  });

  it("拒绝：缺开头 / 缺收尾分隔线，报行号", () => {
    const noOpen = parseFrontmatterDocument("id: a\n---\n");
    expect(!noOpen.ok && noOpen.issue.line).toBe(1);

    const noClose = parseFrontmatterDocument("---\nid: a\n");
    expect(noClose.ok).toBe(false);
    if (!noClose.ok) {
      expect(noClose.issue.reason).toContain("收尾");
    }
  });

  it("拒绝：嵌套块（key: 空值 + 缩进行），受控子集不支持嵌套", () => {
    const nested = parseFrontmatterDocument("---\nparent:\n  child: 1\n---\n");
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.issue.line).toBe(2);
    }

    const indented = parseFrontmatterDocument("---\n  indented: 1\n---\n");
    expect(indented.ok).toBe(false);
    if (!indented.ok) {
      expect(indented.issue.reason).toContain("嵌套");
    }
  });

  it("拒绝：重复 key、空行、非法 key、未闭合数组、嵌套数组", () => {
    const cases: readonly [string, string][] = [
      ["---\nid: a\nid: b\n---\n", "重复"],
      ["---\nid: a\n\nk: v\n---\n", "空行"],
      ["---\n中文键: v\n---\n", "非法 key"],
      ["---\ntags: [a, b\n---\n", "数组缺少收尾"],
      ["---\ntags: [a, [b]]\n---\n", "嵌套数组"],
    ];
    for (const [text, keyword] of cases) {
      const parsed = parseFrontmatterDocument(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issue.reason).toContain(keyword);
      }
    }
  });

  it("CRLF 输入按 LF 规范化解析（外部编辑器容错）", () => {
    const parsed = parseFrontmatterDocument("---\r\nid: a\r\n---\r\n\r\n# 标题\r\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.frontmatter).toStrictEqual({ id: "a" });
      expect(parsed.value.body).toBe("# 标题\n");
    }
  });
});

describe("记忆条目文件编解码（entry-file）", () => {
  it("encode 产物人类可读：ISO 时间、source 编码、标题行、数组标签", () => {
    const text = encodeMemoryEntryFile(baseEntry);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("id: mem-0001");
    expect(text).toContain("source: task:task-42");
    expect(text).toContain("created: 2026-08-01T08:00:00.000Z");
    expect(text).toContain("updated: 2026-08-02T09:30:00.500Z");
    expect(text).toContain('tags: [架构, "数据库, 检索", SQLite]');
    expect(text).toContain("\n# 存储选型：SQLite（FTS5），不引入向量库\n");
  });

  it("decode(encode(entry)) 全字段保真（中文 + emoji + supersedes + 带逗号标签）", () => {
    const decoded = expectOk(decodeMemoryEntryFile(encodeMemoryEntryFile(baseEntry), "内存.md"));
    expect(decoded).toStrictEqual(baseEntry);
  });

  it("可选字段缺省与 plan 来源：无 supersedes / 无 tags / 空正文往返", () => {
    const minimal = makeEntry({
      id: "mem-plan" as MemoryEntryId,
      body: "",
      source: { kind: "plan", planVersion: 3 as PlanVersion },
      supersedes: undefined,
      tags: undefined,
    });
    const { supersedes: _s, tags: _t, ...rest } = minimal;
    const cleaned = rest as MemoryEntry;
    const text = encodeMemoryEntryFile(cleaned);
    expect(text).toContain("source: plan:3");
    expect(text).not.toContain("supersedes");
    expect(text).not.toContain("tags");
    expect(expectOk(decodeMemoryEntryFile(text, "内存.md"))).toStrictEqual(cleaned);
  });

  it("未知 frontmatter key 容忍：读入忽略、不拒读", () => {
    const text = encodeMemoryEntryFile(baseEntry).replace(
      "confidence: high\n",
      "confidence: high\nx_note: 用户手加的扩展键\n",
    );
    const decoded = expectOk(decodeMemoryEntryFile(text, "内存.md"));
    expect(decoded).toStrictEqual(baseEntry);
  });

  it("必填字段缺失 / 非法枚举 / 非法 source / 非法时间 → invalid-entry 带路径与字段", () => {
    const original = encodeMemoryEntryFile(baseEntry);
    const cases: readonly [string, string, string][] = [
      ["confidence: high\n", "", "confidence"],
      ["status: active\n", "status: 已通过\n", "status"],
      ["source: task:task-42\n", "source: task_42\n", "source"],
      ["source: task:task-42\n", "source: plan:0\n", "source"],
      ["created: 2026-08-01T08:00:00.000Z\n", "created: 昨天\n", "created"],
      ['tags: [架构, "数据库, 检索", SQLite]\n', "tags: 架构\n", "tags"],
    ];
    for (const [find, replacement, field] of cases) {
      const error = expectErr(decodeMemoryEntryFile(original.replace(find, replacement), "坏.md"));
      expect(error.code).toBe("invalid-entry");
      if (error.code === "invalid-entry") {
        expect(error.field).toBe(field);
        expect(error.path).toBe("坏.md");
        expect(error.message).toContain(field);
        expect(error.message).toContain("坏.md");
      }
    }
  });

  it("正文缺一级标题行 → invalid-entry(title)；仅标题无正文合法", () => {
    const noTitle = encodeMemoryEntryFile(baseEntry).replace("\n# 存储选型", "\n存储选型");
    const error = expectErr(decodeMemoryEntryFile(noTitle, "坏.md"));
    expect(error.code === "invalid-entry" && error.field).toBe("title");

    const titleOnly = makeEntry({ body: "" });
    const decoded = expectOk(decodeMemoryEntryFile(encodeMemoryEntryFile(titleOnly), "好.md"));
    expect(decoded.body).toBe("");
  });
});

describe("落位与移动（saveEntry / loadEntry / updateEntryStatus）", () => {
  it("active 按类别落 decisions/；loadEntry 跨目录寻址全字段读回", async () => {
    const savedPath = await saveEntry(layout, baseEntry);
    expect(savedPath).toBe(join(layout.memoryCategoryDirs.decision, "mem-0001.md"));
    expect(await readdir(layout.memoryCategoryDirs.decision)).toEqual(["mem-0001.md"]);

    const loaded = expectOk(await loadEntry(layout, baseEntry.id));
    expect(loaded).toStrictEqual(baseEntry);
  });

  it("candidate 一律落 candidates/，与类别无关", async () => {
    const candidate = makeEntry({
      id: "mem-c1" as MemoryEntryId,
      category: "rule",
      status: "candidate",
    });
    const savedPath = await saveEntry(layout, candidate);
    expect(savedPath).toBe(join(layout.memoryCandidatesDir, "mem-c1.md"));
    expect(await readdir(layout.memoryCategoryDirs.rule)).toEqual([]);
    expect(expectOk(await loadEntry(layout, candidate.id))).toStrictEqual(candidate);
  });

  it("supersedes 链：新条目替代旧条目后双双可读，链条完整", async () => {
    const old = makeEntry({
      id: "mem-老决策" as MemoryEntryId,
      status: "archived",
      supersedes: undefined,
    });
    const { supersedes: _s, ...oldCleaned } = old;
    await saveEntry(layout, oldCleaned as MemoryEntry);
    const next = makeEntry({ id: "mem-新决策" as MemoryEntryId, supersedes: oldCleaned.id });
    await saveEntry(layout, next);

    const loadedNext = expectOk(await loadEntry(layout, next.id));
    expect(loadedNext.supersedes).toBe(oldCleaned.id);
    const loadedOld = expectOk(await loadEntry(layout, oldCleaned.id));
    expect(loadedOld.supersedes).toBeUndefined();
  });

  it("updateEntryStatus candidate→active：先写新址再删旧址，其余字段保真", async () => {
    const candidate = makeEntry({
      id: "mem-c2" as MemoryEntryId,
      category: "lesson",
      status: "candidate",
    });
    await saveEntry(layout, candidate);

    const approvedAt = Date.parse("2026-08-03T00:00:00.000Z");
    const updated = expectOk(await updateEntryStatus(layout, candidate.id, "active", approvedAt));
    expect(updated.status).toBe("active");
    expect(updated.updatedAt).toBe(approvedAt);

    expect(await readdir(layout.memoryCandidatesDir)).toEqual([]);
    expect(await readdir(layout.memoryCategoryDirs.lesson)).toEqual(["mem-c2.md"]);
    expect(expectOk(await loadEntry(layout, candidate.id))).toStrictEqual({
      ...candidate,
      status: "active",
      updatedAt: approvedAt,
    });
  });

  it("active→archived 同目录原地改写（archived 不设单独目录）", async () => {
    await saveEntry(layout, baseEntry);
    const archivedAt = Date.parse("2026-08-04T00:00:00.000Z");
    await updateEntryStatus(layout, baseEntry.id, "archived", archivedAt);

    const filePath = join(layout.memoryCategoryDirs.decision, "mem-0001.md");
    expect(await readdir(layout.memoryCategoryDirs.decision)).toEqual(["mem-0001.md"]);
    expect(await readFile(filePath, "utf8")).toContain("status: archived");
  });

  it("重写按规范形态再生成：手加的未知 key 在状态流转后不保留", async () => {
    const candidate = makeEntry({ id: "mem-c3" as MemoryEntryId, status: "candidate" });
    await saveEntry(layout, candidate);
    const candidatePath = join(layout.memoryCandidatesDir, "mem-c3.md");
    const withExtra = (await readFile(candidatePath, "utf8")).replace(
      "confidence: high\n",
      "confidence: high\nx_note: 手加扩展键\n",
    );
    await writeFile(candidatePath, withExtra, "utf8");

    expectOk(await updateEntryStatus(layout, candidate.id, "active"));
    const rewritten = await readFile(join(layout.memoryCategoryDirs.decision, "mem-c3.md"), "utf8");
    expect(rewritten).not.toContain("x_note");
  });

  it("saveEntry / updateEntryStatus 拒绝 category=state（走快照 API）", async () => {
    const stateEntry = makeEntry({ id: "mem-state" as MemoryEntryId, category: "state" });
    await expect(saveEntry(layout, stateEntry)).rejects.toThrow(MemoryStateCategoryError);
    await expect(saveEntry(layout, stateEntry)).rejects.toMatchObject({ code: "state-category" });
  });

  it("loadEntry 不存在 → entry-not-found，带 id 与查找目录", async () => {
    const error = expectErr(await loadEntry(layout, "mem-不存在" as MemoryEntryId));
    expect(error.code).toBe("entry-not-found");
    if (error.code === "entry-not-found") {
      expect(error.entryId).toBe("mem-不存在");
      expect(error.searchedDirs).toContain(layout.memoryCandidatesDir);
    }
  });

  it("文件名与 frontmatter id 不一致 → invalid-entry(id)", async () => {
    const mismatchPath = join(layout.memoryCategoryDirs.decision, "mem-9999.md");
    await writeFile(mismatchPath, encodeMemoryEntryFile(baseEntry), "utf8");
    const error = expectErr(await loadEntry(layout, "mem-9999" as MemoryEntryId));
    expect(error.code === "invalid-entry" && error.field).toBe("id");
  });

  it("损坏 frontmatter 拒读：loadEntry 返回 frontmatter-syntax，带路径与行号", async () => {
    const corruptPath = join(layout.memoryCategoryDirs.rule, "mem-坏.md");
    await writeFile(corruptPath, "---\nid: mem-坏\nnested:\n  a: 1\n---\n\n# 标题\n", "utf8");
    const error = expectErr(await loadEntry(layout, "mem-坏" as MemoryEntryId));
    expect(error.code).toBe("frontmatter-syntax");
    if (error.code === "frontmatter-syntax") {
      expect(error.path).toBe(corruptPath);
      expect(error.line).toBe(3);
    }
  });
});

describe("listEntries 过滤与容错", () => {
  async function seedFourEntries(): Promise<{
    activeDecision: MemoryEntry;
    archivedDecision: MemoryEntry;
    activeRule: MemoryEntry;
    candidateLesson: MemoryEntry;
  }> {
    const activeDecision = makeEntry({ id: "mem-a" as MemoryEntryId, updatedAt: UPDATED_AT + 40 });
    const archivedDecision = makeEntry({
      id: "mem-b" as MemoryEntryId,
      status: "archived",
      updatedAt: UPDATED_AT + 30,
    });
    const activeRule = makeEntry({
      id: "mem-c" as MemoryEntryId,
      category: "rule",
      updatedAt: UPDATED_AT + 20,
    });
    const candidateLesson = makeEntry({
      id: "mem-d" as MemoryEntryId,
      category: "lesson",
      status: "candidate",
      updatedAt: UPDATED_AT + 10,
    });
    for (const entry of [activeDecision, archivedDecision, activeRule, candidateLesson]) {
      await saveEntry(layout, entry);
    }
    return { activeDecision, archivedDecision, activeRule, candidateLesson };
  }

  it("无过滤返回全部，按 updatedAt 降序；status/category 过滤含 archived 排除", async () => {
    const seeded = await seedFourEntries();

    const all = await listEntries(layout);
    expect(all.issues).toEqual([]);
    expect(all.entries.map((entry) => entry.id)).toEqual(["mem-a", "mem-b", "mem-c", "mem-d"]);

    const active = await listEntries(layout, { status: "active" });
    expect(active.entries.map((entry) => entry.id)).toEqual(["mem-a", "mem-c"]);

    const archived = await listEntries(layout, { status: "archived" });
    expect(archived.entries).toStrictEqual([seeded.archivedDecision]);

    const decisions = await listEntries(layout, { category: "decision" });
    expect(decisions.entries.map((entry) => entry.id)).toEqual(["mem-a", "mem-b"]);

    const candidateLessons = await listEntries(layout, { category: "lesson", status: "candidate" });
    expect(candidateLessons.entries).toStrictEqual([seeded.candidateLesson]);
  });

  it("损坏文件不阻断列表：正常条目照常返回，问题文件进 issues", async () => {
    await seedFourEntries();
    const corruptPath = join(layout.memoryCategoryDirs.rule, "mem-坏.md");
    await writeFile(corruptPath, "随手写的纯 Markdown，没有 frontmatter\n", "utf8");

    const result = await listEntries(layout);
    expect(result.entries).toHaveLength(4);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(corruptPath);
    expect(result.issues[0]?.error.code).toBe("frontmatter-syntax");
  });
});

describe("state 快照（单文件覆盖更新）", () => {
  it("保存 → 读回 → 覆盖更新，state.md 单文件", async () => {
    const first = {
      title: "当前状态",
      body: "登录模块完成，Token 刷新有遗留 bug。",
      updatedAt: CREATED_AT,
    };
    await saveStateSnapshot(layout, first);
    expect(expectOk(await loadStateSnapshot(layout))).toStrictEqual(first);

    const second = {
      title: "当前状态（更新）",
      body: "Token 刷新 bug 已修复；开始接支付。\n\n- 下一步：对账\n",
      updatedAt: UPDATED_AT,
    };
    await saveStateSnapshot(layout, second);
    expect(expectOk(await loadStateSnapshot(layout))).toStrictEqual(second);

    const raw = await readFile(layout.memoryStateFile, "utf8");
    expect(raw.startsWith("---\nupdated: 2026-08-02T09:30:00.500Z\n---\n")).toBe(true);
    expect(raw).toContain("# 当前状态（更新）");
    // 快照不参与条目状态流转：无 id / status / source
    expect(raw).not.toContain("status:");
    expect(raw).not.toContain("id:");
  });

  it("尚未生成快照 → not-found 常态分支；损坏 frontmatter 拒读", async () => {
    const missing = expectErr(await loadStateSnapshot(layout));
    expect(missing.code).toBe("not-found");

    await writeFile(layout.memoryStateFile, "手写的纯 Markdown 状态\n", "utf8");
    const corrupt = expectErr(await loadStateSnapshot(layout));
    expect(corrupt.code).toBe("frontmatter-syntax");
  });
});
