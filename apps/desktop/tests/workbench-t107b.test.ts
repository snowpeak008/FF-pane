/**
 * T10.7b：管理权恢复、关闭后代、线程尾部、终端文本。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkbenchAuthNode } from "@ff-pane/core";
import type { ProjectWorkbenchLayout } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import { closeDescendantWindow } from "../src/main/workbench/close-descendant";
import { decideManagerGrantRestore } from "../src/main/workbench/manager-grant";
import {
  clampReadOutputBytes,
  stripTerminalControls,
  takeUtf8Tail,
} from "../src/main/workbench/output-text";
import { readThreadIndexTail, threadsDir } from "../src/main/workbench/thread-store";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-wb-t107b-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("decideManagerGrantRestore", () => {
  it("顶层用户管理者续接视为重新授权", () => {
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: false,
      }),
    ).toBe("user-reauth");
  });

  it("父级已授权时子管理者继承，否则待恢复", () => {
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: { windowId: "parent" },
        parentWindowId: "parent",
        parentRole: "manager",
        parentGranted: true,
        alreadyGranted: false,
      }),
    ).toBe("inherit");
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: { windowId: "parent" },
        parentWindowId: "parent",
        parentRole: "manager",
        parentGranted: false,
        alreadyGranted: false,
      }),
    ).toBe("pending");
  });

  it("断环后 openedBy 不是用户时不重新授权，已授予只清显示", () => {
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: { windowId: "gone" },
        parentGranted: false,
        alreadyGranted: false,
      }),
    ).toBe("none");
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: true,
      }),
    ).toBe("already");
    expect(
      decideManagerGrantRestore({
        role: "worker",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: false,
      }),
    ).toBe("none");
  });

  it("清洗锁住的窗口续接不重新授权，除非界面改过角色", () => {
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: false,
        sanitizeLocked: true,
      }),
    ).toBe("none");
    expect(
      decideManagerGrantRestore({
        role: "manager",
        openedBy: "user",
        parentGranted: false,
        alreadyGranted: false,
        sanitizeLocked: true,
        userRoleSet: true,
      }),
    ).toBe("user-reauth");
  });
});

describe("closeDescendantWindow", () => {
  it("吊销令牌、子窗口 parentClosed，并在团队记录写入系统行", async () => {
    const root = tempDir();
    const registry = createWorkbenchAuthRegistry();
    const tree: Record<string, WorkbenchAuthNode> = {
      A: { id: "A", permission: "edit", role: "manager", openedBy: "user" },
      B: {
        id: "B",
        permission: "edit",
        role: "worker",
        openedBy: { windowId: "A" },
        parentWindowId: "A",
      },
      C: {
        id: "C",
        permission: "edit",
        role: "worker",
        openedBy: { windowId: "B" },
        parentWindowId: "B",
      },
    };
    for (const node of Object.values(tree)) {
      registry.upsert(node, "proj-1" as never);
    }
    registry.grantManager("A");
    const layouts = new Map<string, ProjectWorkbenchLayout>();
    layouts.set("proj-1", {
      projectId: "proj-1" as never,
      tabs: [{ id: "tab", title: "Tab", root: { type: "leaf", windowId: "A" } }],
      activeTabId: "tab",
      focusedWindowId: "A",
      maximizedWindowId: null,
      windows: {
        A: pane("A"),
        B: pane("B", "A"),
        C: pane("C", "B"),
      },
    });
    const revoked: string[] = [];
    const killed: string[] = [];
    const closed = await closeDescendantWindow(
      party("A", "总管", "manager", root),
      party("B", "子", "worker", root),
      tree,
      Date.parse("2026-10-01T00:00:00.000Z"),
      {
        findTerminalId: (id) => (id === "B" ? "term-b" : undefined),
        killTerminal: (id) => {
          killed.push(id);
        },
        dropQueue: () => undefined,
        revokeToken: (id) => {
          revoked.push(id);
        },
        releaseRuntime: () => undefined,
        closeRegistered: (id) => {
          registry.closeRegistered(id);
        },
        readLayouts: async () => Object.fromEntries(layouts),
        saveLayout: async (next) => {
          layouts.set(next.projectId, next);
        },
        publishClosed: () => undefined,
      },
    );
    expect(closed).toEqual({ ok: true });
    expect(killed).toEqual(["term-b"]);
    expect(revoked).toEqual(["B"]);
    expect(registry.get("B")).toBeUndefined();
    expect(registry.get("C")?.parentClosed).toBe(true);
    expect(registry.get("C")?.permission).toBe("edit");
    expect(layouts.get("proj-1")?.windows["B"]).toBeUndefined();
    expect(layouts.get("proj-1")?.windows["C"]?.parentClosed).toBe(true);
    const files = readdirSync(threadsDir(root));
    const markdown = files.find((name) => name.endsWith(".md"));
    expect(markdown).toBeDefined();
    const body = readFileSync(join(threadsDir(root), markdown ?? ""), "utf8");
    expect(body).toContain("系统");
    expect(body).toContain("关闭了「子」");
  });
});

describe("readThreadIndexTail", () => {
  it("大文件只保留尾部记录", async () => {
    const root = tempDir();
    await mkdir(threadsDir(root), { recursive: true });
    const lines = [recordLine("HEAD-MARKER")];
    for (let index = 0; index < 2000; index += 1) {
      lines.push(recordLine(index === 1999 ? "TAIL-MARKER" : `m-${index}`));
    }
    writeFileSync(join(threadsDir(root), "index.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const tail = await readThreadIndexTail(root);
    expect(tail.some((item) => item.id === "TAIL-MARKER")).toBe(true);
    expect(tail.some((item) => item.id === "HEAD-MARKER")).toBe(false);
    expect(tail.length).toBeLessThanOrEqual(400);
  });
});

describe("终端输出裁剪", () => {
  it("夹紧上限并去掉 ANSI", () => {
    expect(clampReadOutputBytes(undefined)).toBe(8192);
    expect(clampReadOutputBytes(0)).toBe(8192);
    expect(clampReadOutputBytes(100_000)).toBe(32_768);
    const stripped = stripTerminalControls("a\u001b[31mRED\u001b[0m\u001b]0;title\u0007\u0001b");
    expect(stripped).toBe("aREDb");
    const tail = takeUtf8Tail(`x${"中".repeat(10)}`, 4);
    expect(tail.endsWith("中")).toBe(true);
    expect(Buffer.from(tail, "utf8").byteLength).toBeLessThanOrEqual(4);
  });
});

function party(
  id: string,
  title: string,
  role: "manager" | "worker",
  projectRoot: string,
): {
  id: string;
  title: string;
  role: "manager" | "worker";
  projectId: string;
  projectRoot: string;
} {
  return { id, title, role, projectId: "proj-1", projectRoot };
}

function pane(id: string, parentWindowId?: string): ProjectWorkbenchLayout["windows"][string] {
  return {
    id,
    projectId: "proj-1" as never,
    title: id,
    kind: "claude",
    cwd: "D:\\x",
    createdAt: 0,
    permission: "edit",
    openedBy: parentWindowId === undefined ? "user" : { windowId: parentWindowId },
    role: id === "A" ? "manager" : "worker",
    profileId: "p1",
    ...(parentWindowId !== undefined ? { parentWindowId } : {}),
  };
}

function recordLine(id: string): string {
  return JSON.stringify({
    v: 1,
    id,
    ts: "2026-10-01T00:00:00.000Z",
    projectId: "proj-1",
    from: { windowId: "A", title: "总管", role: "manager" },
    to: { windowId: "B", title: "子", role: "worker" },
    kind: "message",
    text: "x".repeat(180),
    threadFile: "2026-10-01-team.md",
  });
}
