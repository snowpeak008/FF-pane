/**
 * T5.1 单测：习惯（共享记忆）条目文件编解码 + 落位/移动/启用 + 草稿校验。
 * 全部走 mkdtemp 临时全局根真实读写；覆盖中文 content、三种来源往返、
 * 分类迁移、损坏文件进 issues、文件名安全（开发计划 §12 风险 R5）。
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HabitEntry, HabitEntryId, MemoryEntryId, ProjectId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GlobalLayout } from "../src/index.js";
import {
  decodeHabitEntryFile,
  deleteHabit,
  encodeHabitEntryFile,
  HabitValidationError,
  initGlobalLayout,
  listHabits,
  loadHabit,
  saveHabit,
  setHabitEnabled,
  updateHabitStatus,
  validateHabitDraft,
} from "../src/index.js";

let tempRoot: string;
let layout: GlobalLayout;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-habits-"));
  layout = await initGlobalLayout(join(tempRoot, "习惯·根"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const CREATED_AT = Date.parse("2026-08-01T08:00:00.000Z");
const UPDATED_AT = Date.parse("2026-08-02T09:30:00.500Z");

const baseEntry: HabitEntry = {
  id: "hab-0001" as HabitEntryId,
  category: "workflow",
  content: "任何改动前先跑一遍现有测试；先出方案要我确认，再动手写代码。",
  status: "active",
  enabled: true,
  source: { kind: "user_manual" },
  importance: 80,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

function makeEntry(overrides: Partial<HabitEntry> = {}): HabitEntry {
  return { ...baseEntry, ...overrides } as HabitEntry;
}

function expectOk<T, E extends Error>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败: ${result.error.message}`);
  }
  return result.value;
}

describe("习惯条目文件编解码", () => {
  it("user_manual 来源逐字段往返（含中文 content）", () => {
    const text = encodeHabitEntryFile(baseEntry);
    const decoded = expectOk(decodeHabitEntryFile(text, "x.md"));
    expect(decoded).toEqual(baseEntry);
  });

  it("distilled 来源携带溯源字段往返", () => {
    const entry = makeEntry({
      category: "environment",
      source: {
        kind: "distilled",
        sourceProject: "project-abc123" as ProjectId,
        sourceEntryId: "mem-9f" as MemoryEntryId,
      },
      status: "candidate",
      enabled: false,
      importance: 10,
    });
    const decoded = expectOk(decodeHabitEntryFile(encodeHabitEntryFile(entry), "x.md"));
    expect(decoded).toEqual(entry);
  });

  it("observed 来源往返", () => {
    const entry = makeEntry({ source: { kind: "observed" }, status: "candidate" });
    const decoded = expectOk(decodeHabitEntryFile(encodeHabitEntryFile(entry), "x.md"));
    expect(decoded.source).toEqual({ kind: "observed" });
  });

  it("enabled 与 importance 以布尔 / 数字写入 frontmatter", () => {
    const text = encodeHabitEntryFile(makeEntry({ enabled: false, importance: 42 }));
    expect(text).toContain("enabled: false");
    expect(text).toContain("importance: 42");
  });

  it("缺失必填字段 / 非法枚举 → invalid-entry", () => {
    const noEnabled =
      "---\nid: hab-1\ncategory: tech\nstatus: active\nsource: user_manual\nimportance: 5\ncreated: 2026-08-01T00:00:00.000Z\nupdated: 2026-08-01T00:00:00.000Z\n---\n\nx\n";
    const r1 = decodeHabitEntryFile(noEnabled, "x.md");
    expect(r1.ok).toBe(false);

    const badCategory = encodeHabitEntryFile(baseEntry).replace("workflow", "架构决定");
    const r2 = decodeHabitEntryFile(badCategory, "x.md");
    expect(r2.ok).toBe(false);
  });

  it("非法来源编码 → invalid-entry", () => {
    const bad = encodeHabitEntryFile(baseEntry).replace("user_manual", "distilled:onlyproject");
    expect(decodeHabitEntryFile(bad, "x.md").ok).toBe(false);
  });

  it("空 content → invalid-entry", () => {
    const empty =
      "---\nid: hab-1\ncategory: tech\nstatus: active\nsource: user_manual\nenabled: true\nimportance: 5\ncreated: 2026-08-01T00:00:00.000Z\nupdated: 2026-08-01T00:00:00.000Z\n---\n";
    expect(decodeHabitEntryFile(empty, "x.md").ok).toBe(false);
  });
});

describe("习惯落位 / 读取 / 列举", () => {
  it("saveHabit 落到分类目录，loadHabit 读回", async () => {
    await saveHabit(layout, baseEntry);
    const files = await readdir(layout.habitCategoryDirs.workflow);
    expect(files).toContain("hab-0001.md");
    const loaded = expectOk(await loadHabit(layout, baseEntry.id));
    expect(loaded).toEqual(baseEntry);
  });

  it("分类变更 = 先写新址再删旧址（无残留）", async () => {
    await saveHabit(layout, baseEntry);
    const moved = makeEntry({ category: "tech", updatedAt: UPDATED_AT + 1000 });
    await saveHabit(layout, moved);
    expect(await readdir(layout.habitCategoryDirs.workflow)).not.toContain("hab-0001.md");
    expect(await readdir(layout.habitCategoryDirs.tech)).toContain("hab-0001.md");
    const loaded = expectOk(await loadHabit(layout, baseEntry.id));
    expect(loaded.category).toBe("tech");
  });

  it("updateHabitStatus / setHabitEnabled 改写并刷新 updatedAt", async () => {
    await saveHabit(layout, makeEntry({ status: "candidate", enabled: true }));
    const activated = expectOk(await updateHabitStatus(layout, baseEntry.id, "active", 999));
    expect(activated.status).toBe("active");
    expect(activated.updatedAt).toBe(999);
    const disabled = expectOk(await setHabitEnabled(layout, baseEntry.id, false, 1000));
    expect(disabled.enabled).toBe(false);
    expect(disabled.updatedAt).toBe(1000);
  });

  it("deleteHabit 幂等（不存在返回 false）", async () => {
    expect(await deleteHabit(layout, baseEntry.id)).toBe(false);
    await saveHabit(layout, baseEntry);
    expect(await deleteHabit(layout, baseEntry.id)).toBe(true);
    expect((await loadHabit(layout, baseEntry.id)).ok).toBe(false);
  });

  it("listHabits 按 category / status / enabled 过滤，损坏文件进 issues", async () => {
    await saveHabit(layout, makeEntry({ id: "hab-a" as HabitEntryId, category: "workflow" }));
    await saveHabit(
      layout,
      makeEntry({ id: "hab-b" as HabitEntryId, category: "tech", status: "candidate" }),
    );
    await saveHabit(
      layout,
      makeEntry({ id: "hab-c" as HabitEntryId, category: "tech", enabled: false }),
    );
    // 投放一个损坏文件
    await writeFile(join(layout.habitCategoryDirs.tech, "hab-bad.md"), "not frontmatter", "utf8");

    const all = await listHabits(layout);
    expect(all.entries).toHaveLength(3);
    expect(all.issues.length).toBeGreaterThanOrEqual(1);

    const tech = await listHabits(layout, { category: "tech" });
    expect(tech.entries.map((e) => e.id).sort()).toEqual(["hab-b", "hab-c"]);

    const candidates = await listHabits(layout, { status: "candidate" });
    expect(candidates.entries.map((e) => e.id)).toEqual(["hab-b"]);

    const disabled = await listHabits(layout, { enabled: false });
    expect(disabled.entries.map((e) => e.id)).toEqual(["hab-c"]);
  });
});

describe("习惯草稿校验", () => {
  const draft = {
    category: "tech" as const,
    content: "优先 TypeScript",
    status: "active" as const,
    enabled: true,
    source: { kind: "user_manual" as const },
    importance: 50,
  };

  it("合法草稿通过", () => {
    expect(() => validateHabitDraft(draft)).not.toThrow();
  });

  it("空 content / 非法分类 / 越界 importance / 缺溯源均抛 HabitValidationError", () => {
    expect(() => validateHabitDraft({ ...draft, content: "  " })).toThrow(HabitValidationError);
    expect(() =>
      // @ts-expect-error 故意传非法分类，验证运行时守卫
      validateHabitDraft({ ...draft, category: "架构" }),
    ).toThrow(HabitValidationError);
    expect(() => validateHabitDraft({ ...draft, importance: 999 })).toThrow(HabitValidationError);
    expect(() =>
      validateHabitDraft({
        ...draft,
        // @ts-expect-error 缺溯源字段
        source: { kind: "distilled" },
      }),
    ).toThrow(HabitValidationError);
  });
});
