/**
 * 工作台布局持久化（T10.2 / T10.5）：~/.aiworkbench/workbench-layouts.json。
 * 只存标签页 / 分屏树 / 窗口元数据（剥离 terminalId）；损坏时回退空布局。
 * 令牌永不写入。
 */

import type {
  PaneNode,
  ProjectId,
  ProjectWorkbenchLayout,
  WorkbenchConversationRecord,
  WorkbenchTab,
  WorkbenchWindow,
  WorkbenchWindowKind,
} from "@ff-pane/shared";
import {
  isConnectionMode,
  isReasoningEffortLevel,
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  isWorkbenchWindowKind,
  parseWorkbenchOpenedBy,
  validateModelOverride,
  WORKBENCH_CONVERSATION_LIMIT,
} from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { WorkbenchLayoutsFileInvalidError } from "./errors.js";

/** 当前布局文件 schema 版本（T10.6：窗口 role）。 */
export const WORKBENCH_LAYOUTS_FILE_VERSION = 4;

/** 可读取的旧版（读入后按当前版本写出）。 */
export const WORKBENCH_LAYOUTS_FILE_VERSION_LEGACY = 1;

/** 亦可读取的中间版。 */
export const WORKBENCH_LAYOUTS_FILE_VERSION_V2 = 2;

/** T10.5 权限字段版，缺 role 时按 none。 */
export const WORKBENCH_LAYOUTS_FILE_VERSION_V3 = 3;

export interface WorkbenchLayoutsFile {
  readonly version: typeof WORKBENCH_LAYOUTS_FILE_VERSION;
  readonly layouts: Readonly<Record<string, ProjectWorkbenchLayout>>;
}

export interface WorkbenchLayoutStore {
  /** 读全部布局；文件缺失 / 损坏归一为空表（不抛，便于启动恢复）。 */
  readAll(): Promise<Readonly<Record<string, ProjectWorkbenchLayout>>>;
  /** 读单项目布局；无则 undefined。 */
  readProject(projectId: ProjectId): Promise<ProjectWorkbenchLayout | undefined>;
  /** 写入（覆盖）单项目布局。 */
  saveProject(layout: ProjectWorkbenchLayout): Promise<void>;
  /** 删除单项目布局（项目移除时）。 */
  removeProject(projectId: ProjectId): Promise<void>;
}

function isPaneNode(value: unknown): value is PaneNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as { readonly type?: unknown };
  if (raw.type === "leaf") {
    const leaf = value as { readonly windowId?: unknown };
    return typeof leaf.windowId === "string" && leaf.windowId.trim() !== "";
  }
  if (raw.type === "split") {
    const split = value as {
      readonly direction?: unknown;
      readonly sizes?: unknown;
      readonly children?: unknown;
    };
    if (split.direction !== "horizontal" && split.direction !== "vertical") {
      return false;
    }
    if (
      !Array.isArray(split.sizes) ||
      split.sizes.length !== 2 ||
      typeof split.sizes[0] !== "number" ||
      typeof split.sizes[1] !== "number"
    ) {
      return false;
    }
    if (!Array.isArray(split.children) || split.children.length !== 2) {
      return false;
    }
    return isPaneNode(split.children[0]) && isPaneNode(split.children[1]);
  }
  return false;
}

function parseConversations(value: unknown): readonly WorkbenchConversationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: WorkbenchConversationRecord[] = [];
  for (const item of value) {
    if (out.length >= WORKBENCH_CONVERSATION_LIMIT) {
      break;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
    const startedAt = raw["startedAt"];
    const lastActiveAt = raw["lastActiveAt"];
    if (id === "" || typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
      continue;
    }
    if (typeof lastActiveAt !== "number" || !Number.isFinite(lastActiveAt)) {
      continue;
    }
    out.push({ id, startedAt, lastActiveAt });
  }
  return out;
}

