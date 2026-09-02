import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_TABLE, commandShortcutDisplay } from "../src/renderer/src/command/commands";
import {
  type CommandHandlerMap,
  type CommandRuntime,
  executeCommand,
  isCommandRunnable,
} from "../src/renderer/src/command/execute";
import {
  mergeHandlers,
  withHandler,
  withoutHandler,
} from "../src/renderer/src/command/handler-registry";
import {
  COMMAND_IDS,
  type CommandId,
  commandKeywordsKey,
  commandTitleKey,
  isCommandId,
  shortcutActionKey,
} from "../src/renderer/src/command/ids";
import { filterBySearch, type SearchableFields } from "../src/renderer/src/command/search";
import {
  chordIdFromEvent,
  createShortcutRegistry,
  formatKeyChord,
  formatShortcutSpec,
  isTextInputTarget,
  type KeyboardEventLike,
  parseKeyChord,
  SHORTCUT_TABLE,
  SHORTCUT_TABLE_SIZE,
  ShortcutConflictError,
  type ShortcutRegistration,
  type ShortcutScope,
} from "../src/renderer/src/command/shortcuts";
import { toIpcErrorInfo, UNKNOWN_IPC_ERROR_CODE } from "../src/renderer/src/ipc/errors";
import {
  IDLE_QUERY_STATE,
  invokeQuery,
  isQueryBusy,
  type QueryState,
  queryReducer,
  shouldShowSkeleton,
} from "../src/renderer/src/ipc/query";
import { bindSubscription } from "../src/renderer/src/ipc/subscription";
import { PAGE_SHORTCUT_ORDER } from "../src/renderer/src/stores/pages";
import type { FfPaneIpcApi } from "../src/shared-ipc/client";
import type { AppInfo } from "../src/shared-ipc/contracts";

// ════════════════════════════════════════════════════════════════════════════
// 假 window.ffpane 注入（node 环境，无 jsdom）
// ════════════════════════════════════════════════════════════════════════════

type GlobalWithWindow = { window?: { ffpane: unknown } };

function installFakeIpc(api: unknown): void {
  (globalThis as unknown as GlobalWithWindow).window = { ffpane: api };
}

function removeFakeIpc(): void {
  delete (globalThis as unknown as GlobalWithWindow).window;
}

afterEach(() => {
  removeFakeIpc();
});

const APP_INFO: AppInfo = {
  name: "FF-pane",
  version: "0.1.0",
  runtime: { electron: "44.0.0", chrome: "140", node: "24.0.0" },
};

// ════════════════════════════════════════════════════════════════════════════
// 快捷键注册表（设计系统 §7）
// ════════════════════════════════════════════════════════════════════════════

/** §7 表格里出现的全部键位（展示形式），25 个绑定去重后 23 个。 */
const EXPECTED_KEY_DISPLAYS: readonly string[] = [
  "Ctrl+K",
  "Ctrl+P",
  "Ctrl+,",
  "Ctrl+/",
  "Esc",
  `Alt+\u2190`,
  `Alt+\u2192`,
  "Ctrl+1",
  "Ctrl+2",
  "Ctrl+3",
  "Ctrl+4",
  "Ctrl+5",
  "Ctrl+6",
  "Ctrl+7",
  "/",
  "\u2191",
  "\u2193",
  "Enter",
  "Ctrl+Enter",
  "Ctrl+I",
  "Ctrl+Shift+R",
  "Ctrl+Shift+A",
  "Ctrl+Shift+X",
];

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEventLike, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {},
): KeyboardEventLike {
  return {
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  };
}

