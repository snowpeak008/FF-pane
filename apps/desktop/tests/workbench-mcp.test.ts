/**
 * T10.7a：工作台 MCP 授权、落盘、提醒、sidecar 与开窗口顺序。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexMcpOverrides } from "@ff-pane/adapters";
import {
  FF_PANE_WB_PIPE_ENV,
  FF_PANE_WINDOW_TOKEN_ENV,
  injectTokenIntoMcpServers,
  type WorkbenchAuthNode,
} from "@ff-pane/core";
import type { ProjectWorkbenchLayout, WorkbenchRole, WorkbenchWindow } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseEnvForCreate } from "../src/main/terminal/manager";
import { createWorkbenchAuthRegistry } from "../src/main/workbench/auth-registry";
import {
  BRIEF_MAX_BYTES,
  normalizeBriefFileName,
  resolveBriefPath,
  writeBriefFile,
} from "../src/main/workbench/brief-files";
import { createInboxCursorStore } from "../src/main/workbench/inbox-cursor";
import type { LaunchCliWindowResult } from "../src/main/workbench/launch-cli";
import { buildWorkbenchMcpSpec } from "../src/main/workbench/mcp-server-spec";
import {
  executeWorkbenchTool,
  resetToolCallBuckets,
  type ToolWindowView,
  takeInboxDigest,
  type WorkbenchToolDeps,
} from "../src/main/workbench/mcp-tools";
import { createNamedLocks, type LockGrant } from "../src/main/workbench/named-locks";
import type { WaitOutcome } from "../src/main/workbench/online-hub";
import { openChildWindow } from "../src/main/workbench/open-child";
import {
  buildCoalescedReminder,
  buildNewMessageReminder,
  sanitizeReminderSummary,
  sanitizeReminderTitle,
} from "../src/main/workbench/remind";
import {
  appendThreadRecord,
  assertProjectFiles,
  formatThreadBlock,
  readThreadIndex,
  readThreadIndexText,
  teamFileSlug,
  USER_PARTY_ID,
} from "../src/main/workbench/thread-store";
import { handleMcpLine } from "../src/mcp/protocol";
import { inboxHookOutput, promptIsInboxReminder } from "../src/mcp/workbench-hook";
import { callControlTool, createWorkbenchMcpOptions } from "../src/mcp/workbench-server";
import { WORKBENCH_MCP_TOOL_NAMES, WORKBENCH_MCP_TOOLS } from "../src/mcp/workbench-tools";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-wb-mcp-"));
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
  role: ToolWindowView["role"],
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

function harness(
  root: string,
  cursorStore?: {
    get(windowId: string): Promise<string | undefined>;
    set(windowId: string, lastReadId: string): Promise<void>;
  },
): {
  views: Record<string, ToolWindowView>;
  tree: Record<string, WorkbenchAuthNode>;
  reminders: { windowId: string; text: string }[];
  outputCalls: { windowId: string; maxBytes: number }[];
  closedIds: string[];
  panels: { panel: string; title: string }[];
  grants: LockGrant[];
  selfClosed: string[];
  permissionsSet: { windowId: string; permission: string }[];
  nudged: string[];
  decisions: { windowId: string; question: string; options: readonly string[] }[];
  waits: { windowId: string; timeoutMs: number }[];
  setWaitOutcome: (next: WaitOutcome) => void;
  deps: WorkbenchToolDeps;
} {
  const views: Record<string, ToolWindowView> = {
    A: view(root, "A", "总管", "manager"),
    B: view(root, "B", "子", "worker", "A"),
    C: view(root, "C", "孙", "worker", "B"),
    D: view(root, "D", "兄弟", "worker", "A"),
    E: view(root, "E", "外人", "none"),
  };
  const tree: Record<string, WorkbenchAuthNode> = {
    A: node("A", "manager"),
    B: node("B", "worker", "A"),
    C: node("C", "worker", "B"),
    D: node("D", "worker", "A"),
    E: node("E", "none"),
  };
  const reminders: { windowId: string; text: string }[] = [];
  const outputCalls: { windowId: string; maxBytes: number }[] = [];
  const closedIds: string[] = [];
  const panels: { panel: string; title: string }[] = [];
  const grants: LockGrant[] = [];
  const selfClosed: string[] = [];
  const permissionsSet: { windowId: string; permission: string }[] = [];
  const nudged: string[] = [];
  const waits: { windowId: string; timeoutMs: number }[] = [];
  let waitOutcome: WaitOutcome = { events: [], inbox: false, stop: false, timedOut: true };
  const decisions: { windowId: string; question: string; options: readonly string[] }[] = [];
  const cursor = new Map<string, string>();
  const getCursor = cursorStore?.get.bind(cursorStore) ?? (async (id: string) => cursor.get(id));
  const setCursor =
    cursorStore?.set.bind(cursorStore) ??
    (async (id: string, last: string) => {
      cursor.set(id, last);
    });
  const deps: WorkbenchToolDeps = {
    now: () => 1_700_000_000_000,
    snapshot: () => tree,
    isManagerGranted: (id) => id === "A",
    describe: async (id) => views[id],
    setRole: async (_caller, _target, role) => ({ ok: true, role, delivery: "skipped" }),
    openChild: async () => ({ ok: false, error: "测试里不从工具层启动。" }),
    remind: (windowId, textForCount) => {
      reminders.push({ windowId, text: textForCount(1) });
      return "delivered";
    },
    clearReminder: () => undefined,
    publishInbox: () => undefined,
    getCursor,
    setCursor,
    readOutput: async (windowId, maxBytes) => {
      outputCalls.push({ windowId, maxBytes });
      return { running: true, status: "运行中", text: "ok \u001b[31mRED\u001b[0m" };
    },
    readScreen: async (windowId, lines) => {
      outputCalls.push({ windowId, maxBytes: -lines });
      return { running: true, status: "运行中", text: "屏幕" };
    },
    closeDescendant: {
      findTerminalId: () => undefined,
      killTerminal: () => undefined,
      dropQueue: () => undefined,
      revokeToken: (id) => {
        closedIds.push(id);
      },
      releaseRuntime: () => undefined,
      closeRegistered: () => undefined,
      readLayouts: async () => ({}),
      saveLayout: async () => undefined,
      publishClosed: () => undefined,
    },
    openPanel: (panel, title) => {
      panels.push({ panel, title });
    },
    openCanvas: async () => ({ ok: true as const, relativePath: ".ffpane/canvas/a.png" }),
    generateImage: async () => ({ ok: false as const, error: "测试里不生图。" }),
    deleteCanvasFile: async () => ({ ok: true as const }),
    searchProjectMemory: async () => [],
    addProjectMemory: async () => undefined,
    setModelEffort: async () => ({ ok: false as const, error: "unused" }),
    locks: createNamedLocks(() => 1_700_000_000_000),
    notifyLockGranted: (grant) => {
      grants.push(grant);
    },
    windowState: (id) =>
      id === "B"
        ? { phase: "blocked", lastOutputAt: 1_700_000_000_000 - 65_000, pendingReminders: 2 }
        : undefined,
    closeSelfLater: (id) => {
      selfClosed.push(id);
    },
    setPermission: async (input) => {
      permissionsSet.push(input);
      return { ok: true as const, message: "已排队，空闲时自动续接" };
    },
    nudge: (id) => {
      nudged.push(id);
      return "delivered";
    },
    requestDecision: ({ caller, question, options }) => {
      decisions.push({ windowId: caller.id, question, options });
      return { id: "d-1" };
    },
    waitEvents: async (id, timeoutMs) => {
      waits.push({ windowId: id, timeoutMs });
      return waitOutcome;
    },
  };
  return {
    views,
    tree,
    reminders,
    outputCalls,
    closedIds,
    panels,
    grants,
    selfClosed,
    permissionsSet,
    nudged,
    decisions,
    waits,
    setWaitOutcome: (next: WaitOutcome) => {
      waitOutcome = next;
    },
    deps,
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

describe("工具授权", () => {
  it("可见范围只有自己、后代和上级链", async () => {
    const { deps } = harness(tempDir());
    const listed = async (caller: string): Promise<string[]> => {
      const result = await call(deps, caller, "ffpane_list_windows");
      const body = result.json as { windows: { id: string }[] };
      return body.windows.map((item) => item.id).sort();
    };
    expect(await listed("A")).toEqual(["A", "B", "C", "D"]);
    expect(await listed("B")).toEqual(["A", "B", "C"]);
    expect(await listed("C")).toEqual(["A", "B", "C"]);
    expect(await listed("D")).toEqual(["A", "D"]);
    expect(await listed("E")).toEqual(["E"]);
  });

  it("whoami 带上级与项目", async () => {
    const { deps } = harness(tempDir());
    const result = await call(deps, "B", "ffpane_whoami");
    expect(result.json).toMatchObject({
      windowId: "B",
      title: "子",
      role: "worker",
      permission: "edit",
      parent: { windowId: "A", title: "总管" },
      projectName: "演示",
    });
  });

  it("消息只给后代，汇报只给上级链", async () => {
    const { deps } = harness(tempDir());
    const send = (from: string, to: string) =>
      call(deps, from, "ffpane_send_message", { windowId: to, text: "去做" });
    const report = (from: string, to: string) =>
      call(deps, from, "ffpane_report", { windowId: to, status: "done", summary: "好了" });

    expect((await send("A", "B")).isError).toBe(false);
    expect((await send("A", "C")).isError).toBe(false);
    expect((await send("B", "C")).isError).toBe(false);
    expect((await send("B", "A")).text).toContain("后代");
    expect((await send("B", "D")).text).toContain("后代");
    expect((await send("A", "E")).text).toContain("后代");
    expect((await send("A", "A")).text).toContain("后代");
    expect((await send("C", "B")).text).toContain("后代");

    expect((await report("B", "A")).isError).toBe(false);
    expect((await report("C", "A")).isError).toBe(false);
    expect((await report("C", "B")).isError).toBe(false);
    expect((await report("A", "B")).text).toContain("上级");
    expect((await report("B", "D")).text).toContain("上级");
    expect((await report("D", "E")).text).toContain("上级");
  });

  it("set_role：顶层可自设管理者，后代可被设定，兄弟不行", async () => {
    const { deps } = harness(tempDir());
    expect(
      (await call(deps, "A", "ffpane_set_role", { windowId: "A", role: "manager" })).isError,
    ).toBe(false);
    expect(
      (await call(deps, "B", "ffpane_set_role", { windowId: "B", role: "manager" })).text,
    ).toContain("不能设定");
    expect(
      (await call(deps, "A", "ffpane_set_role", { windowId: "C", role: "reviewer" })).isError,
    ).toBe(false);
    expect(
      (await call(deps, "B", "ffpane_set_role", { windowId: "D", role: "worker" })).text,
    ).toContain("不能设定");
    expect(
      (await call(deps, "E", "ffpane_set_role", { windowId: "B", role: "worker" })).text,
    ).toContain("不能设定");
  });

  it("冷启动清洗锁住的窗口不能经 MCP 自设管理者", async () => {
    const { deps, tree } = harness(tempDir());
    const current = tree["A"];
    expect(current).toBeDefined();
    if (current === undefined) {
      return;
    }
    tree["A"] = { ...current, sanitizeLocked: true, parentClosed: true };
    const calls: string[] = [];
    const watched: WorkbenchToolDeps = {
      ...deps,
      setRole: async (caller, target, role) => {
        calls.push(`${caller}:${target}:${role}`);
        return deps.setRole(caller, target, role);
      },
    };
    const result = await call(watched, "A", "ffpane_set_role", {
      windowId: "A",
      role: "manager",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("不能设定");
    expect(calls).toEqual([]);
  });

  it("列出读取、关闭和打开面板，描述与说明书一致", () => {
    expect(WORKBENCH_MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining(["ffpane_read_output", "ffpane_close_window", "ffpane_open_panel"]),
    );
    const byName = new Map(WORKBENCH_MCP_TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get("ffpane_read_output")).toContain("仅后代");
    expect(byName.get("ffpane_read_output")).toContain("32KB");
    expect(byName.get("ffpane_close_window")).toContain("仅后代");
    expect(byName.get("ffpane_close_window")).toContain("父级已关闭");
    expect(byName.get("ffpane_open_canvas")).toContain("revision");
    expect(byName.get("ffpane_open_canvas")).toContain("markedImage");
    expect(byName.get("ffpane_generate_image")).toContain("任何窗口");
    expect(byName.get("ffpane_open_panel")).toContain("plan");
    expect(byName.get("ffpane_open_panel")).toContain("tasks");
    expect(byName.get("ffpane_open_panel")).toContain("runs");
  });

  it("打开画板时把修改要求交回去", async () => {
    const { deps } = harness(tempDir());
    const result = await call(
      {
        ...deps,
        openCanvas: async () => ({
          ok: true as const,
          relativePath: ".ffpane/canvas/a.png",
          revision: {
            v: 1,
            image: ".ffpane/canvas/a.png",
            imageTag: "项目内图片 a.png .ffpane/canvas/a.png",
            markedImage: ".ffpane/canvas/revisions/a.png.marked.png",
            markedImageReady: true,
            purpose: "修改要求",
            marks: [
              {
                number: 1,
                kind: "label",
                color: "#ef4444",
                text: "太阳再大",
                x: 10,
                y: 20,
              },
            ],
          },
        }),
      },
      "A",
      "ffpane_open_canvas",
      { imagePath: ".ffpane/canvas/a.png" },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("太阳再大");
    expect(result.text).toContain("a.png.marked.png");
  });

  it("任何窗口都能生图，且不往别的窗口写正文", async () => {
    const { deps, reminders } = harness(tempDir());
    const seen: string[] = [];
    const watched: WorkbenchToolDeps = {
      ...deps,
      generateImage: async (input) => {
        seen.push(`${input.openerTitle}:${input.prompt}`);
        return { ok: true, relativePath: ".ffpane/canvas/gen.png" };
      },
    };
    const result = await call(watched, "B", "ffpane_generate_image", { prompt: "一只猫" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(".ffpane/canvas/gen.png");
    expect(seen).toEqual(["子:一只猫"]);
    expect(reminders).toEqual([]);
    const missing = await call(watched, "E", "ffpane_generate_image", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("prompt");
    expect(reminders).toEqual([]);
  });
});

describe("清单新增工具", () => {
  it("set_permission：只改后代，不得高于自己", async () => {
    const { deps, permissionsSet } = harness(tempDir());
    const okResult = await call(deps, "A", "ffpane_set_permission", {
      windowId: "C",
      permission: "read-only",
    });
    expect(okResult.json).toMatchObject({ ok: true, windowId: "C", permission: "read-only" });
    expect(permissionsSet).toEqual([{ windowId: "C", permission: "read-only" }]);
    const higher = await call(deps, "A", "ffpane_set_permission", {
      windowId: "B",
      permission: "yolo",
    });
    expect(higher.isError).toBe(true);
    expect(higher.text).toContain("不能高于你自己的权限");
    expect(
      (await call(deps, "B", "ffpane_set_permission", { windowId: "A", permission: "edit" }))
        .isError,
    ).toBe(true);
    expect(
      (await call(deps, "A", "ffpane_set_permission", { windowId: "A", permission: "edit" }))
        .isError,
    ).toBe(true);
    expect(
      (await call(deps, "A", "ffpane_set_permission", { windowId: "B", permission: "root" }))
        .isError,
    ).toBe(true);
    expect(permissionsSet).toHaveLength(1);
  });

  it("broadcast：发给全部后代或只发直接子窗口，各写一条", async () => {
    const root = tempDir();
    const { deps, reminders } = harness(root);
    const all = await call(deps, "A", "ffpane_broadcast", { text: "全体暂停" });
    const sentIds = (all.json as { sent: { windowId: string }[] }).sent.map(
      (item) => item.windowId,
    );
    expect(sentIds.sort()).toEqual(["B", "C", "D"]);
    expect(reminders.map((item) => item.windowId).sort()).toEqual(["B", "C", "D"]);
    const children = await call(deps, "A", "ffpane_broadcast", {
      text: "只给子窗口",
      scope: "children",
    });
    expect(
      (children.json as { sent: { windowId: string }[] }).sent.map((s) => s.windowId).sort(),
    ).toEqual(["B", "D"]);
    expect((await call(deps, "E", "ffpane_broadcast", { text: "x" })).isError).toBe(true);
    expect((await call(deps, "A", "ffpane_broadcast", {})).isError).toBe(true);
    expect((await readThreadIndex(root)).length).toBe(5);
  });

  it("lock：先到先得，排队，放锁交给下一个并提醒", async () => {
    const { deps, grants } = harness(tempDir());
    expect(
      (await call(deps, "B", "ffpane_lock", { action: "acquire", name: "unity" })).json,
    ).toMatchObject({
      state: "held",
    });
    const queued = await call(deps, "D", "ffpane_lock", { action: "acquire", name: "unity" });
    expect(queued.json).toMatchObject({ state: "queued", position: 1, holder: { windowId: "B" } });
    const listed = await call(deps, "A", "ffpane_lock", { action: "list" });
    expect(listed.json).toMatchObject({
      locks: [{ name: "unity", holder: { windowId: "B", title: "子" }, waiting: ["D"] }],
    });
    const windows = await call(deps, "A", "ffpane_list_windows");
    const b = (windows.json as { windows: Record<string, unknown>[] }).windows.find(
      (item) => item["id"] === "B",
    );
    expect(b).toMatchObject({
      holdingLocks: ["unity"],
      state: "等用户批准",
      quietSeconds: 65,
      pendingReminders: 2,
    });
    expect(
      (await call(deps, "B", "ffpane_lock", { action: "release", name: "unity" })).json,
    ).toEqual({
      released: true,
      name: "unity",
    });
    expect(grants).toEqual([{ projectId: "proj-1", name: "unity", windowId: "D" }]);
    expect(
      (await call(deps, "B", "ffpane_lock", { action: "acquire", name: "../x" })).isError,
    ).toBe(true);
    expect((await call(deps, "B", "ffpane_lock", { action: "steal", name: "unity" })).isError).toBe(
      true,
    );
  });

  it("closeAfter：done 汇报后由上级关闭；别的状态或管理者不行", async () => {
    const { deps, selfClosed } = harness(tempDir());
    const done = await call(deps, "B", "ffpane_report", {
      status: "done",
      summary: "记录在 x",
      closeAfter: true,
    });
    expect(done.json).toMatchObject({ closing: expect.stringContaining("由上级关闭") });
    expect(selfClosed).toEqual(["B"]);
    expect(
      (
        await call(deps, "B", "ffpane_report", {
          status: "progress",
          summary: "x",
          closeAfter: true,
        })
      ).isError,
    ).toBe(true);
    expect(selfClosed).toEqual(["B"]);
  });
});

describe("在线监管", () => {
  it("wait_events：夹紧等待时长，事件原样返回，有新消息时附上正文，叫停时告诉它结束", async () => {
    const root = tempDir();
    const h = harness(root);
    const idle = await call(h.deps, "A", "ffpane_wait_events", { timeoutSec: 9999 });
    expect(h.waits).toEqual([{ windowId: "A", timeoutMs: 540_000 }]);
    expect(idle.json).toMatchObject({ events: [], timedOut: true, stop: false });
    expect((idle.json as { next: string }).next).toContain("接着等");

    await call(h.deps, "A", "ffpane_send_message", { windowId: "B", text: "先跑单测" });
    h.setWaitOutcome({ events: ["[状态] 执行限流"], inbox: true, stop: false, timedOut: false });
    const busy = await call(h.deps, "B", "ffpane_wait_events");
    expect(h.waits.at(-1)).toEqual({ windowId: "B", timeoutMs: 240_000 });
    expect(busy.json).toMatchObject({ events: ["[状态] 执行限流"], timedOut: false });
    expect((busy.json as { messages: string }).messages).toContain("> 先跑单测");

    h.setWaitOutcome({ events: [], inbox: false, stop: true, timedOut: false });
    const stopped = await call(h.deps, "B", "ffpane_wait_events");
    expect((stopped.json as { next: string }).next).toContain("不要再调用");
  });
});

describe("叫醒与拍板", () => {
  it("nudge：能叫醒后代和挂在自己名下的窗口，叫不醒别人", async () => {
    const root = tempDir();
    const h = harness(root);
    h.views["S"] = view(root, "S", "监管", "supervisor", "A");
    h.tree["S"] = node("S", "supervisor", "A");
    const worker = h.views["D"];
    if (worker === undefined) {
      throw new Error("missing D");
    }
    h.views["D"] = { ...worker, watcherWindowId: "S" };
    expect((await call(h.deps, "A", "ffpane_nudge", { windowId: "C" })).json).toMatchObject({
      delivery: "delivered",
    });
    expect((await call(h.deps, "S", "ffpane_nudge", { windowId: "D" })).isError).toBe(false);
    expect((await call(h.deps, "S", "ffpane_nudge", { windowId: "B" })).isError).toBe(true);
    expect((await call(h.deps, "B", "ffpane_nudge", { windowId: "A" })).isError).toBe(true);
    expect((await call(h.deps, "B", "ffpane_nudge", { windowId: "B" })).isError).toBe(true);
    expect(h.nudged).toEqual(["C", "D"]);
  });

  it("request_decision：管理者带计划推 2 到 4 个选项；没计划、下级、空选项、重复选项都被拒", async () => {
    const h = harness(tempDir());
    await call(h.deps, "A", "ffpane_write_brief", { name: "plan.md", content: "# 计划" });
    const noPlan = await call(h.deps, "A", "ffpane_request_decision", {
      question: "要不要改？",
      options: ["改", "不改"],
    });
    expect(noPlan.isError).toBe(true);
    expect(noPlan.text).toContain("写成计划");
    const plan = ".ffpane/briefs/plan.md";
    const okResult = await call(h.deps, "A", "ffpane_request_decision", {
      question: "回归测试\n要不要改成每晚跑一次？",
      options: ["每晚跑", "保持每次提交都跑"],
      briefPath: plan,
    });
    expect(okResult.json).toMatchObject({ id: "d-1" });
    expect(h.decisions).toEqual([
      {
        windowId: "A",
        question: "回归测试 要不要改成每晚跑一次？",
        options: ["每晚跑", "保持每次提交都跑"],
      },
    ]);
    const worker = await call(h.deps, "B", "ffpane_request_decision", {
      question: "x",
      options: ["a", "b"],
      briefPath: plan,
    });
    expect(worker.isError).toBe(true);
    for (const options of [["只有一个"], ["a", "a"], ["a", "b", "c", "d", "e"], ["a", ""]]) {
      expect(
        (
          await call(h.deps, "A", "ffpane_request_decision", {
            question: "q",
            options,
            briefPath: plan,
          })
        ).isError,
        JSON.stringify(options),
      ).toBe(true);
    }
    expect(
      (
        await call(h.deps, "A", "ffpane_request_decision", {
          question: "",
          options: ["a", "b"],
          briefPath: plan,
        })
      ).isError,
    ).toBe(true);
  });

  it("用户的决定附给模型时标明是用户本人", async () => {
    const root = tempDir();
    const h = harness(root);
    const date = new Date(1_700_000_000_000);
    await appendThreadRecord(
      root,
      {
        v: 1,
        id: "m-user-1",
        ts: date.toISOString(),
        projectId: "proj-1",
        from: { windowId: USER_PARTY_ID, title: "用户", role: "none" },
        to: { windowId: "A", title: "总管", role: "manager" },
        kind: "message",
        text: "拍板：每晚跑吗\n用户的决定：每晚跑",
        threadFile: "2023-11-14-拍板-A.md",
      },
      date,
    );
    const digest = await takeInboxDigest("A", h.deps);
    expect(digest).toContain("来自 用户本人（拍板结果，照此执行）");
    expect(digest).toContain("> 用户的决定：每晚跑");
  });
});

describe("命名锁", () => {
  it("窗口退出时放掉持有的锁并退出排队", () => {
    const locks = createNamedLocks(() => 0);
    locks.acquire("p", "unity", "w1");
    locks.acquire("p", "unity", "w2");
    locks.acquire("p", "unity", "w3");
    locks.acquire("p", "gpu", "w2");
    expect(locks.releaseWindow("w2")).toEqual([]);
    expect(locks.of("w2")).toEqual({ holding: [], waiting: [] });
    expect(locks.releaseWindow("w1")).toEqual([{ projectId: "p", name: "unity", windowId: "w3" }]);
    expect(locks.list("p")).toEqual([{ name: "unity", holder: "w3", heldSince: 0, waiting: [] }]);
    expect(locks.release("p", "unity", "w3")).toEqual({ released: true });
    expect(locks.list("p")).toEqual([]);
  });
});

describe("监管者观察", () => {
  function watched(root: string) {
    const h = harness(root);
    h.views["S"] = view(root, "S", "监管", "supervisor", "A");
    h.tree["S"] = node("S", "supervisor", "A");
    const worker = h.views["B"];
    if (worker === undefined) {
      throw new Error("missing B");
    }
    h.views["B"] = { ...worker, watcherWindowId: "S" };
    return h;
  }

  it("done 抄送给监管者、不叫醒上级；failed 照常叫醒", async () => {
    const root = tempDir();
    const { deps, reminders } = watched(root);
    const done = await call(deps, "B", "ffpane_report", { status: "done", summary: "记录在 x" });
    expect(done.json).toMatchObject({ delivery: "silent", cc: { windowId: "S" } });
    expect(reminders.map((item) => item.windowId)).toEqual(["S"]);
    const records = await readThreadIndex(root);
    expect(records.map((record) => record.to.windowId).sort()).toEqual(["A", "S"]);

    const failed = await call(deps, "B", "ffpane_report", { status: "failed", summary: "挂了" });
    expect(failed.json).toMatchObject({ delivery: "delivered", cc: { windowId: "S" } });
    expect(reminders.map((item) => item.windowId)).toEqual(["S", "A", "S"]);
  });

  it("监管者能读被观察窗口的终端、能在列表里看到它，但不能发消息或关窗", async () => {
    const root = tempDir();
    const { deps } = watched(root);
    expect((await call(deps, "S", "ffpane_read_output", { windowId: "B" })).isError).toBe(false);
    expect((await call(deps, "S", "ffpane_read_output", { windowId: "D" })).isError).toBe(true);
    const listed = await call(deps, "S", "ffpane_list_windows");
    const ids = (listed.json as { windows: { id: string }[] }).windows.map((item) => item.id);
    expect(ids).toContain("B");
    expect(ids).not.toContain("D");
    expect(
      (await call(deps, "S", "ffpane_send_message", { windowId: "B", text: "停" })).isError,
    ).toBe(true);
    expect((await call(deps, "S", "ffpane_close_window", { windowId: "B" })).isError).toBe(true);
    expect((await call(deps, "D", "ffpane_read_output", { windowId: "B" })).isError).toBe(true);
  });
});

describe("读取、关闭与打开面板", () => {
  it("只有祖先能读和关后代，任何人能打开面板，连点被拒绝", async () => {
    const { deps, closedIds, panels } = harness(tempDir());
    expect((await call(deps, "A", "ffpane_read_output", { windowId: "B" })).isError).toBe(false);
    expect((await call(deps, "A", "ffpane_close_window", { windowId: "B" })).isError).toBe(false);
    expect(closedIds).toEqual(["B"]);
    for (const [caller, target] of [
      ["B", "A"],
      ["B", "D"],
      ["B", "B"],
      ["E", "B"],
    ] as const) {
      expect((await call(deps, caller, "ffpane_read_output", { windowId: target })).text).toContain(
        "后代",
      );
      expect(
        (await call(deps, caller, "ffpane_close_window", { windowId: target })).text,
      ).toContain("后代");
    }
    expect(closedIds).toEqual(["B"]);
    for (const caller of ["A", "B", "E"]) {
      expect((await call(deps, caller, "ffpane_open_panel", { panel: "tasks" })).isError).toBe(
        false,
      );
    }
    expect(panels.map((item) => item.panel)).toEqual(["tasks", "tasks", "tasks"]);
    expect((await call(deps, "A", "ffpane_open_panel", { panel: "runs" })).text).toContain("频繁");
    expect((await call(deps, "A", "ffpane_open_panel", { panel: "nope" })).text).toContain("panel");
  });

  it("raw 模式去掉 ANSI，并夹紧字节上限；缺省走屏幕模式", async () => {
    const { deps, outputCalls } = harness(tempDir());
    const capped = await call(deps, "A", "ffpane_read_output", {
      windowId: "B",
      mode: "raw",
      maxBytes: 100_000,
    });
    expect(capped.isError).toBe(false);
    expect(outputCalls[0]).toEqual({ windowId: "B", maxBytes: 32_768 });
    expect(capped.json).toMatchObject({ running: true, text: "ok RED" });
    expect(String((capped.json as { text: string }).text)).not.toContain("\u001b");

    const fallback = await call(deps, "A", "ffpane_read_output", { windowId: "C", mode: "raw" });
    expect(outputCalls[1]).toEqual({ windowId: "C", maxBytes: 8192 });
    expect(fallback.isError).toBe(false);

    const screen = await call(deps, "A", "ffpane_read_output", { windowId: "B", lines: 9999 });
    expect(screen.json).toMatchObject({ running: true, mode: "screen", text: "屏幕" });
    expect(outputCalls[2]).toEqual({ windowId: "B", maxBytes: -300 });
    expect(
      (await call(deps, "A", "ffpane_read_output", { windowId: "B", mode: "x" })).isError,
    ).toBe(true);

    const idle = await call(
      {
        ...deps,
        readScreen: async () => ({ running: false, status: "该窗口的终端已退出。" }),
      },
      "A",
      "ffpane_read_output",
      { windowId: "B" },
    );
    expect(idle.isError).toBe(false);
    expect(idle.json).toEqual({ running: false, status: "该窗口的终端已退出。" });
  });
});

describe("write_brief 与 files", () => {
  it("拒绝穿越、绝对路径、设备名和超大正文", async () => {
    const root = tempDir();
    for (const name of ["../x.md", "..\\x.md", "C:\\temp\\x.md", "CON", "con.txt"]) {
      const written = await writeBriefFile({ projectRoot: root, name, content: "a" });
      expect(written.ok, name).toBe(false);
    }
    const huge = await writeBriefFile({
      projectRoot: root,
      name: "big.md",
      content: "x".repeat(BRIEF_MAX_BYTES + 1),
    });
    expect(huge.ok).toBe(false);
  });

  it("重名加序号，符号链接目录逃逸被拒绝", async () => {
    const root = tempDir();
    const first = await writeBriefFile({ projectRoot: root, name: "plan", content: "一" });
    const second = await writeBriefFile({ projectRoot: root, name: "plan.md", content: "二" });
    expect(first).toMatchObject({ ok: true, relativePath: ".ffpane/briefs/plan.md" });
    expect(second).toMatchObject({ ok: true, relativePath: ".ffpane/briefs/plan-2.md" });

    const outside = tempDir();
    const linked = tempDir();
    await mkdir(join(linked, ".ffpane"), { recursive: true });
    try {
      await symlink(outside, join(linked, ".ffpane", "briefs"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return;
      }
      throw error;
    }
    const escaped = await writeBriefFile({ projectRoot: linked, name: "x.md", content: "no" });
    expect(escaped.ok).toBe(false);
  });

  it("overwrite 覆盖同名，append 追加到末尾，都不另起序号", async () => {
    const root = tempDir();
    const { deps } = harness(root);
    await call(deps, "B", "ffpane_write_brief", { name: "log.md", content: "一\n" });
    const over = await call(deps, "B", "ffpane_write_brief", {
      name: "log.md",
      content: "二\n",
      mode: "overwrite",
    });
    expect(over.json).toMatchObject({ relativePath: ".ffpane/briefs/log.md" });
    const appended = await call(deps, "B", "ffpane_write_brief", {
      name: "log.md",
      content: "三\n",
      mode: "append",
    });
    expect(appended.json).toMatchObject({ relativePath: ".ffpane/briefs/log.md" });
    expect(readFileSync(join(root, ".ffpane", "briefs", "log.md"), "utf8")).toBe("二\n三\n");
    const bad = await call(deps, "B", "ffpane_write_brief", {
      name: "log.md",
      content: "x",
      mode: "replace",
    });
    expect(bad.isError).toBe(true);
    const tooBig = await writeBriefFile({
      projectRoot: root,
      name: "log.md",
      content: "x".repeat(BRIEF_MAX_BYTES),
      mode: "append",
    });
    expect(tooBig.ok).toBe(false);
  });

  it("files 不能越出项目", async () => {
    const root = tempDir();
    expect((await assertProjectFiles(root, ["src/a.ts"])).ok).toBe(true);
    expect((await assertProjectFiles(root, ["../secret"])).ok).toBe(false);
    expect((await assertProjectFiles(root, ["C:\\Windows\\notepad.exe"])).ok).toBe(false);
  });

  it("只读窗口也能写 briefs", async () => {
    const root = tempDir();
    const { deps, views } = harness(root);
    const outsider = views["E"];
    if (outsider === undefined) {
      throw new Error("missing E");
    }
    views["E"] = {
      id: outsider.id,
      title: outsider.title,
      projectId: outsider.projectId,
      projectName: outsider.projectName,
      projectRoot: outsider.projectRoot,
      role: outsider.role,
      permission: "read-only",
      running: outsider.running,
      openedBy: outsider.openedBy,
      sanitizeLocked: outsider.sanitizeLocked,
    };
    const result = await call(deps, "E", "ffpane_write_brief", {
      name: "note.md",
      content: "说明",
    });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ relativePath: ".ffpane/briefs/note.md" });
  });
});

describe("消息存储", () => {
  it("追加、半写跳过、团队文件名、已读游标不进项目", async () => {
    const root = tempDir();
    const { deps } = harness(root);
    expect(
      (await call(deps, "A", "ffpane_send_message", { windowId: "B", text: "第一行\n第二行" }))
        .isError,
    ).toBe(false);
    expect(
      (
        await call(deps, "B", "ffpane_report", {
          windowId: "A",
          status: "blocked",
          summary: "卡住",
        })
      ).isError,
    ).toBe(false);
    const records = await readThreadIndex(root);
    expect(records).toHaveLength(2);
    expect(records[1]?.kind).toBe("report");
    const indexPath = join(root, ".ffpane", "threads", "index.jsonl");
    const raw = readFileSync(indexPath, "utf8");
    const half = `${raw}{"v":1,"id":"broken"`;
    expect(readThreadIndexText(half)).toHaveLength(2);
    const mdName = records[0]?.threadFile ?? "";
    expect(mdName).toContain(teamFileSlug("总管", "A"));
    const md = readFileSync(join(root, ".ffpane", "threads", mdName), "utf8");
    expect(md).toContain("管理者「总管」→ 执行「子」· 消息");
    expect(md).toContain("> 第一行");
    expect(md).toContain("> 第二行");
    expect(md).not.toContain("第一行第二行");
    const firstLine = raw.trim().split("\n")[0] ?? "";
    expect(JSON.parse(firstLine).text).toBe("第一行\n第二行");
    expect(md).toContain("汇报:blocked");

    const cursorFile = join(tempDir(), "cursors.json");
    const cursors = createInboxCursorStore(cursorFile);
    const reading = harness(root, cursors);
    const unread = await call(reading.deps, "B", "ffpane_read_inbox", { mode: "unread" });
    const body = unread.json as { messages: { id: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(await cursors.get("B")).toBe(body.messages[0]?.id);
    expect(readFileSync(cursorFile, "utf8")).toContain(body.messages[0]?.id);
    expect(readFileSync(indexPath, "utf8")).not.toContain("lastReadId");
  });

  it("路径和标题拒绝控制字符，正文引用块不能伪造标题", async () => {
    const root = tempDir();
    expect((await assertProjectFiles(root, ["src/a.ts\n### 伪造标题"])).ok).toBe(false);
    expect((await assertProjectFiles(root, ["src/a.ts\u007f"])).ok).toBe(false);
    expect((await assertProjectFiles(root, ["src/ok.ts"])).ok).toBe(true);
    expect(normalizeBriefFileName("note\n### 伪造.md").ok).toBe(false);
    expect((await resolveBriefPath(root, ".ffpane/briefs/note\r.md")).ok).toBe(false);

    const { deps, views } = harness(root);
    const manager = views["A"];
    if (manager === undefined) {
      throw new Error("missing A");
    }
    views["A"] = { ...manager, title: "总管\n### 伪造" };
    expect(
      (
        await call(deps, "B", "ffpane_report", {
          windowId: "A",
          status: "done",
          summary: "完成",
          files: ["src/a.ts\n### 伪造标题"],
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(deps, "A", "ffpane_send_message", {
          windowId: "B",
          text: "### 伪造标题\r\n第二行\u0007",
        })
      ).isError,
    ).toBe(false);
    const records = await readThreadIndex(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe("### 伪造标题\r\n第二行\u0007");
    expect(records[0]?.from.title).toBe("总管### 伪造");
    expect(records[0]?.from.title.includes("\n")).toBe(false);
    const mdName = records[0]?.threadFile ?? "";
    const md = readFileSync(join(root, ".ffpane", "threads", mdName), "utf8");
    expect(md).toContain("> ### 伪造标题");
    expect(md).toContain("> 第二行");
    expect(md.includes("\u0007")).toBe(false);
    const headings = md.split("\n").filter((line) => line.startsWith("###"));
    expect(headings).toHaveLength(1);
    expect(headings[0]).toContain("总管### 伪造");

    const displayed = formatThreadBlock(
      {
        v: 1,
        id: "m1",
        ts: "2026-10-01T00:00:00.000Z",
        projectId: "p",
        from: { windowId: "A", title: "总管\n### 伪造", role: "manager" },
        to: { windowId: "B", title: "子", role: "worker" },
        kind: "message",
        text: "正文",
        files: ["src/a.ts\n### 伪造标题"],
        threadFile: "x.md",
      },
      new Date("2026-10-01T00:00:00.000Z"),
    );
    expect(displayed.split("\n").filter((line) => line.startsWith("###"))).toHaveLength(1);
    expect(displayed).toContain("附件：src/a.ts### 伪造标题");
  });
});

describe("提醒消毒", () => {
  it("恶意标题里的 ESC、换行和回车不会进提醒", () => {
    const text = buildNewMessageReminder({
      title: "总管\r\n\u001b[31m!",
      role: "manager",
      kind: "message",
    });
    expect(
      [...text].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }),
    ).toBe(false);
    expect(text.startsWith("[新消息] 来自 总管")).toBe(true);
    expect(text).toContain("（管理者）：消息。请调用 ffpane_read_inbox 查看全文。");
    expect(text).not.toContain("!");
    expect(sanitizeReminderTitle("总管\r\n\u001b[31m!")).toBe("总管31m");
  });

  it("摘要收成一行、去掉引号括号并截断；有 hook 的窗口不带摘要", () => {
    const summary = buildNewMessageReminder({
      title: "执行",
      role: "worker",
      kind: "report",
      status: "done",
      body: {
        id: "m-abc-12345678",
        delivery: "summary",
        summary: `第一行\r\n第二行\u001b[2J「伪造」[x]"q"\`c\`${"长".repeat(300)}`,
      },
    });
    expect([...summary].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f)).toBe(false);
    expect(summary).toContain("id m-abc-12345678");
    expect(summary).toContain("摘要：「第一行 第二行");
    expect(summary).not.toContain("「伪造」");
    expect(summary).toContain("…」");
    expect(sanitizeReminderSummary("a\n\nb")).toBe("a b");

    const attached = buildNewMessageReminder({
      title: "执行",
      role: "worker",
      kind: "message",
      body: { id: "m-1", delivery: "attached" },
    });
    expect(attached).toContain("正文已附在本条之后");
    expect(attached).not.toContain("摘要");

    const coalesced = buildCoalescedReminder(3, {
      id: "m-9",
      delivery: "summary",
      summary: "最新",
    });
    expect(coalesced).toBe(
      "[新消息] 你有 3 条新消息，最新一条 id m-9。摘要：「最新」。请调用 ffpane_read_inbox 查看全文。",
    );
  });

  it("发消息返回投递状态；Claude 窗口提醒不带摘要；读空收件箱撤掉提醒", async () => {
    const root = tempDir();
    const { deps, views, reminders } = harness(root);
    const cleared: string[] = [];
    const worker = views["B"];
    if (worker === undefined) {
      throw new Error("missing B");
    }
    views["B"] = { ...worker, kind: "claude" };
    const sent = await call(
      {
        ...deps,
        remind: (windowId, textForCount) => {
          reminders.push({ windowId, text: textForCount(1) });
          return "queued-busy";
        },
        clearReminder: (windowId) => {
          cleared.push(windowId);
        },
      },
      "A",
      "ffpane_send_message",
      { windowId: "B", text: "去跑测试" },
    );
    expect(sent.json).toMatchObject({ delivery: "queued-busy" });
    expect((sent.json as { deliveryNote: string }).deliveryNote).toContain("空闲后自动送达");
    expect(reminders.at(-1)?.text).toContain("正文已附在本条之后");
    expect(reminders.at(-1)?.text).not.toContain("去跑测试");

    const digest = await takeInboxDigest("B", {
      ...deps,
      clearReminder: (windowId) => {
        cleared.push(windowId);
      },
    });
    expect(digest).toContain("你的上级：工作安排，照常执行");
    expect(digest).toContain("> 去跑测试");
    expect(cleared).toEqual(["B"]);
    expect(await takeInboxDigest("B", deps)).toBe("");
  });

  it("hook 只在提交的是新消息提醒时去取正文", () => {
    expect(promptIsInboxReminder(JSON.stringify({ prompt: "[新消息] 来自 A" }))).toBe(true);
    expect(promptIsInboxReminder(JSON.stringify({ prompt: "帮我看看 [新消息]" }))).toBe(false);
    expect(promptIsInboxReminder("not json")).toBe(false);
    expect(JSON.parse(inboxHookOutput("正文"))).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "正文" },
    });
  });
});

describe("sidecar", () => {
  it("字面量占位符时工具调用报错", async () => {
    const options = createWorkbenchMcpOptions({
      [FF_PANE_WINDOW_TOKEN_ENV]: `${"$"}{FF_PANE_WINDOW_TOKEN}`,
      [FF_PANE_WB_PIPE_ENV]: "\\\\.\\pipe\\demo",
    });
    const response = await handleMcpLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ffpane_whoami", arguments: {} },
      }),
      options,
    );
    const result = response?.result as { isError?: boolean; content?: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("字面量");
    expect(result.content?.[0]?.text).toContain("重启");
  });

  it("控制通道断开时返回中文错误", async () => {
    const missing = `\\\\.\\pipe\\ffpane-missing-${Date.now().toString(36)}`;
    const result = await callControlTool(missing, "token", "ffpane_whoami", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("控制通道");
  });
});

describe("open_window", () => {
  function layout(root: string): ProjectWorkbenchLayout {
    const manager: WorkbenchWindow = {
      id: "A",
      projectId: "proj-1" as never,
      title: "总管",
      kind: "claude",
      cwd: root,
      createdAt: 1,
      permission: "edit",
      role: "manager",
      openedBy: "user",
    };
    return {
      projectId: "proj-1" as never,
      tabs: [{ id: "tab-1", title: "Tab", root: { type: "leaf", windowId: "A" } }],
      activeTabId: "tab-1",
      windows: { A: manager },
      maximizedWindowId: null,
      focusedWindowId: "A",
    };
  }

  it("只有一个监管者时执行自动挂上；资源不够不开", async () => {
    const root = tempDir();
    const registry = createWorkbenchAuthRegistry();
    registry.pin(
      { id: "A", permission: "edit", role: "manager", openedBy: "user" },
      "proj-1" as never,
    );
    registry.grantManager("A");
    const base = layout(root);
    const withSupervisor: ProjectWorkbenchLayout = {
      ...base,
      windows: {
        ...base.windows,
        S: {
          id: "S",
          projectId: "proj-1" as never,
          title: "监管",
          kind: "claude",
          cwd: root,
          createdAt: 2,
          permission: "read-only",
          role: "supervisor",
          openedBy: { windowId: "A" },
          parentWindowId: "A",
        },
      },
    };
    const saved: ProjectWorkbenchLayout[] = [];
    let ids = 0;
    const deps = {
      authRegistry: registry,
      readLayouts: async () => ({ "proj-1": withSupervisor }),
      saveLayout: async (next: ProjectWorkbenchLayout) => {
        saved.push(next);
      },
      launch: async () =>
        ({
          terminal: { id: "term" },
          kind: "claude",
          effectivePermission: "edit",
          permissionCapped: false,
        }) as unknown as LaunchCliWindowResult,
      resolveRoute: async () => ({
        ok: true as const,
        route: {
          connectionMode: "local_cli" as const,
          configId: "cfg" as never,
          configName: "默认配置",
        },
      }),
      describeCaller: async () => ({
        title: "总管",
        projectId: "proj-1",
        projectRoot: root,
        permission: "edit" as const,
      }),
      aliveCount: () => 2,
      maxWindows: async () => 8,
      publish: () => undefined,
      newId: () => {
        ids += 1;
        return `w-${ids}`;
      },
    };
    const opened = await openChildWindow(
      "A",
      { cli: "claude", role: "worker", permission: "edit", title: "执行" },
      deps,
    );
    expect(opened).toMatchObject({ ok: true, note: expect.stringContaining("已挂到监管者 监管") });
    expect(saved[0]?.windows["w-1"]?.watcherWindowId).toBe("S");

    const reviewer = await openChildWindow(
      "A",
      { cli: "claude", role: "reviewer", permission: "edit", title: "检查" },
      deps,
    );
    expect(reviewer.ok).toBe(true);
    expect(saved[1]?.windows["w-2"]?.watcherWindowId).toBeUndefined();

    const short = await openChildWindow(
      "A",
      { cli: "claude", role: "worker", permission: "edit", title: "执行2" },
      { ...deps, checkResources: async () => "可用内存只剩 1.0 GB" },
    );
    expect(short).toEqual({ ok: false, error: "可用内存只剩 1.0 GB" });
  });

  it("先登记父级再启动，超权封顶，非管理者与未授予者被拒，到上限不开", async () => {
    const root = tempDir();
    const registry = createWorkbenchAuthRegistry();
    registry.pin(
      { id: "A", permission: "edit", role: "manager", openedBy: "user" },
      "proj-1" as never,
    );
    registry.grantManager("A");
    const seen: string[] = [];
    const saved: ProjectWorkbenchLayout[] = [];
    const opened = await openChildWindow(
      "A",
      {
        cli: "claude",
        role: "worker",
        permission: "yolo",
        title: "前端A",
        message: "去做",
      },
      {
        authRegistry: registry,
        readLayouts: async () => ({ "proj-1": layout(root) }),
        saveLayout: async (next) => {
          saved.push(next);
        },
        launch: async (input) => {
          const registered = registry.get(input.windowId);
          expect(registered?.parentWindowId).toBe("A");
          expect(registered?.openedBy).toEqual({ windowId: "A" });
          expect(input.permission).toBe("edit");
          seen.push("launch");
          return {
            terminal: { id: "term-b" },
            kind: "claude",
            effectivePermission: "edit",
            permissionCapped: false,
            profileName: "p",
            command: "claude",
            args: [],
            turnSignal: "manual",
          } as unknown as LaunchCliWindowResult;
        },
        resolveRoute: async () => ({
          ok: true as const,
          route: {
            connectionMode: "local_cli" as const,
            configId: "cfg" as never,
            configName: "默认配置",
          },
        }),
        describeCaller: async () => ({
          title: "总管",
          projectId: "proj-1",
          projectRoot: root,
          permission: "edit",
        }),
        aliveCount: () => 1,
        maxWindows: async () => 8,
        publish: () => undefined,
        newId: () => "child-1",
      },
    );
    expect(seen).toEqual(["launch"]);
    expect(opened).toMatchObject({
      ok: true,
      windowId: "child-1",
      title: "前端A",
      permission: "edit",
      capped: true,
    });
    expect(saved[0]?.windows["child-1"]?.openedBy).toEqual({ windowId: "A" });
    expect(saved[0]?.windows["child-1"]?.parentWindowId).toBe("A");

    const worker = createWorkbenchAuthRegistry();
    worker.pin(
      {
        id: "B",
        permission: "edit",
        role: "worker",
        openedBy: { windowId: "A" },
        parentWindowId: "A",
      },
      "proj-1" as never,
    );
    const denied = await openChildWindow(
      "B",
      { cli: "claude", role: "worker", permission: "edit", title: "越权" },
      {
        authRegistry: worker,
        readLayouts: async () => ({}),
        saveLayout: async () => undefined,
        launch: async () => {
          throw new Error("不应启动");
        },
        resolveRoute: async () => ({
          ok: true as const,
          route: {
            connectionMode: "local_cli" as const,
            configId: "cfg" as never,
            configName: "默认配置",
          },
        }),
        describeCaller: async () => ({
          title: "子",
          projectId: "proj-1",
          projectRoot: root,
          permission: "edit",
        }),
        aliveCount: () => 0,
        maxWindows: async () => 8,
        publish: () => undefined,
      },
    );
    expect(denied.ok).toBe(false);

    const cold = createWorkbenchAuthRegistry();
    cold.upsert(
      { id: "A", permission: "edit", role: "manager", openedBy: "user" },
      "proj-1" as never,
    );
    const coldDenied = await openChildWindow(
      "A",
      { cli: "claude", role: "worker", permission: "edit", title: "冷" },
      {
        authRegistry: cold,
        readLayouts: async () => ({}),
        saveLayout: async () => undefined,
        launch: async () => {
          throw new Error("不应启动");
        },
        resolveRoute: async () => ({
          ok: true as const,
          route: {
            connectionMode: "local_cli" as const,
            configId: "cfg" as never,
            configName: "默认配置",
          },
        }),
        describeCaller: async () => ({
          title: "总管",
          projectId: "proj-1",
          projectRoot: root,
          permission: "edit",
        }),
        aliveCount: () => 0,
        maxWindows: async () => 8,
        publish: () => undefined,
      },
    );
    expect(coldDenied.ok).toBe(false);

    const full = createWorkbenchAuthRegistry();
    full.pin({ id: "A", permission: "edit", role: "manager", openedBy: "user" }, "proj-1" as never);
    full.grantManager("A");
    const limited = await openChildWindow(
      "A",
      { cli: "claude", role: "worker", permission: "edit", title: "满" },
      {
        authRegistry: full,
        readLayouts: async () => ({ "proj-1": layout(root) }),
        saveLayout: async () => undefined,
        launch: async () => {
          throw new Error("不应启动");
        },
        resolveRoute: async () => ({
          ok: true as const,
          route: {
            connectionMode: "local_cli" as const,
            configId: "cfg" as never,
            configName: "默认配置",
          },
        }),
        describeCaller: async () => ({
          title: "总管",
          projectId: "proj-1",
          projectRoot: root,
          permission: "edit",
        }),
        aliveCount: () => 0,
        maxWindows: async () => 1,
        publish: () => undefined,
      },
    );
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.error).toContain("上限");
    }
  });

  it("用户→管理者(edit)→子管理者→孙窗口请求 yolo，实际被封顶为 edit", async () => {
    const root = tempDir();
    const registry = createWorkbenchAuthRegistry();
    registry.pin(
      { id: "user-mgr", permission: "edit", role: "manager", openedBy: "user" },
      "proj-1" as never,
    );
    registry.grantManager("user-mgr");
    registry.pin(
      {
        id: "child-mgr",
        permission: "yolo",
        role: "manager",
        openedBy: { windowId: "user-mgr" },
        parentWindowId: "user-mgr",
      },
      "proj-1" as never,
    );
    registry.grantManager("child-mgr");
    const base = layout(root);
    const childWindow: WorkbenchWindow = {
      id: "child-mgr",
      projectId: "proj-1" as never,
      title: "子管理者",
      kind: "claude",
      cwd: root,
      createdAt: 2,
      permission: "yolo",
      role: "manager",
      openedBy: { windowId: "user-mgr" },
      parentWindowId: "user-mgr",
    };
    const withChild: ProjectWorkbenchLayout = {
      ...base,
      windows: { ...base.windows, "child-mgr": childWindow },
    };
    const opened = await openChildWindow(
      "child-mgr",
      { cli: "claude", role: "worker", permission: "yolo", title: "孙" },
      {
        authRegistry: registry,
        readLayouts: async () => ({ "proj-1": withChild }),
        saveLayout: async () => undefined,
        launch: async (input) => {
          expect(input.permission).toBe("yolo");
          const resolved = registry.resolveLaunch(input.windowId, input.permission);
          expect(resolved.effective).toBe("edit");
          return {
            terminal: { id: "term-g" },
            kind: "claude",
            effectivePermission: resolved.effective,
            permissionCapped: resolved.capped,
            profileName: "p",
            command: "claude",
            args: [],
            turnSignal: "manual",
          } as unknown as LaunchCliWindowResult;
        },
        resolveRoute: async () => ({
          ok: true as const,
          route: {
            connectionMode: "local_cli" as const,
            configId: "cfg" as never,
            configName: "默认配置",
          },
        }),
        describeCaller: async () => ({
          title: "子管理者",
          projectId: "proj-1",
          projectRoot: root,
          permission: "yolo",
        }),
        aliveCount: () => 2,
        maxWindows: async () => 8,
        publish: () => undefined,
        newId: () => "grandchild",
      },
    );
    expect(opened).toMatchObject({
      ok: true,
      windowId: "grandchild",
      permission: "edit",
      capped: true,
    });
  });
});

describe("Codex MCP 注入与 shell 环境", () => {
  it("mcp_servers 带上两个环境变量名，参数里没有令牌明文", () => {
    const spec = buildWorkbenchMcpSpec("D:/mod", "D:/electron.exe");
    const injected = injectTokenIntoMcpServers(
      { "ffpane-workbench": spec },
      "super-secret-token",
      "codex-forward",
    );
    const overrides = buildCodexMcpOverrides(injected);
    expect(overrides["mcp_servers.ffpane-workbench.command"]).toContain("electron.exe");
    expect(overrides["mcp_servers.ffpane-workbench.env_vars"]).toContain(FF_PANE_WINDOW_TOKEN_ENV);
    expect(overrides["mcp_servers.ffpane-workbench.env_vars"]).toContain(FF_PANE_WB_PIPE_ENV);
    expect(JSON.stringify(overrides)).not.toContain("super-secret-token");
  });

  it("shell 去掉令牌和管道名，直启 CLI 保留", () => {
    const previousToken = process.env[FF_PANE_WINDOW_TOKEN_ENV];
    const previousPipe = process.env[FF_PANE_WB_PIPE_ENV];
    process.env[FF_PANE_WINDOW_TOKEN_ENV] = "secret";
    process.env[FF_PANE_WB_PIPE_ENV] = "pipe";
    try {
      const shell = baseEnvForCreate({ cwd: "D:/p", cols: 80, rows: 24 });
      expect(shell[FF_PANE_WINDOW_TOKEN_ENV]).toBeUndefined();
      expect(shell[FF_PANE_WB_PIPE_ENV]).toBeUndefined();
      const cli = baseEnvForCreate({
        cwd: "D:/p",
        cols: 80,
        rows: 24,
        direct: { file: "claude.exe", args: [] },
      });
      expect(cli[FF_PANE_WINDOW_TOKEN_ENV]).toBe("secret");
      expect(cli[FF_PANE_WB_PIPE_ENV]).toBe("pipe");
    } finally {
      if (previousToken === undefined) {
        delete process.env[FF_PANE_WINDOW_TOKEN_ENV];
      } else {
        process.env[FF_PANE_WINDOW_TOKEN_ENV] = previousToken;
      }
      if (previousPipe === undefined) {
        delete process.env[FF_PANE_WB_PIPE_ENV];
      } else {
        process.env[FF_PANE_WB_PIPE_ENV] = previousPipe;
      }
    }
  });
});