function parseWindow(value: unknown, projectId: ProjectId): WorkbenchWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
    return null;
  }
  if (typeof raw["title"] !== "string") {
    return null;
  }
  if (!isWorkbenchWindowKind(raw["kind"])) {
    return null;
  }
  if (typeof raw["cwd"] !== "string" || raw["cwd"].trim() === "") {
    return null;
  }
  if (typeof raw["createdAt"] !== "number" || !Number.isFinite(raw["createdAt"])) {
    return null;
  }
  const kind = raw["kind"] as WorkbenchWindowKind;
  const permissionRaw = raw["permission"];
  const permission = isWorkbenchPermissionLevel(permissionRaw) ? permissionRaw : undefined;
  const openedBy =
    raw["openedBy"] !== undefined ? parseWorkbenchOpenedBy(raw["openedBy"]) : undefined;
  const modelOverride =
    typeof raw["modelOverride"] === "string"
      ? validateModelOverride(raw["modelOverride"])
      : undefined;
  const effortOverrideRaw =
    typeof raw["effortOverride"] === "string" ? raw["effortOverride"].trim() : undefined;
  const window: WorkbenchWindow = {
    id: raw["id"],
    projectId: typeof raw["projectId"] === "string" ? (raw["projectId"] as ProjectId) : projectId,
    title: raw["title"],
    kind,
    cwd: raw["cwd"],
    createdAt: raw["createdAt"],
    ...(isConnectionMode(raw["routeMode"]) ? { routeMode: raw["routeMode"] } : {}),
    ...(typeof raw["routeProviderName"] === "string" && raw["routeProviderName"].trim() !== ""
      ? { routeProviderName: raw["routeProviderName"] }
      : {}),
    ...(typeof raw["routeModel"] === "string" && raw["routeModel"].trim() !== ""
      ? { routeModel: raw["routeModel"] }
      : {}),
    ...(typeof raw["routeEffort"] === "string" && raw["routeEffort"].trim() !== ""
      ? { routeEffort: raw["routeEffort"] }
      : {}),
    ...(modelOverride?.ok === true ? { modelOverride: modelOverride.model } : {}),
    ...(effortOverrideRaw !== undefined && isReasoningEffortLevel(effortOverrideRaw)
      ? { effortOverride: effortOverrideRaw }
      : {}),
    ...(typeof raw["nativeSessionId"] === "string" && raw["nativeSessionId"].trim() !== ""
      ? { nativeSessionId: raw["nativeSessionId"] }
      : {}),
    ...(raw["sessionUnidentified"] === true ? { sessionUnidentified: true } : {}),
    ...(() => {
      const conversations = parseConversations(raw["conversations"]);
      return conversations.length > 0 ? { conversations } : {};
    })(),
    ...(isWorkbenchRole(raw["role"]) ? { role: raw["role"] } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(typeof raw["parentWindowId"] === "string" && raw["parentWindowId"].trim() !== ""
      ? { parentWindowId: raw["parentWindowId"] }
      : {}),
    ...(raw["parentClosed"] === true ? { parentClosed: true } : {}),
    ...(openedBy !== undefined ? { openedBy } : {}),
    ...(raw["permissionNeedsDowngrade"] === true ? { permissionNeedsDowngrade: true } : {}),
    ...(raw["managerGrantPending"] === true ? { managerGrantPending: true } : {}),
  };
  return window;
}

function parseTab(value: unknown): WorkbenchTab | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
    return null;
  }
  if (typeof raw["title"] !== "string") {
    return null;
  }
  if (!isPaneNode(raw["root"])) {
    return null;
  }
  return { id: raw["id"], title: raw["title"], root: raw["root"] };
}

function parseLayout(projectId: string, value: unknown): ProjectWorkbenchLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw["tabs"])) {
    return null;
  }
  const tabs: WorkbenchTab[] = [];
  for (const tab of raw["tabs"]) {
    const parsed = parseTab(tab);
    if (parsed === null) {
      return null;
    }
    tabs.push(parsed);
  }
  if (
    typeof raw["windows"] !== "object" ||
    raw["windows"] === null ||
    Array.isArray(raw["windows"])
  ) {
    return null;
  }
  const windows: Record<string, WorkbenchWindow> = {};
  for (const [id, windowValue] of Object.entries(raw["windows"] as Record<string, unknown>)) {
    const parsed = parseWindow(windowValue, projectId as ProjectId);
    if (parsed === null || parsed.id !== id) {
      return null;
    }
    windows[id] = parsed;
  }
  const activeTabId =
    raw["activeTabId"] === null
      ? null
      : typeof raw["activeTabId"] === "string"
        ? raw["activeTabId"]
        : null;
  const maximizedWindowId =
    raw["maximizedWindowId"] === null
      ? null
      : typeof raw["maximizedWindowId"] === "string"
        ? raw["maximizedWindowId"]
        : null;
  const focusedWindowId =
    raw["focusedWindowId"] === null
      ? null
      : typeof raw["focusedWindowId"] === "string"
        ? raw["focusedWindowId"]
        : null;
  return {
    projectId: projectId as ProjectId,
    tabs,
    activeTabId,
    windows,
    maximizedWindowId,
    focusedWindowId,
  };
}

