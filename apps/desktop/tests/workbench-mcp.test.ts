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
  type WorkbenchToolDeps,
} from "../src/main/workbench/mcp-tools";
import { openChildWindow } from "../src/main/workbench/open-child";
import { buildNewMessageReminder, sanitizeReminderTitle } from "../src/main/workbench/remind";
import {
  assertProjectFiles,
  formatThreadBlock,
  readThreadIndex,
  readThreadIndexText,
  teamFileSlug,
} from "../src/main/workbench/thread-store";
import { handleMcpLine } from "../src/mcp/protocol";
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
    },
    publishInbox: () => undefined,
    getCursor,
    setCursor,
    readOutput: async (windowId, maxBytes) => {
      outputCalls.push({ windowId, maxBytes });
      return { running: true, status: "运行中", text: "ok \u001b[31mRED\u001b[0m" };
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
    searchProjectMemory: async () => [],
    addProjectMemory: async () => undefined,
  };
  return { views, tree, reminders, outputCalls, closedIds, panels, deps };
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
    expect(byName.get("ffpane_open_panel")).toContain("plan");
    expect(byName.get("ffpane_open_panel")).toContain("tasks");
    expect(byName.get("ffpane_open_panel")).toContain("runs");
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

  it("读取去掉 ANSI，并夹紧字节上限", async () => {
    const { deps, outputCalls } = harness(tempDir());
    const capped = await call(deps, "A", "ffpane_read_output", {
      windowId: "B",
      maxBytes: 100_000,
    });
    expect(capped.isError).toBe(false);
    expect(outputCalls[0]).toEqual({ windowId: "B", maxBytes: 32_768 });
    expect(capped.json).toMatchObject({ running: true, text: "ok RED" });
    expect(String((capped.json as { text: string }).text)).not.toContain("\u001b");

    const fallback = await call(deps, "A", "ffpane_read_output", { windowId: "C" });
    expect(outputCalls[1]).toEqual({ windowId: "C", maxBytes: 8192 });
    expect(fallback.isError).toBe(false);

    const idle = await call(
      {
        ...deps,
        readOutput: async () => ({ running: false, status: "该窗口的终端已退出。" }),
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
    expect(text).toContain("（管理者）：消息。请调用 ffpane_read_inbox 查看。");
    expect(text).not.toContain("!");
    expect(sanitizeReminderTitle("总管\r\n\u001b[31m!")).toBe("总管31m");
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
        resolveProfileId: async () => ({ ok: true, profileId: "profile-1" }),
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
        resolveProfileId: async () => ({ ok: true, profileId: "p" }),
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
        resolveProfileId: async () => ({ ok: true, profileId: "p" }),
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
        resolveProfileId: async () => ({ ok: true, profileId: "p" }),
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
        resolveProfileId: async () => ({ ok: true, profileId: "profile-1" }),
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
