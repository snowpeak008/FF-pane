/**
 * 工作台布局 store（T10.2 / T10.2'）：多项目并行布局、分屏树、标签页。
 * 布局经 IPC 落盘（防抖）；退出前 flush；PTY 生命周期与窗口 id 解耦；
 * hydrate 时与主进程存活 PTY 对账。
 */

import type {
  PaneSplitDirection,
  ProjectId,
  ProjectWorkbenchLayout,
  WorkbenchOpenedBy,
  WorkbenchPermissionLevel,
  WorkbenchRole,
  WorkbenchTab,
  WorkbenchWindow,
} from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isAiWorkbenchKind,
  noteWorkbenchConversation,
  WORKBENCH_PERMISSION_RANK,
} from "@ff-pane/shared";
import { create } from "zustand";
import { detachWindowFromLayout } from "../../../shared/workbench/detach-window";
import {
  collectWindowIds,
  leafPane,
  splitLeaf,
  updateSplitSizesByKey,
} from "../../../shared/workbench/pane-tree";
import { placeOpenedWindow } from "../../../shared/workbench/place-child";
import { planTerminalReconcile } from "../../../shared/workbench/reconcile-terminals";
import type {
  WorkbenchChildWindowEvent,
  WorkbenchInboxNoticeEvent,
} from "../../../shared-ipc/contracts";
import { invokeQuery } from "../ipc/query";
import { forgetLiveTerminals, rememberLiveTerminal } from "../pages/workbench/live-terminals";

const PERSIST_DEBOUNCE_MS = 400;

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

function emptyLayout(projectId: ProjectId): ProjectWorkbenchLayout {
  return {
    projectId,
    tabs: [],
    activeTabId: null,
    windows: {},
    maximizedWindowId: null,
    focusedWindowId: null,
  };
}

export interface WorkbenchStoreState {
  readonly layoutsByProject: Readonly<Record<string, ProjectWorkbenchLayout>>;
  readonly hydrated: boolean;
  /** cwd 不存在而回退到项目根的窗口 id（展示一次提示后可清除）。 */
  readonly cwdFallbackWindowIds: ReadonlySet<string>;
  /** 未读数与最近汇报状态。只活在本会话，不写入项目布局。 */
  readonly inboxByWindow: Readonly<
    Record<
      string,
      {
        readonly unread: number;
        readonly lastReportStatus?: "done" | "blocked" | "failed" | "progress";
      }
    >
  >;
}