/** 持久化前剥离运行期字段（terminalId）和旧档案 id。 */
export function stripRuntimeFields(layout: ProjectWorkbenchLayout): ProjectWorkbenchLayout {
  const windows: Record<string, WorkbenchWindow> = {};
  for (const [id, window] of Object.entries(layout.windows)) {
    const { terminalId: _terminalId, profileId: _profileId, ...rest } = window;
    void _terminalId;
    void _profileId;
    windows[id] = rest;
  }
  return { ...layout, windows };
}

async function loadFile(
  filePath: string,
): Promise<Readonly<Record<string, ProjectWorkbenchLayout>>> {
  const result = await readJson<unknown>(filePath);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return {};
    }
    // JSON 语法损坏：回退空布局（合同：损坏时回退）
    console.warn(`[workbench-layouts] corrupt json, fallback empty: ${filePath}`);
    return {};
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[workbench-layouts] invalid root, fallback empty: ${filePath}`);
    return {};
  }
  const file = raw as { readonly version?: unknown; readonly layouts?: unknown };
  if (
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_V3 &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_V2 &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_LEGACY
  ) {
    console.warn(
      `[workbench-layouts] unsupported version ${String(file.version)}, fallback empty: ${filePath}`,
    );
    return {};
  }
  if (typeof file.layouts !== "object" || file.layouts === null || Array.isArray(file.layouts)) {
    console.warn(`[workbench-layouts] invalid layouts map, fallback empty: ${filePath}`);
    return {};
  }
  const layouts: Record<string, ProjectWorkbenchLayout> = {};
  for (const [projectId, layoutValue] of Object.entries(file.layouts as Record<string, unknown>)) {
    const parsed = parseLayout(projectId, layoutValue);
    if (parsed === null) {
      console.warn(`[workbench-layouts] skip corrupt project layout ${projectId}: ${filePath}`);
      continue;
    }
    layouts[projectId] = parsed;
  }
  return layouts;
}

async function saveFile(
  filePath: string,
  layouts: Readonly<Record<string, ProjectWorkbenchLayout>>,
): Promise<void> {
  const stripped: Record<string, ProjectWorkbenchLayout> = {};
  for (const [id, layout] of Object.entries(layouts)) {
    stripped[id] = stripRuntimeFields(layout);
  }
  const file: WorkbenchLayoutsFile = {
    version: WORKBENCH_LAYOUTS_FILE_VERSION,
    layouts: stripped,
  };
  await writeJsonAtomic(filePath, file);
}

/**
 * 创建绑定到指定路径的布局存取。
 * 接线：`createWorkbenchLayoutStore(resolveGlobalLayout(root).workbenchLayoutsFile)`。
 */
export function createWorkbenchLayoutStore(filePath: string): WorkbenchLayoutStore {
  return {
    readAll: () => loadFile(filePath),

    async readProject(projectId) {
      const all = await loadFile(filePath);
      return all[projectId];
    },

    async saveProject(layout) {
      const all = { ...(await loadFile(filePath)) };
      all[layout.projectId] = stripRuntimeFields(layout);
      await saveFile(filePath, all);
    },

    async removeProject(projectId) {
      const all = { ...(await loadFile(filePath)) };
      if (all[projectId] === undefined) {
        return;
      }
      delete all[projectId];
      await saveFile(filePath, all);
    },
  };
}

/** 供单测：严格解析（损坏抛错）。 */
export function parseWorkbenchLayoutsFileStrict(
  filePath: string,
  raw: unknown,
): WorkbenchLayoutsFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkbenchLayoutsFileInvalidError(filePath, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly layouts?: unknown };
  if (
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_V3 &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_V2 &&
    file.version !== WORKBENCH_LAYOUTS_FILE_VERSION_LEGACY
  ) {
    throw new WorkbenchLayoutsFileInvalidError(
      filePath,
      `不支持的 version：${String(file.version)}`,
    );
  }
  if (typeof file.layouts !== "object" || file.layouts === null || Array.isArray(file.layouts)) {
    throw new WorkbenchLayoutsFileInvalidError(filePath, "layouts 必须是对象");
  }
  const layouts: Record<string, ProjectWorkbenchLayout> = {};
  for (const [projectId, layoutValue] of Object.entries(file.layouts as Record<string, unknown>)) {
    const parsed = parseLayout(projectId, layoutValue);
    if (parsed === null) {
      throw new WorkbenchLayoutsFileInvalidError(filePath, `项目 ${projectId} 布局损坏`);
    }
    layouts[projectId] = parsed;
  }
  return { version: WORKBENCH_LAYOUTS_FILE_VERSION, layouts };
}
