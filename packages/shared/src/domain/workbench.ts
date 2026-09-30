/**
 * 工作台窗口与布局领域类型（T10.2 / T10.5）。
 * 窗口 id 全局唯一，与 PTY terminalId 分离（重启终端时窗口 id 不变）。
 * 身份令牌仅存主进程内存，不进本类型 / 布局文件。
 */

import type { ProjectId } from "./common.js";
import type { WorkbenchOpenedBy, WorkbenchPermissionLevel } from "./workbench-permission.js";

/** 出厂默认：同时运行的工作台窗口上限。 */
export const DEFAULT_MAX_WORKBENCH_WINDOWS = 12;

/** 上限可写入的下限（含）。 */
export const MIN_MAX_WORKBENCH_WINDOWS = 1;

/** 上限可写入的上限（含）；超出则钳制，不杀已有窗口。 */
export const MAX_MAX_WORKBENCH_WINDOWS = 32;

/** 上限可调档位（设置页下拉；存量自定义值仍原样呈现，读时钳制到合法区间）。 */
export const MAX_WORKBENCH_WINDOWS_OPTIONS = [4, 6, 8, 12, 16, 24] as const;

/**
 * 将任意输入钳制为合法的同时窗口上限。
 * 非有限数 / 非 number → 出厂默认；合法数取整后夹到 [1, 32]。
 */
export function clampMaxWorkbenchWindows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_WORKBENCH_WINDOWS;
  }
  const floored = Math.floor(value);
  return Math.min(MAX_MAX_WORKBENCH_WINDOWS, Math.max(MIN_MAX_WORKBENCH_WINDOWS, floored));
}

/** 窗口内容种类；T10.4 起含 Claude Code / Codex。 */
export const WORKBENCH_WINDOW_KINDS = ["shell", "claude", "codex"] as const;

/** 窗口内容种类。 */
export type WorkbenchWindowKind = (typeof WORKBENCH_WINDOW_KINDS)[number];

/** kind 运行时守卫。 */
export function isWorkbenchWindowKind(value: unknown): value is WorkbenchWindowKind {
  return typeof value === "string" && (WORKBENCH_WINDOW_KINDS as readonly string[]).includes(value);
}

/** AI 窗口 kind ↔ Profile runtime。 */
export function workbenchKindToRuntime(
  kind: Exclude<WorkbenchWindowKind, "shell">,
): "claude-code" | "codex" {
  return kind === "claude" ? "claude-code" : "codex";
}

/** Profile runtime → AI 窗口 kind；非 AI runtime 返回 undefined。 */
export function runtimeToWorkbenchKind(
  runtime: string,
): Exclude<WorkbenchWindowKind, "shell"> | undefined {
  if (runtime === "claude-code") {
    return "claude";
  }
  if (runtime === "codex") {
    return "codex";
  }
  return undefined;
}

/**
 * 工作台窗口（布局元数据）。terminalId 是运行期字段，持久化时剥离。
 */
export interface WorkbenchWindow {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly kind: WorkbenchWindowKind;
  readonly cwd: string;
  /** 绑定的 PTY id；未启动或已杀为空。 */
  readonly terminalId?: string;
  readonly createdAt: number;
  /** AI 窗口：启动所用 AgentProfile id。 */
  readonly profileId?: string;
  /**
   * AI 窗口：CLI 原生会话 id。
   * Claude = `--session-id` / `--resume` 的 UUID；Codex = `codex resume <id>`（可缺省，续接降级 `--last`）。
   */
  readonly nativeSessionId?: string;
  /** 预留：角色（管理者 / 规划 / 执行 / 检查 / 普通）。 */
  readonly role?: string;
  /** AI 窗口权限等级；shell 不设。 */
  readonly permission?: WorkbenchPermissionLevel;
  /**
   * 父窗口已关闭时仍保留 parentWindowId 供展示与封顶追溯；
   * true = 父级已不在布局树中，子窗口继续运行。
   */
  readonly parentClosed?: boolean;
  /** 开启本窗口的上级窗口 id（自上而下下放）。 */
  readonly parentWindowId?: string;
  /** 开启者：界面用户或某窗口。 */
  readonly openedBy?: WorkbenchOpenedBy;
  /**
   * 祖先降级后本窗口超过新上限：下次启动/续接须封顶；
   * 正在运行的进程无法热改 CLI 参数。
   */
  readonly permissionNeedsDowngrade?: boolean;
}

/** 分屏方向：horizontal = 左右；vertical = 上下。 */
export type PaneSplitDirection = "horizontal" | "vertical";

/** 分屏树叶子：指向一个窗口 id。 */
export interface PaneLeaf {
  readonly type: "leaf";
  readonly windowId: string;
}

/**
 * 分屏树二分节点。sizes 为两子节点比例（和为 1）。
 * react-resizable-panels 消费时再换算为 1–100 百分数。
 */
export interface PaneSplit {
  readonly type: "split";
  readonly direction: PaneSplitDirection;
  readonly sizes: readonly [number, number];
  readonly children: readonly [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** 单个标签页：标题 + 一棵分屏树。 */
export interface WorkbenchTab {
  readonly id: string;
  readonly title: string;
  readonly root: PaneNode;
}

/** 单个项目的工作台布局（不含终端输出）。 */
export interface ProjectWorkbenchLayout {
  readonly projectId: ProjectId;
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string | null;
  readonly windows: Readonly<Record<string, WorkbenchWindow>>;
  readonly maximizedWindowId: string | null;
  readonly focusedWindowId: string | null;
}