export interface WorkbenchStoreActions {
  readonly hydrate: () => Promise<void>;
  readonly getProjectLayout: (projectId: ProjectId) => ProjectWorkbenchLayout;
  readonly countRunningWindows: (projectId?: ProjectId) => number;
  readonly createTabWithWindow: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly title?: string;
    readonly kind?: WorkbenchWindow["kind"];
    readonly initialPrompt?: string;
    readonly permission?: WorkbenchPermissionLevel;
    readonly role?: WorkbenchRole;
    readonly parentWindowId?: string;
    readonly openedBy?: WorkbenchOpenedBy;
  }) => { readonly ok: true; readonly windowId: string; readonly autoLaunch: boolean };
  readonly splitWindow: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly targetWindowId: string;
    readonly direction: PaneSplitDirection;
    readonly kind?: WorkbenchWindow["kind"];
    readonly initialPrompt?: string;
    readonly permission?: WorkbenchPermissionLevel;
    readonly role?: WorkbenchRole;
    readonly parentWindowId?: string;
    readonly openedBy?: WorkbenchOpenedBy;
  }) =>
    | { readonly ok: true; readonly windowId: string; readonly autoLaunch: boolean }
    | { readonly ok: false; readonly reason: "missing" };
  readonly patchWindow: (
    projectId: ProjectId,
    windowId: string,
    patch: Partial<{
      nativeSessionId: string | null;
      kind: WorkbenchWindow["kind"];
      title: string;
      terminalId: string | undefined;
      permission: WorkbenchPermissionLevel;
      role: WorkbenchRole;
      permissionNeedsDowngrade: boolean;
      parentClosed: boolean;
      managerGrantPending: boolean;
      modelOverride: string;
      effortOverride: string;
      routeSnapshot: {
        readonly connectionMode: "local_cli" | "relay";
        readonly providerName?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
      } | null;
    }>,
  ) => void;
  /** 记下当前对话编号，并写入本窗口历史。 */
  readonly noteWindowSession: (projectId: ProjectId, windowId: string, sessionId: string) => void;
  /** 记号没对上。清掉当前编号，历史保留。 */
  readonly markWindowSessionUnidentified: (projectId: ProjectId, windowId: string) => void;
  /** 开新对话前清掉当前编号，历史保留。 */
  readonly clearWindowSessionId: (projectId: ProjectId, windowId: string) => void;
  /** 刷新当前对话的最后活动时间。 */
  readonly touchWindowConversation: (windowId: string, at: number) => void;
  /** 用户调整权限：封顶后代并标记需重启。 */
  readonly setWindowPermission: (
    projectId: ProjectId,
    windowId: string,
    permission: WorkbenchPermissionLevel,
  ) => void;
  /** 界面设角色：主进程裁决并在运行中的窗口投递说明。 */
  readonly applyWindowRole: (
    projectId: ProjectId,
    windowId: string,
    role: WorkbenchRole,
  ) => Promise<
    | {
        readonly ok: true;
        readonly delivery: "skipped" | "queued" | "manual" | "held" | "delivered" | "dropped";
      }
    | { readonly ok: false; readonly message: string }
  >;
  /** 本会话内新建的窗口（应用重启后清空）——用于 AI 窗口是否自动启动。 */
  readonly wasCreatedThisSession: (windowId: string) => boolean;
  /** 取出并清除新建时暂存的初始指令。 */
  readonly takeInitialPrompt: (windowId: string) => string | undefined;
  readonly convertWindowToShell: (projectId: ProjectId, windowId: string) => void;
  readonly closeWindow: (projectId: ProjectId, windowId: string) => Promise<void>;
  readonly closeTab: (projectId: ProjectId, tabId: string) => Promise<void>;
  readonly renameTab: (projectId: ProjectId, tabId: string, title: string) => void;
  readonly renameWindow: (projectId: ProjectId, windowId: string, title: string) => void;
  readonly setActiveTab: (projectId: ProjectId, tabId: string) => void;
  readonly focusWindow: (projectId: ProjectId, windowId: string) => void;
  readonly toggleMaximize: (projectId: ProjectId, windowId: string) => void;
  readonly updateSplitSizes: (
    projectId: ProjectId,
    tabId: string,
    splitKey: string,
    percents: readonly [number, number],
  ) => void;
  readonly bindTerminalId: (
    projectId: ProjectId,
    windowId: string,
    terminalId: string | undefined,
  ) => void;
  readonly markCwdFallback: (windowId: string) => void;
  readonly clearCwdFallback: (windowId: string) => void;
  /** 项目移除后清除幽灵布局（不再占上限额度）。 */
  readonly dropProject: (projectId: ProjectId) => void;
  /** 主进程已经启动的子窗口：先记住 PTY，再放进当前布局。 */
  readonly acceptOpenedWindow: (event: WorkbenchChildWindowEvent) => void;
  /** ffpane_close_window 已杀 PTY 并落盘；渲染端只同步布局。 */
  readonly acceptClosedWindow: (projectId: ProjectId, windowId: string) => void;
  readonly applyInboxNotice: (event: WorkbenchInboxNoticeEvent) => void;
}

export type WorkbenchStore = WorkbenchStoreState & WorkbenchStoreActions;

let persistTimer: ReturnType<typeof setTimeout> | undefined;
const dirtyProjects = new Set<string>();

function schedulePersist(projectId: ProjectId): void {
  dirtyProjects.add(projectId);
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    const ids = [...dirtyProjects];
    dirtyProjects.clear();
    for (const id of ids) {
      void flushProject(id);
    }
  }, PERSIST_DEBOUNCE_MS);
}

