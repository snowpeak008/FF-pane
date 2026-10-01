/**
 * T10.9：隐藏面板只读路径、索引分页、看板分列。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOpenableMarkdown,
  lexicalFfPanePath,
  listBriefFiles,
  PANEL_FILE_MAX_BYTES,
  PANEL_INDEX_MAX_BYTES,
  pageNewestFirst,
  readBriefFile,
  readPanelThreadIndex,
  resolveFfPaneFile,
} from "../src/main/workbench/panel-files";
import { type BoardMember, columnOf, groupTeamBoard } from "../src/shared/workbench/board";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-wb-panel-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(id: string, kind: "message" | "report" | "system"): string {
  return JSON.stringify({
    v: 1,
    id,
    ts: "2026-10-01T00:00:00.000Z",
    projectId: "proj",
    from: { windowId: "A", title: "总管", role: "manager" },
    to: { windowId: "B", title: "子", role: "worker" },
    kind,
    text: id,
    threadFile: "team.md",
  });
}

function member(partial: Partial<BoardMember> & Pick<BoardMember, "id" | "title">): BoardMember {
  return {
    role: "worker",
    permission: "edit",
    running: false,
    ...partial,
  };
}

describe("lexicalFfPanePath", () => {
  const root = "D:/proj";

  it("拒绝穿越、绝对路径和空路径", () => {
    expect(lexicalFfPanePath(root, "../secret").ok).toBe(false);
    expect(lexicalFfPanePath(root, ".ffpane/../outside.md").ok).toBe(false);
    expect(lexicalFfPanePath(root, "C:/Windows/notepad.exe").ok).toBe(false);
    expect(lexicalFfPanePath(root, "/etc/passwd").ok).toBe(false);
    expect(lexicalFfPanePath(root, ".ffpane").ok).toBe(false);
    expect(lexicalFfPanePath(root, "").ok).toBe(false);
  });

  it("把 briefs 收进项目 .ffpane", () => {
    const resolved = lexicalFfPanePath(root, "briefs/task.md");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.absolute.replace(/\\/g, "/")).toBe("D:/proj/.ffpane/briefs/task.md");
    }
  });
});

describe("面板文件", () => {
  it("按修改时间倒序列出 Markdown，并拒绝读出 briefs", async () => {
    const root = tempDir();
    const briefs = join(root, ".ffpane", "briefs");
    mkdirSync(briefs, { recursive: true });
    writeFileSync(join(briefs, "old.md"), "old");
    writeFileSync(join(briefs, "new.md"), "new");
    writeFileSync(join(briefs, "note.txt"), "skip");
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");
    utimesSync(join(briefs, "old.md"), older, older);
    utimesSync(join(briefs, "new.md"), newer, newer);

    const listed = await listBriefFiles(root);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.briefs.map((item) => item.name)).toEqual(["new.md", "old.md"]);
    }

    const read = await readBriefFile(root, ".ffpane/briefs/new.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.content).toBe("new");
      expect(read.truncated).toBe(false);
    }
    expect((await readBriefFile(root, ".ffpane/threads/index.jsonl")).ok).toBe(false);
    expect((await readBriefFile(root, "briefs/../../secret.md")).ok).toBe(false);
  });

  it("半写行被跳过，超长索引只保留尾部完整行，分页倒序", async () => {
    const root = tempDir();
    const threads = join(root, ".ffpane", "threads");
    mkdirSync(threads, { recursive: true });
    writeFileSync(
      join(threads, "index.jsonl"),
      `${record("m1", "message")}\n${record("r1", "report")}\n{"v":1,"id":"cut`,
      "utf8",
    );
    const index = await readPanelThreadIndex(root);
    expect(index.ok).toBe(true);
    if (index.ok) {
      expect(index.records.map((item) => item.id)).toEqual(["m1", "r1"]);
      expect(index.capped).toBe(false);
    }

    const big = tempDir();
    const bigThreads = join(big, ".ffpane", "threads");
    mkdirSync(bigThreads, { recursive: true });
    const tail = `\n${record("tail", "system")}\n{"v":1,"broken`;
    const pad = "x".repeat(PANEL_INDEX_MAX_BYTES);
    writeFileSync(join(bigThreads, "index.jsonl"), pad + tail, "utf8");
    const capped = await readPanelThreadIndex(big);
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.capped).toBe(true);
      expect(capped.records.map((item) => item.id)).toEqual(["tail"]);
    }

    const page = pageNewestFirst(["a", "b", "c"], 0, 2);
    expect(page.page).toEqual(["c", "b"]);
    expect(page.hasMore).toBe(true);
    const rest = pageNewestFirst(["a", "b", "c"], 2, 2);
    expect(rest.page).toEqual(["a"]);
    expect(rest.hasMore).toBe(false);
  });

  it("文件符号链接不能把 brief 读出 .ffpane", async () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, ".ffpane", "briefs"), { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    try {
      symlinkSync(join(outside, "secret.md"), join(root, ".ffpane", "briefs", "link.md"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return;
      }
      throw error;
    }
    const listed = await listBriefFiles(root);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.briefs.map((item) => item.name)).toEqual([]);
    }
    const linked = await resolveFfPaneFile(root, ".ffpane/briefs/link.md");
    expect(linked.ok).toBe(false);
  });

  it("junction 不能把读取带出 .ffpane", async () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, ".ffpane", "briefs"), { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    try {
      symlinkSync(outside, join(root, ".ffpane", "escape"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return;
      }
      throw error;
    }
    const escaped = await resolveFfPaneFile(root, ".ffpane/escape/secret.md");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) {
      expect(escaped.error).toContain("符号链接");
    }
  });

  it("只读 brief 前 256KB，截断点不拆开 UTF-8", async () => {
    const root = tempDir();
    const briefs = join(root, ".ffpane", "briefs");
    mkdirSync(briefs, { recursive: true });
    const head = Buffer.alloc(PANEL_FILE_MAX_BYTES - 1, 0x61);
    const file = Buffer.concat([head, Buffer.from("中TAILMARKER")]);
    writeFileSync(join(briefs, "big.md"), file);
    const read = await readBriefFile(root, ".ffpane/briefs/big.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.truncated).toBe(true);
      expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(PANEL_FILE_MAX_BYTES);
      expect(read.content.includes("TAILMARKER")).toBe(false);
      expect(read.content.includes("中")).toBe(false);
      expect(read.content.endsWith("a")).toBe(true);
    }
  });

  it("打开动作只接受真实的 .md，索引里的可执行文件名被丢掉", async () => {
    const root = tempDir();
    const threads = join(root, ".ffpane", "threads");
    mkdirSync(threads, { recursive: true });
    for (const name of ["payload.exe", "run.bat", "run.cmd", "link.lnk", "note.md"]) {
      writeFileSync(join(threads, name), "x");
    }
    for (const name of ["payload.exe", "run.bat", "run.cmd", "link.lnk"]) {
      const resolved = await resolveFfPaneFile(root, `.ffpane/threads/${name}`);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect((await assertOpenableMarkdown(resolved.absolute)).ok).toBe(false);
      }
    }
    const markdown = await resolveFfPaneFile(root, ".ffpane/threads/note.md");
    expect(markdown.ok).toBe(true);
    if (markdown.ok) {
      expect((await assertOpenableMarkdown(markdown.absolute)).ok).toBe(true);
    }

    writeFileSync(
      join(threads, "index.jsonl"),
      [
        record("keep", "message"),
        record("exe", "message").replace('"threadFile":"team.md"', '"threadFile":"payload.exe"'),
        record("up", "message").replace('"threadFile":"team.md"', '"threadFile":"../note.md"'),
        record("nested", "message").replace(
          '"threadFile":"team.md"',
          '"threadFile":"threads/note.md"',
        ),
      ].join("\n"),
      "utf8",
    );
    const index = await readPanelThreadIndex(root);
    expect(index.ok).toBe(true);
    if (index.ok) {
      expect(index.records.map((item) => item.id)).toEqual(["keep"]);
    }
  });
});

describe("groupTeamBoard", () => {
  it("按汇报状态分列，无汇报的运行中窗口算进行中", () => {
    expect(columnOf(member({ id: "a", title: "a", report: report("blocked", "1") }))).toBe(
      "blocked",
    );
    expect(columnOf(member({ id: "b", title: "b", running: true }))).toBe("progress");
    expect(columnOf(member({ id: "c", title: "c" }))).toBeUndefined();
    expect(columnOf(member({ id: "d", title: "d", report: report("done", "2") }))).toBe("done");
    expect(columnOf(member({ id: "e", title: "e", report: report("failed", "3") }))).toBe("failed");
  });

  it("管理者作分组标题，组内按汇报时间倒序，空组去掉", () => {
    const groups = groupTeamBoard([
      member({ id: "boss", title: "总管", role: "manager", running: true }),
      member({
        id: "late",
        title: "晚",
        parentWindowId: "boss",
        report: report("blocked", "2026-10-01T01:00:00.000Z"),
      }),
      member({
        id: "early",
        title: "早",
        parentWindowId: "boss",
        report: report("blocked", "2026-10-01T02:00:00.000Z"),
      }),
      member({ id: "idle", title: "闲置" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("总管");
    expect(groups[0]?.manager).toBe(true);
    expect(groups[0]?.columns.progress.map((item) => item.id)).toEqual(["boss"]);
    expect(groups[0]?.columns.blocked.map((item) => item.id)).toEqual(["early", "late"]);
    expect(groups[0]?.columns.done).toEqual([]);
  });
});

function report(status: "blocked" | "done" | "failed" | "progress", ts: string) {
  return { status, summary: status, ts };
}
