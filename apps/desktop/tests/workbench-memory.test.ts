/**
 * T10.10：记忆 MCP 的授权、消毒、上限，以及写入后旧注入与索引仍走现有存储。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectMemoryForRole } from "@ff-pane/core";
import type { MemoryEntry, MemoryEntryId, WorkbenchOpenedBy } from "@ff-pane/shared";
import {
  entryFileName,
  listEntries,
  resolveProjectLayout,
  saveEntry,
  updateEntryStatus,
} from "@ff-pane/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryIndexService } from "../src/main/memory-index";
import {
  executeWorkbenchTool,
  resetToolCallBuckets,
  type ToolWindowView,
  type WorkbenchToolDeps,
} from "../src/main/workbench/mcp-tools";
import {
  MEMORY_ADD_BODY_MAX_CHARS,
  MEMORY_ADD_TITLE_MAX_CHARS,
  MEMORY_SEARCH_FILE_CAP_NOTE,
  MEMORY_SEARCH_FILE_MAX_BYTES,
  MEMORY_SEARCH_MAX_HITS,
  packMemorySearchHits,
} from "../src/main/workbench/memory-policy";
import {
  addCallerProjectMemory,
  searchCallerProjectMemory,
} from "../src/main/workbench/project-memory";
import { WORKBENCH_MCP_TOOL_NAMES } from "../src/mcp/workbench-tools";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-wb-mem-"));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  resetToolCallBuckets();
});

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function view(
  root: string,
  id: string,
  title: string,
  role: ToolWindowView["role"],
  openedBy: WorkbenchOpenedBy,
  sanitizeLocked = false,
): ToolWindowView {
  return {
    id,
    title,
    projectId: root.endsWith("beta") ? "proj-b" : "proj-a",
    projectName: "演示",
    projectRoot: root,
    role,
    permission: "edit",
    running: true,
    openedBy,
    sanitizeLocked,
  };
}

function harness(
  rootA: string,
  rootB: string,
): {
  views: Record<string, ToolWindowView>;
  granted: Set<string>;
  added: { root: string; entry: MemoryEntry }[];
  searched: { root: string; query: string }[];
  byRoot: Map<string, MemoryEntry[]>;
  deps: WorkbenchToolDeps;
  setNow: (value: number) => void;
} {
  let now = 1_700_000_000_000;
  const views: Record<string, ToolWindowView> = {
    A: view(rootA, "A", "总管", "manager", "user"),
    B: view(rootA, "B", "子", "worker", { windowId: "A" }),
    U: view(rootA, "U", "用户窗", "none", "user"),
    L: view(rootA, "L", "被洗", "manager", "user", true),
    G: view(rootA, "G", "子管理", "manager", { windowId: "A" }),
    X: view(rootB, "X", "别的项目", "manager", "user"),
  };
  const granted = new Set(["A", "L", "G"]);
  const added: { root: string; entry: MemoryEntry }[] = [];
  const searched: { root: string; query: string }[] = [];
  const byRoot = new Map<string, MemoryEntry[]>();
  const deps: WorkbenchToolDeps = {
    now: () => now,
    snapshot: () => ({}),
    isManagerGranted: (id) => granted.has(id),
    describe: async (id) => views[id],
    setRole: async () => ({ ok: true, role: "manager", delivery: "skipped" }),
    openChild: async () => ({ ok: false, error: "测试里不启动。" }),
    remind: () => undefined,
    publishInbox: () => undefined,
    getCursor: async () => undefined,
    setCursor: async () => undefined,
    readOutput: async () => ({ running: false, status: "未运行" }),
    closeDescendant: {
      findTerminalId: () => undefined,
      killTerminal: () => undefined,
      dropQueue: () => undefined,
      revokeToken: () => undefined,
      releaseRuntime: () => undefined,
      closeRegistered: () => undefined,
      readLayouts: async () => ({}),
      saveLayout: async () => undefined,
      publishClosed: () => undefined,
    },
    openPanel: () => undefined,
    openCanvas: async () => ({ ok: true as const, relativePath: ".ffpane/canvas/a.png" }),
    deleteCanvasFile: async () => ({ ok: true as const }),
    searchProjectMemory: async (projectRoot, query) => {
      searched.push({ root: projectRoot, query });
      return (byRoot.get(projectRoot) ?? []).filter(
        (entry) => entry.title.includes(query) || entry.body.includes(query),
      );
    },
    addProjectMemory: async (projectRoot, entry) => {
      const list = byRoot.get(projectRoot) ?? [];
      list.push(entry);
      byRoot.set(projectRoot, list);
      added.push({ root: projectRoot, entry });
    },
    setModelEffort: async () => ({ ok: false as const, error: "unused" }),
  };
  return {
    views,
    granted,
    added,
    searched,
    byRoot,
    deps,
    setNow: (value) => {
      now = value;
    },
  };
}

async function call(
  deps: WorkbenchToolDeps,
  caller: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean; json?: unknown }> {
  const result = await executeWorkbenchTool(caller, name, args, deps);
  let json: unknown;
  if (result.isError !== true) {
    json = JSON.parse(result.text) as unknown;
  }
  return { text: result.text, isError: result.isError === true, json };
}

describe("记忆工具授权", () => {
  it("工具名已挂上", () => {
    expect(WORKBENCH_MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining(["ffpane_memory_search", "ffpane_memory_add"]),
    );
  });

  it("管理者、用户窗口可写；子窗口、被清洗窗口不可写；检索不跨项目", async () => {
    const rootA = tempDir();
    const rootB = join(tempDir(), "beta");
    const { deps, added, searched, byRoot } = harness(rootA, rootB);
    const draft = { category: "lesson", title: "口令甲", body: "只在甲项目" };

    expect((await call(deps, "A", "ffpane_memory_add", draft)).isError).toBe(false);
    expect(
      (await call(deps, "U", "ffpane_memory_add", { ...draft, title: "口令乙" })).isError,
    ).toBe(false);
    expect(
      (await call(deps, "G", "ffpane_memory_add", { ...draft, title: "口令丙" })).isError,
    ).toBe(false);

    const child = await call(deps, "B", "ffpane_memory_add", draft);
    expect(child.isError).toBe(true);
    expect(child.text).toContain("ffpane_report");

    const locked = await call(deps, "L", "ffpane_memory_add", draft);
    expect(locked.isError).toBe(true);
    expect(locked.text).toContain("清洗");

    expect(added.map((item) => item.entry.title)).toEqual(["口令甲", "口令乙", "口令丙"]);
    expect(added.every((item) => item.root === rootA)).toBe(true);

    byRoot.set(rootB, [
      {
        ...added[0]?.entry,
        id: "mem-other" as MemoryEntryId,
        title: "乙项目秘密",
      } as MemoryEntry,
    ]);
    const fromA = await call(deps, "B", "ffpane_memory_search", {
      query: "口令甲",
      projectRoot: rootB,
    });
    expect(fromA.isError).toBe(false);
    expect(searched.at(-1)?.root).toBe(rootA);
    expect(fromA.text).toContain("口令甲");
    expect(fromA.text).not.toContain("乙项目秘密");

    const fromB = await call(deps, "X", "ffpane_memory_search", { query: "乙项目秘密" });
    expect(searched.at(-1)?.root).toBe(rootB);
    expect(fromB.text).toContain("乙项目秘密");
    expect(fromB.text).not.toContain("口令甲");
  });
});

describe("记忆内容消毒与上限", () => {
  it("去掉控制字符、拒绝超长和空内容，并限制写入频率", async () => {
    const rootA = tempDir();
    const { deps, added, setNow } = harness(rootA, tempDir());
    const saved = await call(deps, "A", "ffpane_memory_add", {
      category: "rule",
      title: "标\u0001题\n续",
      body: "第一行\r\n第二\u0007行",
    });
    expect(saved.isError).toBe(false);
    const entry = added[0]?.entry;
    expect(entry?.title).toBe("标题续");
    expect(entry?.body).toBe("第一行\n第二行");
    expect(entry?.status).toBe("candidate");
    expect(entry?.confidence).toBe("low");
    expect(entry?.source).toEqual({
      kind: "workbench",
      windowId: "A",
      windowTitle: "总管",
      role: "manager",
    });

    expect(
      (
        await call(deps, "A", "ffpane_memory_add", {
          category: "state",
          title: "快照",
          body: "不行",
        })
      ).text,
    ).toContain("category");
    expect(
      (
        await call(deps, "A", "ffpane_memory_add", {
          category: "lesson",
          title: "\u0001",
          body: "还有字",
        })
      ).text,
    ).toContain("标题不能为空");
    expect(
      (
        await call(deps, "A", "ffpane_memory_add", {
          category: "lesson",
          title: "有标题",
          body: "\u0007",
        })
      ).text,
    ).toContain("正文不能为空");
    expect(
      (
        await call(deps, "A", "ffpane_memory_add", {
          category: "lesson",
          title: "甲".repeat(MEMORY_ADD_TITLE_MAX_CHARS + 1),
          body: "短",
        })
      ).text,
    ).toContain(String(MEMORY_ADD_TITLE_MAX_CHARS));
    expect(
      (
        await call(deps, "A", "ffpane_memory_add", {
          category: "lesson",
          title: "短",
          body: "乙".repeat(MEMORY_ADD_BODY_MAX_CHARS + 1),
        })
      ).text,
    ).toContain(String(MEMORY_ADD_BODY_MAX_CHARS));

    const again = await call(deps, "A", "ffpane_memory_add", {
      category: "lesson",
      title: "太快",
      body: "还没到间隔",
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("频繁");
    expect(added).toHaveLength(1);

    setNow(1_700_000_010_000);
    const later = await call(deps, "A", "ffpane_memory_add", {
      category: "lesson",
      title: "可以了",
      body: "间隔已过",
    });
    expect(later.isError).toBe(false);
    expect(added).toHaveLength(2);
  });

  it("同一窗口并发添加只放行一笔", async () => {
    const rootA = tempDir();
    const { deps, added } = harness(rootA, tempDir());
    const [first, second] = await Promise.all([
      call(deps, "A", "ffpane_memory_add", {
        category: "rule",
        title: "并发甲",
        body: "一",
      }),
      call(deps, "A", "ffpane_memory_add", {
        category: "rule",
        title: "并发乙",
        body: "二",
      }),
    ]);
    const succeeded = [first, second].filter((item) => !item.isError);
    const rejected = [first, second].filter((item) => item.isError);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.text).toContain("频繁");
    expect(added).toHaveLength(1);
  });

  it("写入失败也占住间隔", async () => {
    const rootA = tempDir();
    const base = harness(rootA, tempDir());
    const deps: WorkbenchToolDeps = {
      ...base.deps,
      addProjectMemory: async () => {
        throw new Error("disk");
      },
    };
    const failed = await call(deps, "A", "ffpane_memory_add", {
      category: "rule",
      title: "失败",
      body: "磁盘",
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("写入项目记忆失败");
    const again = await call(deps, "A", "ffpane_memory_add", {
      category: "rule",
      title: "接着写",
      body: "应该被挡住",
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("频繁");
    expect(base.added).toHaveLength(0);
  });

  it("检索条数和总大小有上限，空白查询拒绝", async () => {
    const rootA = tempDir();
    const { deps, byRoot } = harness(rootA, tempDir());
    expect((await call(deps, "B", "ffpane_memory_search", { query: "  " })).isError).toBe(true);

    const many: MemoryEntry[] = [];
    for (let index = 0; index < MEMORY_SEARCH_MAX_HITS + 1; index += 1) {
      many.push({
        id: `mem-${index}` as MemoryEntryId,
        category: "lesson",
        title: `条${index}`,
        body: "短",
        status: "candidate",
        confidence: "low",
        source: { kind: "user_manual" },
        createdAt: index,
        updatedAt: index,
      });
    }
    byRoot.set(rootA, many);
    const capped = await call(deps, "B", "ffpane_memory_search", { query: "条" });
    const cappedBody = capped.json as { hits: unknown[]; truncated: boolean };
    expect(cappedBody.hits).toHaveLength(MEMORY_SEARCH_MAX_HITS);
    expect(cappedBody.truncated).toBe(true);

    const huge = packMemorySearchHits(
      [
        {
          ...many[0],
          id: "mem-huge" as MemoryEntryId,
          title: "大",
          body: "字".repeat(20_000),
        } as MemoryEntry,
      ],
      20,
      64,
    );
    expect(huge.truncated).toBe(true);
    expect(huge.hits[0]?.body.length).toBeLessThan(64);
  });
});

describe("写入后旧注入与索引", () => {
  it("候选不进注入，索引能查到；通过后旧注入能选中", async () => {
    const root = tempDir();
    const other = tempDir();
    const index = createMemoryIndexService({
      listProviders: async () => [],
      revealSecret: async () => undefined,
      log: () => undefined,
    });
    try {
      const layout = resolveProjectLayout(root);
      const existing: MemoryEntry = {
        id: "mem-old" as MemoryEntryId,
        category: "decision",
        title: "旧决定口令",
        body: "一直用 pnpm",
        status: "active",
        source: { kind: "user_manual" },
        confidence: "high",
        createdAt: 1,
        updatedAt: 1,
      };
      await saveEntry(layout, existing);
      await index.search({
        projectRoot: root,
        query: "旧决定口令",
        statuses: ["active", "candidate"],
      });

      const base = harness(root, other);
      const deps: WorkbenchToolDeps = {
        ...base.deps,
        addProjectMemory: async (projectRoot, entry) => {
          await addCallerProjectMemory(index, projectRoot, entry);
        },
        searchProjectMemory: (projectRoot, query, limit) =>
          searchCallerProjectMemory(index, projectRoot, query, limit),
      };

      const added = await call(deps, "A", "ffpane_memory_add", {
        category: "rule",
        title: "新规则口令",
        body: "测试要隔离",
      });
      expect(added.isError).toBe(false);
      const id = (added.json as { id: string }).id;

      const activeBefore = (await listEntries(layout, { status: "active" })).entries;
      expect(activeBefore.map((entry) => entry.id)).toContain("mem-old");
      expect(activeBefore.map((entry) => entry.id)).not.toContain(id);
      expect(
        selectMemoryForRole("planner", activeBefore).some((entry) => entry.id === "mem-old"),
      ).toBe(true);

      const found = await call(deps, "B", "ffpane_memory_search", { query: "新规则口令" });
      expect(found.isError).toBe(false);
      expect(found.text).toContain("新规则口令");
      expect(found.text).toContain("总管");
      const leaked = await call(deps, "X", "ffpane_memory_search", { query: "新规则口令" });
      expect(leaked.text).not.toContain("新规则口令");

      const loaded = (await listEntries(layout)).entries.find((entry) => entry.id === id);
      expect(loaded?.status).toBe("candidate");
      expect(loaded?.source.kind).toBe("workbench");

      const approved = await updateEntryStatus(layout, id as MemoryEntryId, "active", 50);
      expect(approved.ok).toBe(true);
      if (!approved.ok) {
        return;
      }
      await index.entrySaved(root, approved.value);
      const activeAfter = (await listEntries(layout, { status: "active" })).entries;
      expect(selectMemoryForRole("planner", activeAfter).some((entry) => entry.id === id)).toBe(
        true,
      );
      const indexed = await index.search({
        projectRoot: root,
        query: "新规则口令",
        statuses: ["active"],
      });
      expect(indexed.hits.map((hit) => hit.id)).toContain(id);
    } finally {
      index.close();
    }
  });

  it("文件已改成 archived、索引仍是候选时，检索不返回", async () => {
    const root = tempDir();
    const index = createMemoryIndexService({
      listProviders: async () => [],
      revealSecret: async () => undefined,
      log: () => undefined,
    });
    try {
      const layout = resolveProjectLayout(root);
      const base = harness(root, tempDir());
      const deps: WorkbenchToolDeps = {
        ...base.deps,
        addProjectMemory: async (projectRoot, entry) => {
          await addCallerProjectMemory(index, projectRoot, entry);
        },
        searchProjectMemory: (projectRoot, query, limit) =>
          searchCallerProjectMemory(index, projectRoot, query, limit),
      };
      const added = await call(deps, "A", "ffpane_memory_add", {
        category: "rule",
        title: "归档口令",
        body: "不该再被查到",
      });
      expect(added.isError).toBe(false);
      const id = (added.json as { id: string }).id as MemoryEntryId;
      const stillIndexed = await index.search({
        projectRoot: root,
        query: "归档口令",
        statuses: ["candidate"],
      });
      expect(stillIndexed.hits.map((hit) => hit.id)).toContain(id);

      const archived = await updateEntryStatus(layout, id, "archived", 80);
      expect(archived.ok).toBe(true);
      const stale = await index.search({
        projectRoot: root,
        query: "归档口令",
        statuses: ["candidate"],
      });
      expect(stale.hits.map((hit) => hit.id)).toContain(id);
      const visible = await searchCallerProjectMemory(index, root, "归档口令", 20);
      expect(visible.map((entry) => entry.id)).not.toContain(id);
      expect(visible.some((entry) => entry.status === "archived")).toBe(false);

      const viaTool = await call(deps, "B", "ffpane_memory_search", { query: "归档口令" });
      expect(viaTool.isError).toBe(false);
      expect(viaTool.text).not.toContain("归档口令");
    } finally {
      index.close();
    }
  });

  it("超过读取上限的记忆只带回开头并说明，上限内的仍是整份正文", async () => {
    const root = tempDir();
    const index = createMemoryIndexService({
      listProviders: async () => [],
      revealSecret: async () => undefined,
      log: () => undefined,
    });
    try {
      await addCallerProjectMemory(index, root, {
        id: "mem-small-cap" as MemoryEntryId,
        category: "rule",
        title: "普通口令",
        body: "完整正文应原样返回",
        status: "candidate",
        confidence: "low",
        source: { kind: "user_manual" },
        createdAt: 1,
        updatedAt: 1,
      });
      const largeId = await addCallerProjectMemory(index, root, {
        id: "mem-large-cap" as MemoryEntryId,
        category: "rule",
        title: "超限口令",
        body: "开头还能看见",
        status: "candidate",
        confidence: "low",
        source: { kind: "user_manual" },
        createdAt: 2,
        updatedAt: 2,
      });
      const layout = resolveProjectLayout(root);
      const marker = "OVERSIZE-TAIL-MARKER";
      await appendFile(
        join(layout.memoryCandidatesDir, entryFileName(largeId)),
        `${"x".repeat(MEMORY_SEARCH_FILE_MAX_BYTES)}${marker}`,
      );

      const smallHits = await searchCallerProjectMemory(index, root, "普通口令", 20);
      expect(smallHits).toHaveLength(1);
      expect(smallHits[0]?.body).toBe("完整正文应原样返回");
      expect(smallHits[0]?.body).not.toContain(MEMORY_SEARCH_FILE_CAP_NOTE);

      const largeHits = await searchCallerProjectMemory(index, root, "超限口令", 20);
      expect(largeHits).toHaveLength(1);
      expect(largeHits[0]?.title).toBe("超限口令");
      expect(largeHits[0]?.status).toBe("candidate");
      expect(largeHits[0]?.body.startsWith(`${MEMORY_SEARCH_FILE_CAP_NOTE}\n\n`)).toBe(true);
      expect(largeHits[0]?.body).toContain("开头还能看见");
      expect(largeHits[0]?.body).not.toContain(marker);
    } finally {
      index.close();
    }
  });
});
