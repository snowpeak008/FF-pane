/**
 * T11.8b：Claude 旧记忆 → 项目记忆候选。只测转换，不碰磁盘和索引。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateClaudeMemories,
  parseClaudeMemory,
  readClaudeMemoryFiles,
  toMemoryCandidate,
} from "../src/main/workbench/claude-memory-migrate";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const FEEDBACK = `---
name: feedback-acceptance-player-entry
description: 验收必须查"玩家能不能触发"，只看逻辑和单测会漏
metadata:
  type: feedback
---

2026-10-31 发现……

**Why:** 入口落在单与单之间。

**How to apply:** 写说明时把玩家入口列为必做项。
`;

describe("parseClaudeMemory", () => {
  it("读 frontmatter 的 name、description、metadata.type 和正文", () => {
    const parsed = parseClaudeMemory("feedback-acceptance-player-entry", FEEDBACK);
    expect(parsed.name).toBe("feedback-acceptance-player-entry");
    expect(parsed.description).toContain("玩家能不能触发");
    expect(parsed.type).toBe("feedback");
    expect(parsed.body).toContain("**Why:**");
    expect(parsed.body.startsWith("2026-10-31")).toBe(true);
  });

  it("没有 frontmatter 时整篇当正文，名字用文件名", () => {
    const parsed = parseClaudeMemory("plain", "第一行\n第二行");
    expect(parsed.name).toBe("plain");
    expect(parsed.description).toBe("");
    expect(parsed.type).toBe("");
    expect(parsed.body).toBe("第一行\n第二行");
  });

  it("frontmatter 没写完不吞正文", () => {
    const parsed = parseClaudeMemory("broken", "---\nname: x\n\n正文在这里");
    expect(parsed.body).toContain("正文在这里");
  });
});

describe("toMemoryCandidate", () => {
  it("按类型分到项目记忆的类别，一律是待审核候选", () => {
    const parsed = parseClaudeMemory("a", FEEDBACK);
    const entry = toMemoryCandidate(parsed, 1000);
    expect(entry?.category).toBe("rule");
    expect(entry?.status).toBe("candidate");
    expect(entry?.confidence).toBe("low");
    expect(entry?.id).toBe("claude-a");
    expect(entry?.title).toContain("玩家能不能触发");
    expect(entry?.createdAt).toBe(1000);
  });

  it("类型对不上时落到经验类", () => {
    const parsed = parseClaudeMemory("b", "---\ndescription: 某条笔记\n---\n正文");
    expect(toMemoryCandidate(parsed, 1)?.category).toBe("lesson");
  });

  it("没内容的不转", () => {
    expect(toMemoryCandidate(parseClaudeMemory("c", "---\n---\n"), 1)).toBeUndefined();
  });
});

describe("migrateClaudeMemories", () => {
  it("排序稳定、跳过已有的和空的", () => {
    const files = [
      { slug: "z-last", text: "---\ndescription: 最后\n---\n正文" },
      { slug: "a-first", text: "---\ndescription: 最先\n---\n正文" },
      { slug: "empty", text: "---\n---\n" },
      { slug: "taken", text: "---\ndescription: 已有\n---\n正文" },
    ];
    const result = migrateClaudeMemories(files, new Set(["claude-taken"]), 5);
    expect(result.entries.map((entry) => entry.id)).toEqual(["claude-a-first", "claude-z-last"]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.join()).toContain("empty");
    expect(result.skipped.join()).toContain("taken");
  });

  it("搬过一次以后（条目已存在）再搬不会重复生成", () => {
    const files = [{ slug: "one", text: "---\ndescription: 一条\n---\n正文" }];
    const first = migrateClaudeMemories(files, new Set(), 1);
    expect(first.entries).toHaveLength(1);
    const ids = new Set(first.entries.map((entry) => String(entry.id)));
    const second = migrateClaudeMemories(files, ids, 2);
    expect(second.entries).toHaveLength(0);
  });
});

describe("readClaudeMemoryFiles", () => {
  it("只读 .md、跳过 MEMORY.md 索引和读不了的", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ffpane-claude-mem-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.md"), "---\ndescription: 甲\n---\n正文甲");
    writeFileSync(join(dir, "MEMORY.md"), "- [甲](a.md)\n");
    writeFileSync(join(dir, "notes.txt"), "不是记忆");
    mkdirSync(join(dir, "subdir.md"));
    const files = await readClaudeMemoryFiles(dir);
    expect(files.map((file) => file.slug)).toEqual(["a"]);
    expect(files[0]?.text).toContain("正文甲");
  });

  it("目录不在返回空，不抛错", async () => {
    expect(await readClaudeMemoryFiles(join(tmpdir(), "ffpane-not-there-xyz"))).toEqual([]);
  });
});
