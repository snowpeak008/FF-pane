/**
 * T10.19：近况覆盖、四行不齐不叫醒、消息不含详细记录全文、路径必须在 briefs 内。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkbenchAuthNode } from "@ff-pane/core";
import type { WorkbenchRole } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBriefFile, writeStatusFile } from "../src/main/workbench/brief-files";
import {
  executeWorkbenchTool,
  resetToolCallBuckets,
  type ToolWindowView,
  type WorkbenchToolDeps,
} from "../src/main/workbench/mcp-tools";
import { buildSupervisorWake } from "../src/main/workbench/status-handoff";
import { readThreadIndex } from "../src/main/workbench/thread-store";

const roots: string[] = [];

const FOUR = ["结论：做完。已跑 lint，通过。", "改了：src/a.ts", "还没做：无", "要决定：无"].join(
  "\n",
);

const DETAIL = "详细记录全文。命令输出 pnpm lint 的整段日志 MARKER-9f3a 不要出现在消息里。";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-status-"));
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

function node(id: string, role: WorkbenchRole, parent?: string): WorkbenchAuthNode {
  return {
    id,
    permission: "edit",
    role,
    openedBy: parent === undefined ? "user" : { windowId: parent },
    ...(parent !== undefined ? { parentWindowId: parent } : {}),
  };
}

function view(
  root: string,
  id: string,
  title: string,
  role: WorkbenchRole,
  parent?: string,
): ToolWindowView {
  return {
    id,
    title,
    projectId: "proj-1",
    projectName: "演示",
    projectRoot: root,
    role,
    permission: "edit",
    running: true,
    openedBy: parent === undefined ? "user" : { windowId: parent },
    sanitizeLocked: false,
    ...(parent !== undefined ? { parentWindowId: parent, parentTitle: "总管" } : {}),
  };
}

function harness(root: string): {
  reminders: { windowId: string; text: string }[];
  deps: WorkbenchToolDeps;
} {
  const views: Record<string, ToolWindowView> = {
    A: view(root, "A", "总管", "manager"),
    S: view(root, "S", "监管", "supervisor", "A"),
    W: view(root, "W", "执行", "worker", "S"),
    M: view(root, "M", "下级管理", "manager", "S"),
  };
  const tree: Record<string, WorkbenchAuthNode> = {
    A: node("A", "manager"),
    S: node("S", "supervisor", "A"),
    W: node("W", "worker", "S"),
    M: node("M", "manager", "S"),
  };
  const reminders: { windowId: string; text: string }[] = [];
  const deps: WorkbenchToolDeps = {
    now: () => 1_700_000_000_000,
    snapshot: () => tree,
    isManagerGranted: (id) => id === "A",
    describe: async (id) => views[id],
    setRole: async () => ({ ok: true, role: "none", delivery: "skipped" }),
    openChild: async () => ({ ok: false, error: "测试里不启动。" }),
    remind: (windowId, textForCount) => {
      reminders.push({ windowId, text: textForCount(1) });
    },
    publishInbox: () => undefined,
    getCursor: async () => undefined,
    setCursor: async () => undefined,
    readOutput: async () => ({ running: true, status: "运行中", text: "" }),
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
    searchProjectMemory: async () => [],
    addProjectMemory: async () => undefined,
    setModelEffort: async () => ({ ok: false as const, error: "unused" }),
  };
  return { reminders, deps };
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

describe("监管者交接", () => {
  it("近况覆盖而不是追加", async () => {
    const root = tempDir();
    const first = await writeStatusFile({
      projectRoot: root,
      name: "near.md",
      content: "第一页近况\n",
    });
    const second = await writeStatusFile({
      projectRoot: root,
      name: "near.md",
      content: "第二页\r\n只有这一页",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const stored = readFileSync(second.absolutePath, "utf8");
    expect(stored).toBe("第二页\n只有这一页\n");
    expect(stored).not.toContain("第一页");
    expect(stored.includes("\r")).toBe(false);

    const { deps } = harness(root);
    const viaTool = await call(deps, "S", "ffpane_write_status", {
      name: "near.md",
      content: "第三页",
    });
    expect(viaTool.isError).toBe(false);
    expect(readFileSync(join(root, ".ffpane", "briefs", "near.md"), "utf8")).toBe("第三页\n");
  });

  it("四行不齐不产生叫醒管理者的消息", async () => {
    const root = tempDir();
    const detail = await writeBriefFile({ projectRoot: root, name: "detail.md", content: DETAIL });
    expect(detail.ok).toBe(true);
    if (!detail.ok) {
      return;
    }
    const { deps, reminders } = harness(root);
    const incomplete = await call(deps, "S", "ffpane_report", {
      status: "done",
      summary: `结论：做完了\n改了：src/a.ts\n还没做：无\n要决定：无\n${DETAIL}`,
      briefPath: ".ffpane/briefs/near.md",
      detailPath: detail.relativePath,
    });
    expect(incomplete.isError).toBe(false);
    expect(incomplete.json).toMatchObject({ delivered: false });
    expect(incomplete.text).not.toContain("MARKER-9f3a");
    expect(reminders).toEqual([]);
    expect(await readThreadIndex(root)).toEqual([]);

    const missingRun = buildSupervisorWake({
      statusPath: ".ffpane/briefs/near.md",
      statusText: "结论：做完\n改了：无\n还没做：无\n要决定：无",
      detailText: DETAIL,
    });
    expect(missingRun).toEqual({ ok: true, wake: false });
    expect(missingRun).not.toHaveProperty("text");
  });

  it("消息正文不含详细记录全文", async () => {
    const root = tempDir();
    const detail = await writeBriefFile({ projectRoot: root, name: "detail.md", content: DETAIL });
    const status = await writeStatusFile({ projectRoot: root, name: "near.md", content: FOUR });
    expect(detail.ok && status.ok).toBe(true);
    if (!detail.ok || !status.ok) {
      return;
    }
    const wake = buildSupervisorWake({
      statusPath: status.relativePath,
      detailPath: detail.relativePath,
      statusText: FOUR,
      detailText: DETAIL,
    });
    expect(wake.ok && wake.wake).toBe(true);
    if (!wake.ok || !wake.wake) {
      return;
    }
    expect(wake.text).toContain("近况：.ffpane/briefs/near.md");
    expect(wake.text).toContain("详细记录：.ffpane/briefs/detail.md");
    expect(wake.text).toContain("结论：做完。已跑 lint，通过。");
    expect(wake.text).not.toContain(DETAIL);
    expect(wake.text).not.toContain("MARKER-9f3a");

    const { deps, reminders } = harness(root);
    const reported = await call(deps, "S", "ffpane_report", {
      status: "progress",
      summary: FOUR,
      briefPath: status.relativePath,
      detailPath: detail.relativePath,
    });
    expect(reported.isError).toBe(false);
    expect(reported.json).toMatchObject({ status: "done" });
    const records = await readThreadIndex(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe(wake.text);
    expect(records[0]?.text).not.toContain(DETAIL);
    expect(JSON.stringify(records)).not.toContain("MARKER-9f3a");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.text).not.toContain(DETAIL);
    expect(reminders[0]?.text).not.toContain("已跑 lint");
  });

  it("路径必须在 .ffpane/briefs/ 里", async () => {
    const root = tempDir();
    const outside = await writeStatusFile({
      projectRoot: root,
      name: "../outside.md",
      content: "越界",
    });
    expect(outside.ok).toBe(false);

    for (const statusPath of [
      "README.md",
      "../secret.md",
      ".ffpane/briefs/../x.md",
      "D:/outside/note.md",
    ]) {
      const wake = buildSupervisorWake({ statusPath, statusText: FOUR, detailText: DETAIL });
      expect(wake.ok, statusPath).toBe(false);
      expect(wake).not.toHaveProperty("text");
    }

    const absolute = buildSupervisorWake({
      statusPath: "D:/proj/.ffpane/briefs/near.md",
      statusText: FOUR,
    });
    expect(absolute.ok && absolute.wake).toBe(true);
    if (absolute.ok && absolute.wake) {
      expect(absolute.text.startsWith("近况：.ffpane/briefs/near.md")).toBe(true);
      expect(absolute.text).not.toContain("D:/proj");
    }

    const { deps, reminders } = harness(root);
    const rejected = await call(deps, "S", "ffpane_report", {
      status: "done",
      summary: FOUR,
      briefPath: "README.md",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain(".ffpane/briefs/");
    expect(reminders).toEqual([]);
    expect(await readThreadIndex(root)).toEqual([]);
  });
});