async function flushProject(projectId: string): Promise<void> {
  const layout = useWorkbenchStore.getState().layoutsByProject[projectId];
  if (layout === undefined) {
    return;
  }
  await invokeQuery("workbench:save-layout", { layout });
}

/**
 * 立刻落盘所有脏布局（取消防抖）。退出 / pagehide / flush-request 共用。
 */
export async function flushWorkbenchLayouts(): Promise<void> {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  const ids = [...dirtyProjects];
  dirtyProjects.clear();
  await Promise.all(ids.map((id) => flushProject(id)));
}

function patchProject(
  set: (
    partial:
      | Partial<WorkbenchStoreState>
      | ((s: WorkbenchStoreState) => Partial<WorkbenchStoreState>),
  ) => void,
  get: () => WorkbenchStore,
  projectId: ProjectId,
  updater: (layout: ProjectWorkbenchLayout) => ProjectWorkbenchLayout,
  options: { readonly persist?: boolean } = {},
): void {
  const persist = options.persist !== false;
  const current = get().layoutsByProject[projectId] ?? emptyLayout(projectId);
  const next = updater(current);
  if (next === current) {
    return;
  }
  set({
    layoutsByProject: { ...get().layoutsByProject, [projectId]: next },
  });
  if (persist) {
    schedulePersist(projectId);
  }
}

function nextShellTitle(layout: ProjectWorkbenchLayout): string {
  const n = Object.keys(layout.windows).length + 1;
  return `Shell ${n}`;
}

function nextCliTitle(
  kind: "claude" | "codex" | "grok" | "deepseek",
  layout: ProjectWorkbenchLayout,
): string {
  const n = Object.values(layout.windows).filter((window) => window.kind === kind).length + 1;
  if (kind === "claude") {
    return `Claude ${n}`;
  }
  if (kind === "codex") {
    return `Codex ${n}`;
  }
  if (kind === "grok") {
    return `Grok ${n}`;
  }
  return `DeepSeek ${n}`;
}

function nextTabTitle(layout: ProjectWorkbenchLayout): string {
  return `Tab ${layout.tabs.length + 1}`;
}

/** 本渲染会话内新建的窗口 id（不持久化）。 */
const sessionCreatedWindows = new Set<string>();
/** 新建 AI 窗口时暂存的初始指令（启动后清除）。 */
const pendingInitialPrompts = new Map<string, string>();