describe("快捷键表：§7 的 19 条预登记齐全", () => {
  const registry = createShortcutRegistry(SHORTCUT_TABLE);

  it("条目数正好 19（一个「命令 × 作用域」一条）", () => {
    expect(SHORTCUT_TABLE).toHaveLength(SHORTCUT_TABLE_SIZE);
    expect(SHORTCUT_TABLE_SIZE).toBe(19);
    expect(registry.entries()).toHaveLength(19);
  });

  it("命令 ID 全部合法且互不重复", () => {
    const ids = SHORTCUT_TABLE.map((entry) => entry.commandId);
    for (const id of ids) {
      expect(isCommandId(id), `未登记的命令 ID：${id}`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条至少一个键位、一个作用域", () => {
    for (const entry of SHORTCUT_TABLE) {
      expect(entry.keys.length, entry.commandId).toBeGreaterThan(0);
      expect(entry.scopes.length, entry.commandId).toBeGreaterThan(0);
    }
  });

  it("键位覆盖 §7 全表：25 个绑定、23 个去重键位", () => {
    const bindings = registry.bindings();
    expect(bindings).toHaveLength(25);
    const displays = [...new Set(bindings.map((binding) => binding.display))].sort();
    expect(displays).toEqual([...EXPECTED_KEY_DISPLAYS].sort());
  });

  it("Ctrl+1 ~ Ctrl+7 是一条命令、七个键位，且与七个页面一一对应", () => {
    const indexed = registry.byCommandId("nav-page-by-index");
    expect(indexed?.keys).toHaveLength(7);
    expect(PAGE_SHORTCUT_ORDER).toHaveLength(7);
  });

  it("无修饰键的键位在输入框内一律失效，唯一例外是 Esc", () => {
    for (const entry of SHORTCUT_TABLE) {
      const bare = entry.keys.every((spec) => {
        const chord = parseKeyChord(spec);
        return !chord.ctrl && !chord.alt && !chord.meta;
      });
      if (!bare) {
        continue;
      }
      if (entry.commandId === "app-dismiss") {
        expect(entry.disabledInTextInput).toBe(false);
      } else {
        expect(entry.disabledInTextInput, `${entry.commandId} 必须在输入框内失效`).toBe(true);
      }
    }
  });

  it("Esc 不吃事件（浮层关闭归 radix / 页面），其余全局键位吃事件", () => {
    expect(registry.byCommandId("app-dismiss")?.preventDefault).toBe(false);
    expect(registry.byCommandId("palette-open")?.preventDefault).toBe(true);
  });
});

describe("键位解析与展示", () => {
  it("修饰键顺序固定、主键大小写无关", () => {
    expect(chordIdFromEvent(keyEvent("A", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+a");
    expect(chordIdFromEvent(keyEvent("a", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+a");
    expect(formatKeyChord(parseKeyChord("shift+ctrl+a"))).toBe("Ctrl+Shift+A");
  });

  it("命名键有专门展示形式", () => {
    expect(formatShortcutSpec("Escape")).toBe("Esc");
    expect(formatShortcutSpec("Alt+ArrowLeft")).toBe(`Alt+\u2190`);
    expect(formatShortcutSpec("Ctrl+Enter")).toBe("Ctrl+Enter");
    expect(formatShortcutSpec("Ctrl+,")).toBe("Ctrl+,");
  });

  it("非法键位串直接抛错（而不是静默注册一个永不触发的键位）", () => {
    expect(() => parseKeyChord("Hyper+K")).toThrow(/unknown shortcut modifier/);
    expect(() => parseKeyChord("")).toThrow(/invalid shortcut spec/);
  });
});

describe("冲突检测：重复键位注册抛错", () => {
  function entry(
    overrides: Partial<ShortcutRegistration> & { commandId: CommandId },
  ): ShortcutRegistration {
    return {
      keys: ["Ctrl+K"],
      scopes: ["global"],
      disabledInTextInput: false,
      preventDefault: true,
      ...overrides,
    };
  }

  it("同键位 + 作用域相交 → ShortcutConflictError", () => {
    const registry = createShortcutRegistry();
    registry.register(entry({ commandId: "tasks-accept", keys: ["Ctrl+E"], scopes: ["tasks"] }));
    expect(() =>
      registry.register(
        entry({ commandId: "tasks-dispatch", keys: ["Ctrl+E"], scopes: ["tasks"] }),
      ),
    ).toThrow(ShortcutConflictError);
  });

  it("页面键位不得覆盖全局键位（§7 冲突规则）", () => {
    const registry = createShortcutRegistry(SHORTCUT_TABLE);
    let thrown: unknown;
    try {
      // nav-projects 尚未在 §7 表里占键位，模拟页面工单私自抢 Ctrl+K
      registry.register(
        entry({ commandId: "nav-projects", keys: ["Ctrl+K"], scopes: ["session"] }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ShortcutConflictError);
    expect((thrown as ShortcutConflictError).existingCommandId).toBe("palette-open");
    expect((thrown as ShortcutConflictError).chordId).toBe("ctrl+k");
  });

  it("同键位但作用域不相交且都非全局 → 允许（Ctrl+Enter 在会话输入框与任务页各有其义）", () => {
    expect(() => createShortcutRegistry(SHORTCUT_TABLE)).not.toThrow();
    const registry = createShortcutRegistry(SHORTCUT_TABLE);
    expect(registry.byCommandId("session-send")?.keys).toEqual(["Ctrl+Enter"]);
    expect(registry.byCommandId("tasks-dispatch")?.keys).toEqual(["Ctrl+Enter"]);
  });

  it("同一命令重复登记直接抛错", () => {
    const registry = createShortcutRegistry();
    registry.register(entry({ commandId: "palette-open" }));
    expect(() => registry.register(entry({ commandId: "palette-open", keys: ["Ctrl+J"] }))).toThrow(
      /already registered/,
    );
  });
});

describe("输入框作用域判定（§6.4：单字母键在输入框内失效）", () => {
  it("文本类 input / textarea / contenteditable 算输入框", () => {
    expect(isTextInputTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextInputTarget({ tagName: "input", type: "search" })).toBe(true);
    expect(isTextInputTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextInputTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextInputTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("非文本控件、只读控件与空目标不算输入框", () => {
    expect(isTextInputTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextInputTarget({ tagName: "INPUT", type: "button" })).toBe(false);
    expect(isTextInputTarget({ tagName: "SELECT" })).toBe(false);
    expect(isTextInputTarget({ tagName: "DIV" })).toBe(false);
    // 只读的路径/ID 输入框要能被选中复制，单字母键仍应生效
    expect(isTextInputTarget({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isTextInputTarget({ tagName: "TEXTAREA", readOnly: true })).toBe(false);
    expect(isTextInputTarget(null)).toBe(false);
    expect(isTextInputTarget(undefined)).toBe(false);
  });
});

describe("作用域解析：全局优先、未上报的作用域不触发", () => {
  const registry = createShortcutRegistry(SHORTCUT_TABLE);

  it("全局键位在任何作用域下都命中", () => {
    const match = registry.resolve({
      event: keyEvent("k", { ctrlKey: true }),
      activeScopes: [],
      inTextInput: false,
    });
    expect(match?.registration.commandId).toBe("palette-open");
  });

  it("全局键位在输入框内依然命中（Ctrl 组合键不受输入框影响）", () => {
    const match = registry.resolve({
      event: keyEvent("k", { ctrlKey: true }),
      activeScopes: ["session", "session-input"],
      inTextInput: true,
    });
    expect(match?.registration.commandId).toBe("palette-open");
  });

  it("Esc 在输入框内仍然命中（取消当前编辑）", () => {
    const match = registry.resolve({
      event: keyEvent("Escape"),
      activeScopes: [],
      inTextInput: true,
    });
    expect(match?.registration.commandId).toBe("app-dismiss");
  });

  it("「/」在页面作用域命中，在输入框内失效", () => {
    const context = { event: keyEvent("/"), activeScopes: ["page"] as readonly ShortcutScope[] };
    expect(registry.resolve({ ...context, inTextInput: false })?.registration.commandId).toBe(
      "page-focus-search",
    );
    expect(registry.resolve({ ...context, inTextInput: true })).toBeUndefined();
  });

  it("未上报作用域的键位不触发", () => {
    expect(
      registry.resolve({ event: keyEvent("ArrowDown"), activeScopes: [], inTextInput: false }),
    ).toBeUndefined();
    expect(
      registry.resolve({
        event: keyEvent("ArrowDown"),
        activeScopes: ["list"],
        inTextInput: false,
      })?.registration.commandId,
    ).toBe("list-move-down");
  });

  it("同键位按作用域分流：Ctrl+Enter 在会话输入框发消息、在任务页派发任务", () => {
    const event = keyEvent("Enter", { ctrlKey: true });
    expect(
      registry.resolve({ event, activeScopes: ["session-input"], inTextInput: true })?.registration
        .commandId,
    ).toBe("session-send");
    expect(
      registry.resolve({ event, activeScopes: ["tasks"], inTextInput: false })?.registration
        .commandId,
    ).toBe("tasks-dispatch");
  });

  it("Ctrl+Shift+A 在任务页是接受任务、在记忆审核是通过候选", () => {
    const event = keyEvent("A", { ctrlKey: true, shiftKey: true });
    expect(
      registry.resolve({ event, activeScopes: ["tasks"], inTextInput: false })?.registration
        .commandId,
    ).toBe("tasks-accept");
    expect(
      registry.resolve({ event, activeScopes: ["memory-review"], inTextInput: false })?.registration
        .commandId,
    ).toBe("memory-approve");
  });

  it("未登记的键位返回 undefined", () => {
    expect(
      registry.resolve({
        event: keyEvent("q", { ctrlKey: true, altKey: true }),
        activeScopes: ["page", "list"],
        inTextInput: false,
      }),
    ).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 命令表与执行器
// ════════════════════════════════════════════════════════════════════════════

describe("命令表：面板条目与键位展示", () => {
  const registry = createShortcutRegistry(SHORTCUT_TABLE);

  it("三个分组都非空，命令 ID 不重复且全部合法", () => {
    const ids = COMMAND_TABLE.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isCommandId(id)).toBe(true);
    }
    for (const group of ["navigation", "action", "settings"] as const) {
      expect(COMMAND_TABLE.some((command) => command.group === group)).toBe(true);
    }
  });

  it("七个页面导航命令的键位由 Ctrl+1~7 推导出来", () => {
    expect(commandShortcutDisplay(registry, "nav-projects")).toBe("Ctrl+1");
    expect(commandShortcutDisplay(registry, "nav-session")).toBe("Ctrl+2");
    expect(commandShortcutDisplay(registry, "nav-knowledge")).toBe("Ctrl+7");
    expect(commandShortcutDisplay(registry, "settings-open")).toBe("Ctrl+,");
  });
});

describe("命令执行：导航经注入回调、未接入的动作不假装成功", () => {
  function createRuntime(handlers: CommandHandlerMap = {}): {
    runtime: CommandRuntime;
    navigate: ReturnType<typeof vi.fn>;
    openPalette: ReturnType<typeof vi.fn>;
    closePalette: ReturnType<typeof vi.fn>;
  } {
    const navigate = vi.fn();
    const openPalette = vi.fn();
    const closePalette = vi.fn();
    return {
      runtime: { navigate, handlers, openPalette, closePalette },
      navigate,
      openPalette,
      closePalette,
    };
  }

  it("页面导航命令调用注入的 navigate（不 import router）", () => {
    const { runtime, navigate } = createRuntime();
    expect(executeCommand("nav-tasks", runtime)).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ kind: "page", page: "tasks" });
  });

  it("Ctrl+N 按命中的数字键决定目标页面", () => {
    const { runtime, navigate } = createRuntime();
    expect(executeCommand("nav-page-by-index", runtime, "3")).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ kind: "page", page: PAGE_SHORTCUT_ORDER[2] });
    expect(executeCommand("nav-page-by-index", runtime, "9")).toBe(false);
  });

  it("前进后退走 history 目标", () => {
    const { runtime, navigate } = createRuntime();
    executeCommand("nav-back", runtime);
    expect(navigate).toHaveBeenCalledWith({ kind: "history", direction: "back" });
  });

  it("面板模式命令切换模式，Esc 收起面板", () => {
    const { runtime, openPalette, closePalette } = createRuntime();
    executeCommand("palette-open", runtime);
    executeCommand("palette-projects", runtime);
    executeCommand("help-shortcuts", runtime);
    expect(openPalette.mock.calls.map((call) => call[0])).toEqual([
      "commands",
      "projects",
      "shortcuts",
    ]);
    executeCommand("app-dismiss", runtime);
    expect(closePalette).toHaveBeenCalledTimes(1);
  });

  it("未注入 handler 的动作返回 false，注入后立即可用", () => {
    const { runtime } = createRuntime();
    expect(isCommandRunnable("session-send", {})).toBe(false);
    expect(executeCommand("session-send", runtime)).toBe(false);

    const send = vi.fn();
    const wired = createRuntime({ "session-send": send });
    expect(isCommandRunnable("session-send", { "session-send": send })).toBe(true);
    expect(executeCommand("session-send", wired.runtime)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 页面自报动作（T8.1：registerCommand / useCommandHandler 的纯逻辑内核）
// ════════════════════════════════════════════════════════════════════════════

describe("页面自报动作表：登记 / 注销 / 与 prop 合并", () => {
  it("登记后该命令可执行", () => {
    const open = vi.fn();
    const handlers = withHandler({}, "session-insert-knowledge", open);
    expect(isCommandRunnable("session-insert-knowledge", handlers)).toBe(true);
    expect(
      executeCommand("session-insert-knowledge", {
        navigate: vi.fn(),
        handlers,
        openPalette: vi.fn(),
        closePalette: vi.fn(),
      }),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("注销后回到「待接入」", () => {
    const open = vi.fn();
    const registered = withHandler({}, "session-insert-knowledge", open);
    const cleared = withoutHandler(registered, "session-insert-knowledge", open);
    expect(isCommandRunnable("session-insert-knowledge", cleared)).toBe(false);
  });

  it("重挂载时「新的先挂、旧的后卸」不会把新 handler 一并注销", () => {
    // 这是本机制唯一容易错的地方：错了的表现是命令在路由往返后静默失效
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const afterRemount = withHandler(
      withHandler({}, "session-insert-knowledge", oldHandler),
      "session-insert-knowledge",
      newHandler,
    );
    // 旧实例此刻才执行它的注销
    const settled = withoutHandler(afterRemount, "session-insert-knowledge", oldHandler);
    expect(settled["session-insert-knowledge"]).toBe(newHandler);
    expect(isCommandRunnable("session-insert-knowledge", settled)).toBe(true);
  });

  it("注销不认识的命令 / 不是自己那份时原样返回（引用不变，不触发无谓重渲染）", () => {
    const handlers = withHandler({}, "session-send", vi.fn());
    expect(withoutHandler(handlers, "tasks-accept", vi.fn())).toBe(handlers);
    expect(withoutHandler(handlers, "session-send", vi.fn())).toBe(handlers);
  });

  it("与挂载方 prop 合并时 prop 优先（集成方显式给的动作不被页面顶掉）", () => {
    const fromPage = vi.fn();
    const fromProp = vi.fn();
    const merged = mergeHandlers({ "session-send": fromPage }, { "session-send": fromProp });
    expect(merged["session-send"]).toBe(fromProp);
    // 页面独有的动作照常保留
    const both = mergeHandlers(
      { "session-insert-knowledge": fromPage },
      { "session-send": fromProp },
    );
    expect(both["session-insert-knowledge"]).toBe(fromPage);
    expect(both["session-send"]).toBe(fromProp);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 命令搜索匹配（中英文）
// ════════════════════════════════════════════════════════════════════════════

describe("命令搜索：中英文均可命中", () => {
  const items: readonly SearchableFields[] = [
    {
      id: "nav-session",
      title: "转到会话页",
      keywords: "session chat conversation 会话 对话 聊天",
      shortcut: "Ctrl+2",
    },
    {
      id: "nav-tasks",
      title: "Go to tasks",
      keywords: "tasks board 任务 看板 进度",
      shortcut: "Ctrl+4",
    },
    {
      id: "palette-open",
      title: "打开命令面板",
      keywords: "command palette 命令 面板 搜索",
      shortcut: "Ctrl+K",
    },
  ];

  function ids(query: string): readonly string[] {
    return filterBySearch(items, query).map((item) => item.id);
  }

  it("中文标题可命中", () => {
    expect(ids("会话")).toEqual(["nav-session"]);
    expect(ids("命令面板")).toEqual(["palette-open"]);
  });

  it("中文界面下输入英文关键词同样命中（关键词双语混排）", () => {
    expect(ids("session")).toEqual(["nav-session"]);
    expect(ids("palette")).toEqual(["palette-open"]);
  });

  it("英文标题可命中，且中文关键词也能搜到它", () => {
    expect(ids("tasks")).toEqual(["nav-tasks"]);
    expect(ids("任务")).toEqual(["nav-tasks"]);
  });

  it("键位串可直接搜索", () => {
    expect(ids("Ctrl+K")).toEqual(["palette-open"]);
  });

  it("模糊（子序列）匹配可命中英文标题", () => {
    expect(ids("gtt")).toEqual(["nav-tasks"]);
  });

  it("多个词按 AND，任一词不命中则整项落选", () => {
    expect(ids("session 会话")).toEqual(["nav-session"]);
    expect(ids("session 任务")).toEqual([]);
  });

  it("标题命中排在关键词命中之前", () => {
    const ranked = filterBySearch(
      [
        { id: "by-keyword", title: "设置", keywords: "面板 palette settings" },
        { id: "by-title", title: "命令面板", keywords: "command" },
      ],
      "面板",
    );
    expect(ranked.map((item) => item.id)).toEqual(["by-title", "by-keyword"]);
  });

  it("空查询返回全部并保持原序；无命中返回空", () => {
    expect(ids("")).toEqual(["nav-session", "nav-tasks", "palette-open"]);
    expect(ids("   ")).toEqual(["nav-session", "nav-tasks", "palette-open"]);
    expect(ids("zzzz")).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// invokeQuery 状态机与错误字段传递
// ════════════════════════════════════════════════════════════════════════════

describe("invokeQuery：成功 / 失败 / 错误字段传递", () => {
  it("成功落成 success 状态，data 原样带回", async () => {
    installFakeIpc({
      invoke: (channel: string) => {
        expect(channel).toBe("app:get-info");
        return Promise.resolve(APP_INFO);
      },
      subscribe: () => () => undefined,
    });
    const state = await invokeQuery("app:get-info");
    expect(state).toEqual({ status: "success", data: APP_INFO, refreshing: false });
  });

  it("请求体原样传给传输层", async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({ reply: "pong", echoed: "hi", repliedAt: 1 } as const),
    );
    installFakeIpc({ invoke, subscribe: () => () => undefined });
    await invokeQuery("app:ping", { message: "hi", sentAt: 7 });
    expect(invoke).toHaveBeenCalledWith("app:ping", { message: "hi", sentAt: 7 });
  });

  it("失败落成 error 状态，永不 reject", async () => {
    installFakeIpc({
      invoke: () => Promise.reject(new Error("boom")),
      subscribe: () => () => undefined,
    });
    const state = await invokeQuery("app:get-info");
    expect(state.status).toBe("error");
    if (state.status !== "error") {
      throw new Error("expected error state");
    }
    expect(state.retrying).toBe(false);
    expect(state.error.message).toBe("boom");
    expect(state.error.channel).toBe("app:get-info");
  });

  it("错误对象过 IPC 后按 code / message / path 字段传递（不依赖 instanceof）", async () => {
    // 结构化克隆后的普通对象：原型链已丢失，任何 instanceof 判定都会失效
    const wireError = {
      code: "E_SQLITE_MISSING",
      message: "sqlite native module not found",
      path: "C:/app/better_sqlite3.node",
    };
    installFakeIpc({
      invoke: () => Promise.reject(wireError),
      subscribe: () => () => undefined,
    });
    const state = await invokeQuery("diagnostics:check-sqlite");
    if (state.status !== "error") {
      throw new Error("expected error state");
    }
    expect(state.error).toEqual({
      code: "E_SQLITE_MISSING",
      message: "sqlite native module not found",
      path: "C:/app/better_sqlite3.node",
      channel: "diagnostics:check-sqlite",
    });
  });

  it("window.ffpane 缺失时也落成 error 状态（而不是抛穿到调用方）", async () => {
    const state = await invokeQuery("app:get-info");
    if (state.status !== "error") {
      throw new Error("expected error state");
    }
    expect(state.error.message).toContain("window.ffpane");
    expect(state.error.channel).toBe("app:get-info");
  });
});

describe("toIpcErrorInfo：字段优先级与兜底", () => {
  it("code 优先取 code，其次远端 name，最后本地 name", () => {
    expect(toIpcErrorInfo({ code: "E_X", message: "m", name: "TypeError" }).code).toBe("E_X");
    expect(
      toIpcErrorInfo({ name: "IpcInvokeError", remoteName: "SqliteError", message: "m" }).code,
    ).toBe("SqliteError");
    expect(toIpcErrorInfo(new TypeError("bad")).code).toBe("TypeError");
  });

  it("非对象抛出物也能拿到可读 message", () => {
    expect(toIpcErrorInfo("plain string failure").message).toBe("plain string failure");
    expect(toIpcErrorInfo(undefined).code).toBe(UNKNOWN_IPC_ERROR_CODE);
    expect(toIpcErrorInfo(undefined).message.length).toBeGreaterThan(0);
  });

  it("抛出物自带 channel 时优先于调用方传入的通道名", () => {
    expect(toIpcErrorInfo({ message: "m", channel: "app:ping" }, "app:get-info").channel).toBe(
      "app:ping",
    );
    expect(toIpcErrorInfo({ message: "m" }, "app:get-info").channel).toBe("app:get-info");
  });

  it("缺失字段不出现在结果里（供三态组件按存在性渲染）", () => {
    const info = toIpcErrorInfo({ message: "m" });
    expect("path" in info).toBe(false);
    expect("channel" in info).toBe(false);
  });
});

describe("queryReducer：骨架只在首次加载出现", () => {
  it("idle → loading → success", () => {
    const loading = queryReducer<AppInfo>(IDLE_QUERY_STATE, { type: "start" });
    expect(loading).toEqual({ status: "loading" });
    expect(shouldShowSkeleton(loading)).toBe(true);
    const success = queryReducer<AppInfo>(loading, {
      type: "settle",
      state: { status: "success", data: APP_INFO, refreshing: false },
    });
    expect(success).toEqual({ status: "success", data: APP_INFO, refreshing: false });
    expect(shouldShowSkeleton(success)).toBe(false);
  });

  it("已有数据时刷新进 refreshing，内容不被骨架替换（设计系统 §5.8）", () => {
    const success: QueryState<AppInfo> = {
      status: "success",
      data: APP_INFO,
      refreshing: false,
    };
    const refreshing = queryReducer(success, { type: "start" });
    expect(refreshing).toEqual({ status: "success", data: APP_INFO, refreshing: true });
    expect(shouldShowSkeleton(refreshing)).toBe(false);
    expect(isQueryBusy(refreshing)).toBe(true);
  });

  it("错误态重试进 retrying，错误原文保留", () => {
    const error: QueryState<AppInfo> = {
      status: "error",
      error: { code: "E", message: "raw error text" },
      retrying: false,
    };
    const retrying = queryReducer(error, { type: "start" });
    expect(retrying).toEqual({
      status: "error",
      error: { code: "E", message: "raw error text" },
      retrying: true,
    });
    expect(isQueryBusy(retrying)).toBe(true);
    expect(shouldShowSkeleton(retrying)).toBe(false);
  });

  it("reset 回到 idle", () => {
    const success: QueryState<AppInfo> = { status: "success", data: APP_INFO, refreshing: false };
    expect(queryReducer(success, { type: "reset" })).toEqual({ status: "idle" });
    expect(isQueryBusy(IDLE_QUERY_STATE)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 订阅清理语义（useSubscription 的纯逻辑内核）
// ════════════════════════════════════════════════════════════════════════════

describe("bindSubscription：订阅一次、解绑幂等、迟到事件丢弃", () => {
  interface FakeTransport {
    readonly api: FfPaneIpcApi;
    readonly subscribeCalls: () => number;
    readonly releaseCalls: () => number;
    readonly emit: (payload: { seq: number; emittedAt: number }) => void;
  }

  function createFakeTransport(): FakeTransport {
    const listeners: ((payload: { seq: number; emittedAt: number }) => void)[] = [];
    let subscribeCalls = 0;
    let releaseCalls = 0;
    const api = {
      invoke: () => Promise.reject(new Error("invoke not used here")),
      subscribe: (_channel: string, listener: (payload: never) => void) => {
        subscribeCalls += 1;
        listeners.push(
          listener as unknown as (payload: { seq: number; emittedAt: number }) => void,
        );
        return () => {
          releaseCalls += 1;
        };
      },
    } as unknown as FfPaneIpcApi;
    return {
      api,
      subscribeCalls: () => subscribeCalls,
      releaseCalls: () => releaseCalls,
      emit: (payload) => {
        for (const listener of listeners) {
          listener(payload);
        }
      },
    };
  }

  it("事件打到当前监听器上，且只订阅一次", () => {
    const transport = createFakeTransport();
    const received: number[] = [];
    let listener = (payload: { seq: number }): void => {
      received.push(payload.seq);
    };
    const binding = bindSubscription(transport.api, "smoke:event", () => listener);

    transport.emit({ seq: 1, emittedAt: 0 });
    // 回调身份变化（每次渲染新建的箭头函数）不重建订阅，新事件打到新回调
    listener = (payload: { seq: number }): void => {
      received.push(payload.seq * 100);
    };
    transport.emit({ seq: 2, emittedAt: 0 });

    expect(received).toEqual([1, 200]);
    expect(transport.subscribeCalls()).toBe(1);
    expect(binding.isActive()).toBe(true);
  });

  it("解绑幂等，且解绑后迟到事件不再触碰监听器", () => {
    const transport = createFakeTransport();
    const received: number[] = [];
    const binding = bindSubscription(transport.api, "smoke:event", () => (payload) => {
      received.push(payload.seq);
    });

    transport.emit({ seq: 1, emittedAt: 0 });
    binding.unsubscribe();
    binding.unsubscribe();
    binding.unsubscribe();
    // 传输层与解绑之间存在竞态窗口：即使还有事件挤进来也必须被丢掉
    transport.emit({ seq: 2, emittedAt: 0 });

    expect(received).toEqual([1]);
    expect(transport.releaseCalls()).toBe(1);
    expect(binding.isActive()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 语言包完整性：命令面板不允许出现裸 key
// ════════════════════════════════════════════════════════════════════════════

describe("挂载入口：模块图在运行时可解析", () => {
  // 说明符声明为 string 而非字面量：tests 归 tsconfig.node.json（未开 --jsx），
  // 静态引用 .tsx 会让 typecheck 失败；这里只验证运行时可解析，类型面由 tsconfig.web 覆盖。
  const tsxEntries: readonly (readonly [string, string])[] = [
    ["../src/renderer/src/command/CommandPaletteProvider", "CommandPaletteProvider"],
    ["../src/renderer/src/command/CommandPalette", "CommandPalette"],
  ];

  it("CommandPaletteProvider 与 CommandPalette 可被加载", async () => {
    for (const [specifier, exportName] of tsxEntries) {
      const loaded = (await import(specifier)) as Record<string, unknown>;
      expect(typeof loaded[exportName], specifier).toBe("function");
    }
  });

  it("App.tsx 真的挂了命令面板（T8.1：此前只有一句「待接线」注释）", async () => {
    // 读源码而不是渲染：本仓无 @testing-library/react。这条断言防的是
    // 「Provider 被谁顺手摘掉、面板悄悄回到不可用」——那在功能测试里表现为
    // 一个没人会主动去按的快捷键失灵，很久都不会被发现。
    const source = readFileSync(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("CommandPaletteProvider");
  });

  it("AppLayout 不再自建键盘监听（页面切换键位只由注册表处理；第二个实现实测虽因捕获阶段停传而收不到按键，但留着就依赖远处实现细节）", async () => {
    const source = readFileSync(
      new URL("../src/renderer/src/layout/AppLayout.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("addEventListener");
  });

  it("ipc 与 stores 的对外出口可被加载", async () => {
    const ipc = await import("../src/renderer/src/ipc/index");
    expect(typeof ipc.invokeQuery).toBe("function");
    expect(typeof ipc.useSubscription).toBe("function");
  });
});

describe("语言包：命令与快捷键文案两语言齐全", () => {
  const tags = ["zh-CN", "en-US"] as const;

  function loadLocale(tag: string): Record<string, unknown> {
    const url = new URL(`../../../locales/${tag}.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
  }

  function readPath(pack: Record<string, unknown>, path: string): unknown {
    let current: unknown = pack;
    for (const segment of path.split(".")) {
      if (typeof current !== "object" || current === null) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  it("每个命令 ID 都有标题与搜索关键词", () => {
    for (const tag of tags) {
      const pack = loadLocale(tag);
      for (const id of COMMAND_IDS) {
        expect(readPath(pack, commandTitleKey(id)), `${tag} 缺 ${commandTitleKey(id)}`).toEqual(
          expect.any(String),
        );
        expect(
          readPath(pack, commandKeywordsKey(id)),
          `${tag} 缺 ${commandKeywordsKey(id)}`,
        ).toEqual(expect.any(String));
      }
    }
  });

  it("19 条快捷键都有作用描述，7 个作用域都有名称", () => {
    for (const tag of tags) {
      const pack = loadLocale(tag);
      for (const entry of SHORTCUT_TABLE) {
        expect(
          readPath(pack, shortcutActionKey(entry.commandId)),
          `${tag} 缺 ${shortcutActionKey(entry.commandId)}`,
        ).toEqual(expect.any(String));
      }
      const scopes = new Set(SHORTCUT_TABLE.flatMap((entry) => entry.scopes));
      for (const scope of scopes) {
        expect(readPath(pack, `shortcut.scope.${scope}`), `${tag} 缺 scope ${scope}`).toEqual(
          expect.any(String),
        );
      }
    }
  });

  it("关键词两语言都混排中英文，保证跨语言可搜", () => {
    const cjk = /[\u4e00-\u9fff]/u;
    const latin = /[a-z]/;
    for (const tag of tags) {
      const pack = loadLocale(tag);
      for (const id of COMMAND_IDS) {
        const keywords = String(readPath(pack, commandKeywordsKey(id)));
        expect(cjk.test(keywords), `${tag} ${id} 关键词缺中文`).toBe(true);
        expect(latin.test(keywords), `${tag} ${id} 关键词缺英文`).toBe(true);
      }
    }
  });
});
