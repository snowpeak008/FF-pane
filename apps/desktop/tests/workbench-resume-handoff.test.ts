/**
 * 重开项目后续接：不用选择器、桌面版归档过的放回来、续接后补交接（2026-10-23 监管者实录）。
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureCodexSessionActive,
  latestConversationId,
  planResume,
  resumeHandoffText,
} from "../src/main/workbench/resume-handoff";

/** 监管者那个会话：FF-pane 开的，被 Codex 桌面版打开后归档。 */
const SUPERVISOR = "01a160eb-ac37-7fa0-a68a-ed898d0dce2b";
const HOME = join("C:", "fake-codex-home");

/** 只认得 where 那个目录下、以这个编号结尾的文件。 */
function filesIn(...where: Array<"sessions" | "archived_sessions">) {
  const present = new Set<string>(where);
  return (path: string): boolean => {
    if (!path.endsWith(`-${SUPERVISOR}.jsonl`)) {
      return false;
    }
    const inArchive = path.includes(join(HOME, "archived_sessions"));
    return inArchive ? present.has("archived_sessions") : present.has("sessions");
  };
}

const CONVERSATIONS = [
  { id: "01a15000-0000-7000-8000-000000000000", startedAt: 1, lastActiveAt: 10 },
  { id: SUPERVISOR, startedAt: 2, lastActiveAt: 20 },
];

describe("latestConversationId", () => {
  it("取最近用过的那一次，空的和空编号不算", () => {
    expect(latestConversationId(CONVERSATIONS)).toBe(SUPERVISOR);
    expect(latestConversationId([])).toBeUndefined();
    expect(latestConversationId(undefined)).toBeUndefined();
    expect(latestConversationId([{ id: " ", startedAt: 1, lastActiveAt: 99 }])).toBeUndefined();
  });
});

describe("ensureCodexSessionActive", () => {
  it("会话在 sessions 里：直接续接，不跑 unarchive", async () => {
    const unarchive = vi.fn(async () => true);
    const state = await ensureCodexSessionActive(SUPERVISOR, {
      codexHome: HOME,
      exists: filesIn("sessions"),
      unarchive,
    });
    expect(state).toBe("active");
    expect(unarchive).not.toHaveBeenCalled();
  });

  it("被归档了：跑 codex unarchive，放回来后可以续接", async () => {
    let restored = false;
    const unarchive = vi.fn(async (id: string) => {
      expect(id).toBe(SUPERVISOR);
      restored = true;
      return true;
    });
    const state = await ensureCodexSessionActive(SUPERVISOR, {
      codexHome: HOME,
      exists: (path) => filesIn(restored ? "sessions" : "archived_sessions")(path),
      unarchive,
    });
    expect(state).toBe("restored");
  });

  it("归档里有但放不回来：failed；两处都没有：missing", async () => {
    expect(
      await ensureCodexSessionActive(SUPERVISOR, {
        codexHome: HOME,
        exists: filesIn("archived_sessions"),
        unarchive: async () => false,
      }),
    ).toBe("failed");
    expect(
      await ensureCodexSessionActive(SUPERVISOR, {
        codexHome: HOME,
        exists: filesIn(),
        unarchive: async () => true,
      }),
    ).toBe("missing");
  });
});

describe("planResume", () => {
  const deps = { codexHome: HOME, exists: filesIn("sessions"), unarchive: async () => true };

  it("Codex 布局里没记编号：用窗口自己记下的最近一次，不打开会列出别处对话的选择器", async () => {
    const plan = await planResume(
      { kind: "codex", resume: true, firstLaunchThisRun: true, conversations: CONVERSATIONS },
      deps,
    );
    expect(plan).toEqual({ resume: true, nativeSessionId: SUPERVISOR, handoff: "restart" });
  });

  it("Codex 一次对话都没记下：开新对话并补「新对话」交接，不走选择器", async () => {
    const plan = await planResume(
      { kind: "codex", resume: true, firstLaunchThisRun: true, conversations: [] },
      deps,
    );
    expect(plan).toEqual({ resume: false, handoff: "new-conversation" });
  });

  it("Codex 会话被归档又放不回来：开新对话并补「新对话」交接", async () => {
    const plan = await planResume(
      { kind: "codex", resume: true, firstLaunchThisRun: false, nativeSessionId: SUPERVISOR },
      { codexHome: HOME, exists: filesIn("archived_sessions"), unarchive: async () => false },
    );
    expect(plan).toEqual({ resume: false, handoff: "new-conversation" });
  });

  it("同一次运行里再续接（平台或用户重启窗口）：不补交接", async () => {
    const plan = await planResume(
      { kind: "claude", resume: true, firstLaunchThisRun: false, nativeSessionId: "abc" },
      deps,
    );
    expect(plan).toEqual({ resume: true, nativeSessionId: "abc" });
  });

  it("不续接：照原样，不补交接", async () => {
    expect(
      await planResume({ kind: "codex", resume: false, firstLaunchThisRun: true }, deps),
    ).toEqual({ resume: false });
  });
});

describe("resumeHandoffText", () => {
  it("重启后续接：一行，写明角色、开它的窗口、未读和待处理页", () => {
    const text = resumeHandoffText({
      reason: "restart",
      title: "Claude 1",
      role: "manager",
      unread: 3,
      digestPath: ".ffpane/briefs/待处理-win-193433ff-7d6.md",
    });
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain("软件重启过");
    expect(text).toContain("管理者");
    expect(text).toContain("收件箱有 3 条没读");
    expect(text).toContain(".ffpane/briefs/待处理-win-193433ff-7d6.md");
  });

  it("换成了新对话：说明不记得之前的事，不说「从停下的地方接着做」", () => {
    const text = resumeHandoffText({
      reason: "new-conversation",
      title: "监管3\n",
      role: "supervisor",
      openerTitle: "Claude 1",
      unread: 0,
    });
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain("你不记得之前的事");
    expect(text).toContain("你是「监管3」，监管者，由「Claude 1」开启");
    expect(text).not.toContain("从停下的地方");
  });
});