async function reconcileWithLiveTerminals(
  layouts: Readonly<Record<string, ProjectWorkbenchLayout>>,
): Promise<Readonly<Record<string, ProjectWorkbenchLayout>>> {
  const listed = await invokeQuery("terminal:list");
  if (listed.status !== "success") {
    return layouts;
  }
  const plan = planTerminalReconcile(
    layouts,
    listed.data.map((terminal) => ({
      id: terminal.id,
      exited: terminal.exited,
      ...(terminal.metadata === undefined ? {} : { metadata: terminal.metadata }),
    })),
  );
  for (const orphanId of plan.orphanTerminalIds) {
    await invokeQuery("terminal:kill", { id: orphanId });
  }
  for (const item of plan.reattach) {
    rememberLiveTerminal(item.windowId, item.terminalId);
  }

  let nextLayouts: Record<string, ProjectWorkbenchLayout> = { ...layouts };
  for (const item of plan.reattach) {
    const layout = nextLayouts[item.projectId];
    if (layout === undefined) {
      continue;
    }
    const window = layout.windows[item.windowId];
    if (window === undefined || window.terminalId === item.terminalId) {
      continue;
    }
    nextLayouts = {
      ...nextLayouts,
      [item.projectId]: {
        ...layout,
        windows: {
          ...layout.windows,
          [item.windowId]: { ...window, terminalId: item.terminalId },
        },
      },
    };
  }
  for (const clear of plan.clearBindings) {
    const layout = nextLayouts[clear.projectId];
    if (layout === undefined) {
      continue;
    }
    const window = layout.windows[clear.windowId];
    if (window?.terminalId === undefined) {
      continue;
    }
    const { terminalId: _removed, ...rest } = window;
    void _removed;
    nextLayouts = {
      ...nextLayouts,
      [clear.projectId]: {
        ...layout,
        windows: { ...layout.windows, [clear.windowId]: rest },
      },
    };
  }
  return nextLayouts;
}

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  layoutsByProject: {},
  hydrated: false,
  cwdFallbackWindowIds: new Set(),
  inboxByWindow: {},

  async hydrate() {
    if (get().hydrated) {
      return;
    }
    const settled = await invokeQuery("workbench:get-layouts");
    if (settled.status !== "success") {
      set({ hydrated: true });
      return;
    }
    const reconciled = await reconcileWithLiveTerminals(settled.data);
    const badges = await invokeQuery("workbench:inbox-badges");
    set({
      layoutsByProject: reconciled,
      hydrated: true,
      ...(badges.status === "success" ? { inboxByWindow: badges.data.badges } : {}),
    });
  },

  getProjectLayout(projectId) {
    return get().layoutsByProject[projectId] ?? emptyLayout(projectId);
  },

  countRunningWindows(projectId) {
    const layouts = get().layoutsByProject;
    if (projectId !== undefined) {
      const layout = layouts[projectId];
      return layout === undefined ? 0 : Object.keys(layout.windows).length;
    }
    let total = 0;
    for (const layout of Object.values(layouts)) {
      total += Object.keys(layout.windows).length;
    }
    return total;
  },

  createTabWithWindow({
    projectId,
    projectRoot,
    title,
    kind = "shell",
    initialPrompt,
    permission,
    role,
    parentWindowId,
    openedBy,
  }) {
    const windowId = newId("win");
    const tabId = newId("tab");
    sessionCreatedWindows.add(windowId);
    if (initialPrompt !== undefined && initialPrompt.trim() !== "") {
      pendingInitialPrompts.set(windowId, initialPrompt.trim());
    }
    patchProject(set, get, projectId, (layout) => {
      const resolvedKind = kind;
      const isAi = isAiWorkbenchKind(resolvedKind);
      const window: WorkbenchWindow = {
        id: windowId,
        projectId,
        title:
          title ??
          (resolvedKind === "shell" ? nextShellTitle(layout) : nextCliTitle(resolvedKind, layout)),
        kind: resolvedKind,
        cwd: projectRoot,
        createdAt: Date.now(),
        ...(isAi
          ? {
              permission: permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION,
              openedBy: openedBy ?? "user",
              role: role ?? DEFAULT_WORKBENCH_ROLE,
            }
          : {}),
        ...(parentWindowId !== undefined ? { parentWindowId } : {}),
      };
      const tab: WorkbenchTab = {
        id: tabId,
        title: nextTabTitle(layout),
        root: leafPane(windowId),
      };
      return {
        ...layout,
        tabs: [...layout.tabs, tab],
        activeTabId: tabId,
        windows: { ...layout.windows, [windowId]: window },
        focusedWindowId: windowId,
        maximizedWindowId: null,
      };
    });
    return { ok: true, windowId, autoLaunch: true };
  },

  splitWindow({
    projectId,
    projectRoot,
    targetWindowId,
    direction,
    kind = "shell",
    initialPrompt,
    permission,
    role,
    parentWindowId,
    openedBy,
  }) {
    const layout = get().getProjectLayout(projectId);
    const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId);
    if (activeTab === undefined || !collectWindowIds(activeTab.root).includes(targetWindowId)) {
      return { ok: false, reason: "missing" };
    }
    const windowId = newId("win");
    sessionCreatedWindows.add(windowId);
    if (initialPrompt !== undefined && initialPrompt.trim() !== "") {
      pendingInitialPrompts.set(windowId, initialPrompt.trim());
    }
    patchProject(set, get, projectId, (current) => {
      const tab = current.tabs.find((item) => item.id === current.activeTabId);
      if (tab === undefined) {
        return current;
      }
      const isAi = isAiWorkbenchKind(kind);
      const window: WorkbenchWindow = {
        id: windowId,
        projectId,
        title: kind === "shell" ? nextShellTitle(current) : nextCliTitle(kind, current),
        kind,
        cwd: projectRoot,
        createdAt: Date.now(),
        ...(isAi
          ? {
              permission: permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION,
              openedBy: openedBy ?? "user",
              role: role ?? DEFAULT_WORKBENCH_ROLE,
            }
          : {}),
        ...(parentWindowId !== undefined ? { parentWindowId } : {}),
      };
      const nextRoot = splitLeaf(tab.root, targetWindowId, windowId, direction);
      return {
        ...current,
        windows: { ...current.windows, [windowId]: window },
        focusedWindowId: windowId,
        maximizedWindowId: null,
        tabs: current.tabs.map((item) => (item.id === tab.id ? { ...item, root: nextRoot } : item)),
      };
    });
    return { ok: true, windowId, autoLaunch: true };
  },

  wasCreatedThisSession(windowId) {
    return sessionCreatedWindows.has(windowId);
  },

  takeInitialPrompt(windowId) {
    const prompt = pendingInitialPrompts.get(windowId);
    pendingInitialPrompts.delete(windowId);
    return prompt;
  },

  noteWindowSession(projectId, windowId, sessionId) {
    const at = Date.now();
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      const id = sessionId.trim();
      if (id === "") {
        return current;
      }
      const { sessionUnidentified: _flag, ...rest } = window;
      void _flag;
      return {
        ...current,
        windows: {
          ...current.windows,
          [windowId]: {
            ...rest,
            nativeSessionId: id,
            conversations: noteWorkbenchConversation(window.conversations, id, at),
          },
        },
      };
    });
  },

  clearWindowSessionId(projectId, windowId) {
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      const { nativeSessionId: _id, sessionUnidentified: _flag, ...rest } = window;
      void _id;
      void _flag;
      return {
        ...current,
        windows: { ...current.windows, [windowId]: rest },
      };
    });
  },

  markWindowSessionUnidentified(projectId, windowId) {
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      const { nativeSessionId: _id, ...rest } = window;
      void _id;
      return {
        ...current,
        windows: {
          ...current.windows,
          [windowId]: { ...rest, sessionUnidentified: true },
        },
      };
    });
  },

  touchWindowConversation(windowId, at) {
    const layouts = get().layoutsByProject;
    for (const [projectId, layout] of Object.entries(layouts)) {
      const window = layout.windows[windowId];
      const currentId = window?.nativeSessionId?.trim() ?? "";
      if (currentId === "") {
        continue;
      }
      patchProject(set, get, projectId as ProjectId, (current) => {
        const live = current.windows[windowId];
        const liveId = live?.nativeSessionId;
        if (live === undefined || liveId === undefined || liveId.trim() === "") {
          return current;
        }
        return {
          ...current,
          windows: {
            ...current.windows,
            [windowId]: {
              ...live,
              conversations: noteWorkbenchConversation(live.conversations, liveId, at),
            },
          },
        };
      });
      return;
    }
  },

  patchWindow(projectId, windowId, patch) {
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      const next: WorkbenchWindow = { ...window };
      if (patch.title !== undefined) {
        Object.assign(next, { title: patch.title });
      }
      if (patch.kind !== undefined) {
        Object.assign(next, { kind: patch.kind });
      }
      if (patch.terminalId !== undefined) {
        Object.assign(next, { terminalId: patch.terminalId });
      }
      if (patch.nativeSessionId === null) {
        const { nativeSessionId: _removed, ...rest } = next;
        void _removed;
        return {
          ...current,
          windows: { ...current.windows, [windowId]: rest },
        };
      }
      if (patch.nativeSessionId !== undefined) {
        Object.assign(next, { nativeSessionId: patch.nativeSessionId });
      }
      if (patch.permission !== undefined) {
        Object.assign(next, { permission: patch.permission });
      }
      if (patch.role !== undefined) {
        Object.assign(next, { role: patch.role });
      }
      if (patch.permissionNeedsDowngrade !== undefined) {
        Object.assign(next, { permissionNeedsDowngrade: patch.permissionNeedsDowngrade });
      }
      if (patch.parentClosed !== undefined) {
        Object.assign(next, { parentClosed: patch.parentClosed });
      }
      if (patch.managerGrantPending === false) {
        const { managerGrantPending: _flag, ...rest } = next;
        void _flag;
        return {
          ...current,
          windows: { ...current.windows, [windowId]: rest },
        };
      }
      if (patch.managerGrantPending === true) {
        Object.assign(next, { managerGrantPending: true });
      }
      if (patch.modelOverride !== undefined) {
        Object.assign(next, { modelOverride: patch.modelOverride });
      }
      if (patch.effortOverride !== undefined) {
        Object.assign(next, { effortOverride: patch.effortOverride });
      }
      if (patch.routeSnapshot !== undefined) {
        const {
          routeMode: _mode,
          routeProviderName: _provider,
          routeModel: _model,
          routeEffort: _effort,
          ...rest
        } = next;
        void _mode;
        void _provider;
        void _model;
        void _effort;
        const snapshot = patch.routeSnapshot;
        const stored =
          snapshot === null
            ? rest
            : {
                ...rest,
                routeMode: snapshot.connectionMode,
                ...(snapshot.providerName !== undefined && snapshot.providerName !== ""
                  ? { routeProviderName: snapshot.providerName }
                  : {}),
                ...(snapshot.model !== undefined && snapshot.model !== ""
                  ? { routeModel: snapshot.model }
                  : {}),
                ...(snapshot.reasoningEffort !== undefined && snapshot.reasoningEffort !== ""
                  ? { routeEffort: snapshot.reasoningEffort }
                  : {}),
              };
        return {
          ...current,
          windows: { ...current.windows, [windowId]: stored },
        };
      }
      return {
        ...current,
        windows: { ...current.windows, [windowId]: next },
      };
    });
  },

  setWindowPermission(projectId, windowId, permission) {
    patchProject(set, get, projectId, (current) => {
      const self = current.windows[windowId];
      if (self === undefined || (self.kind !== "claude" && self.kind !== "codex")) {
        return current;
      }
      const nextWindows: Record<string, WorkbenchWindow> = { ...current.windows };
      nextWindows[windowId] = {
        ...self,
        permission,
        permissionNeedsDowngrade: false,
      };
      const walkAncestors = (id: string): string[] => {
        const out: string[] = [];
        let cur = nextWindows[id];
        const seen = new Set<string>();
        while (cur?.parentWindowId) {
          if (seen.has(cur.parentWindowId)) {
            break;
          }
          seen.add(cur.parentWindowId);
          out.push(cur.parentWindowId);
          cur = nextWindows[cur.parentWindowId];
        }
        return out;
      };
      for (const [id, node] of Object.entries(current.windows)) {
        if (id === windowId) {
          continue;
        }
        if (!walkAncestors(id).includes(windowId)) {
          continue;
        }
        if ((node.kind !== "claude" && node.kind !== "codex") || node.permission === undefined) {
          continue;
        }
        if (WORKBENCH_PERMISSION_RANK[node.permission] <= WORKBENCH_PERMISSION_RANK[permission]) {
          nextWindows[id] = { ...node, permissionNeedsDowngrade: false };
          continue;
        }
        nextWindows[id] = {
          ...node,
          permission,
          permissionNeedsDowngrade: true,
        };
      }
      return { ...current, windows: nextWindows };
    });
  },

  async applyWindowRole(projectId, windowId, role) {
    await flushWorkbenchLayouts();
    const settled = await invokeQuery("workbench:set-role", { windowId, role });
    if (settled.status === "error") {
      return { ok: false as const, message: settled.error.message };
    }
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      return {
        ...current,
        windows: { ...current.windows, [windowId]: { ...window, role } },
      };
    });
    return { ok: true as const, delivery: settled.data.delivery };
  },

  convertWindowToShell(projectId, windowId) {
    patchProject(set, get, projectId, (current) => {
      const window = current.windows[windowId];
      if (window === undefined) {
        return current;
      }
      const {
        profileId: _p,
        nativeSessionId: _n,
        permission: _perm,
        openedBy: _ob,
        parentWindowId: _pw,
        parentClosed: _pc,
        permissionNeedsDowngrade: _pd,
        role: _role,
        ...rest
      } = window;
      void _p;
      void _n;
      void _perm;
      void _ob;
      void _pw;
      void _pc;
      void _pd;
      void _role;
      return {
        ...current,
        windows: {
          ...current.windows,
          [windowId]: {
            ...rest,
            kind: "shell",
            title: nextShellTitle(current),
          },
        },
      };
    });
    sessionCreatedWindows.add(windowId);
  },

  async closeWindow(projectId, windowId) {
    const layout = get().getProjectLayout(projectId);
    const window = layout.windows[windowId];
    if (window?.terminalId !== undefined) {
      await invokeQuery("terminal:kill", { id: window.terminalId });
    }
    forgetLiveTerminals([windowId]);
    patchProject(set, get, projectId, (current) => detachWindowFromLayout(current, windowId));
  },

  async closeTab(projectId, tabId) {
    const layout = get().getProjectLayout(projectId);
    const tab = layout.tabs.find((item) => item.id === tabId);
    if (tab === undefined) {
      return;
    }
    const ids = collectWindowIds(tab.root);
    for (const windowId of ids) {
      const window = layout.windows[windowId];
      if (window?.terminalId !== undefined) {
        await invokeQuery("terminal:kill", { id: window.terminalId });
      }
    }
    forgetLiveTerminals(ids);
    patchProject(set, get, projectId, (current) => {
      const tabs = current.tabs.filter((item) => item.id !== tabId);
      const windows = { ...current.windows };
      for (const windowId of ids) {
        delete windows[windowId];
      }
      return {
        ...current,
        tabs,
        windows,
        activeTabId: current.activeTabId === tabId ? (tabs[0]?.id ?? null) : current.activeTabId,
        focusedWindowId:
          current.focusedWindowId !== null && ids.includes(current.focusedWindowId)
            ? (Object.keys(windows)[0] ?? null)
            : current.focusedWindowId,
        maximizedWindowId:
          current.maximizedWindowId !== null && ids.includes(current.maximizedWindowId)
            ? null
            : current.maximizedWindowId,
      };
    });
  },

  renameTab(projectId, tabId, title) {
    const trimmed = title.trim();
    if (trimmed === "") {
      return;
    }
    patchProject(set, get, projectId, (layout) => ({
      ...layout,
      tabs: layout.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: trimmed } : tab)),
    }));
  },

  renameWindow(projectId, windowId, title) {
    const trimmed = title.trim();
    if (trimmed === "") {
      return;
    }
    patchProject(set, get, projectId, (layout) => {
      const window = layout.windows[windowId];
      if (window === undefined) {
        return layout;
      }
      return {
        ...layout,
        windows: { ...layout.windows, [windowId]: { ...window, title: trimmed } },
      };
    });
  },

  setActiveTab(projectId, tabId) {
    patchProject(set, get, projectId, (layout) => ({
      ...layout,
      activeTabId: tabId,
      maximizedWindowId: null,
    }));
  },

  focusWindow(projectId, windowId) {
    patchProject(set, get, projectId, (layout) => {
      const tab = layout.tabs.find((item) => collectWindowIds(item.root).includes(windowId));
      return {
        ...layout,
        focusedWindowId: windowId,
        ...(tab !== undefined ? { activeTabId: tab.id } : {}),
        maximizedWindowId: layout.maximizedWindowId === windowId ? windowId : null,
      };
    });
  },

  toggleMaximize(projectId, windowId) {
    patchProject(set, get, projectId, (layout) => ({
      ...layout,
      maximizedWindowId: layout.maximizedWindowId === windowId ? null : windowId,
      focusedWindowId: windowId,
    }));
  },

  updateSplitSizes(projectId, tabId, splitKey, percents) {
    const sizes = [percents[0] / 100, percents[1] / 100] as const;
    const layout = get().getProjectLayout(projectId);
    const tab = layout.tabs.find((item) => item.id === tabId);
    if (tab === undefined) {
      return;
    }
    const nextRoot = updateSplitSizesByKey(tab.root, splitKey, sizes);
    if (nextRoot === tab.root) {
      return;
    }
    patchProject(set, get, projectId, (current) => ({
      ...current,
      tabs: current.tabs.map((item) => (item.id === tabId ? { ...item, root: nextRoot } : item)),
    }));
  },

  bindTerminalId(projectId, windowId, terminalId) {
    // terminalId 持久化时剥离，不记脏——避免纯运行期绑定触发无意义写盘
    patchProject(
      set,
      get,
      projectId,
      (layout) => {
        const window = layout.windows[windowId];
        if (window === undefined) {
          return layout;
        }
        if (window.terminalId === terminalId) {
          return layout;
        }
        if (terminalId === undefined && window.terminalId === undefined) {
          return layout;
        }
        const next =
          terminalId === undefined
            ? (({ terminalId: _t, ...rest }) => {
                void _t;
                return rest;
              })(window)
            : { ...window, terminalId };
        return {
          ...layout,
          windows: { ...layout.windows, [windowId]: next },
        };
      },
      { persist: false },
    );
  },

  markCwdFallback(windowId) {
    set((state) => {
      const next = new Set(state.cwdFallbackWindowIds);
      next.add(windowId);
      return { cwdFallbackWindowIds: next };
    });
  },

  clearCwdFallback(windowId) {
    set((state) => {
      if (!state.cwdFallbackWindowIds.has(windowId)) {
        return state;
      }
      const next = new Set(state.cwdFallbackWindowIds);
      next.delete(windowId);
      return { cwdFallbackWindowIds: next };
    });
  },

  dropProject(projectId) {
    const removed = get().layoutsByProject[projectId];
    dirtyProjects.delete(projectId);
    if (removed !== undefined) {
      forgetLiveTerminals(Object.keys(removed.windows));
    }
    const { [projectId]: _dropped, ...rest } = get().layoutsByProject;
    void _dropped;
    set({ layoutsByProject: rest });
  },

  acceptClosedWindow(projectId, windowId) {
    forgetLiveTerminals([windowId]);
    patchProject(set, get, projectId, (current) => {
      if (current.windows[windowId] === undefined) {
        return current;
      }
      return detachWindowFromLayout(current, windowId);
    });
  },

  acceptOpenedWindow(event) {
    const current = get().layoutsByProject[event.projectId] ?? emptyLayout(event.projectId);
    if (current.windows[event.window.id] !== undefined) {
      return;
    }
    const next = placeOpenedWindow(
      current,
      event.managerWindowId,
      event.window,
      `tab-${crypto.randomUUID().slice(0, 12)}`,
    );
    set({
      layoutsByProject: { ...get().layoutsByProject, [event.projectId]: next },
    });
    schedulePersist(event.projectId);
  },

  applyInboxNotice(event) {
    const prev = get().inboxByWindow[event.windowId] ?? { unread: 0 };
    const lastReportStatus = event.lastReportStatus ?? prev.lastReportStatus;
    set({
      inboxByWindow: {
        ...get().inboxByWindow,
        [event.windowId]: {
          unread: event.unread ?? prev.unread,
          ...(lastReportStatus !== undefined ? { lastReportStatus } : {}),
        },
      },
    });
  },
}));

/** 测试用：重置 store 与脏标记。 */
export function resetWorkbenchStoreForTests(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  dirtyProjects.clear();
  useWorkbenchStore.setState({
    layoutsByProject: {},
    hydrated: false,
    cwdFallbackWindowIds: new Set(),
    inboxByWindow: {},
  });
}
