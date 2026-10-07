/**
 * 工作台窗口与布局领域类型（T10.2 / T10.5）。
 * 窗口 id 全局唯一，与 PTY terminalId 分离（重启终端时窗口 id 不变）。
 * 身份令牌仅存主进程内存，不进本类型 / 布局文件。
 */

import type { ProjectId } from "./common.js";
import type { ConnectionMode } from "./profile.js";
import type { WorkbenchOpenedBy, WorkbenchPermissionLevel } from "./workbench-permission.js";
import type { WorkbenchRole } from "./workbench-role.js";

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

/** 窗口内容种类；T10.4 起含 Claude Code / Codex，T10.16 起含 Grok，T10.17 起含 DeepSeek。 */
export const WORKBENCH_WINDOW_KINDS = ["shell", "claude", "codex", "grok", "deepseek"] as const;

/** 窗口内容种类。 */
export type WorkbenchWindowKind = (typeof WORKBENCH_WINDOW_KINDS)[number];

/** kind 运行时守卫。 */
export function isWorkbenchWindowKind(value: unknown): value is WorkbenchWindowKind {
  return typeof value === "string" && (WORKBENCH_WINDOW_KINDS as readonly string[]).includes(value);
}

/** AI 窗口 kind。 */
export type WorkbenchAiKind = Exclude<WorkbenchWindowKind, "shell">;

/** 是否为会启动 CLI 的窗口。 */
export function isAiWorkbenchKind(kind: string): kind is WorkbenchAiKind {
  return kind !== "shell" && (WORKBENCH_WINDOW_KINDS as readonly string[]).includes(kind);
}

/**
 * AI 窗口 kind ↔ 实际启动的 runtime。
 * DeepSeek 没有自己的命令，启动本机 Claude Code。
 * Grok 用 "grok"，与旧适配器 "grok-build" 分开。
 */
export function workbenchKindToRuntime(kind: WorkbenchAiKind): "claude-code" | "codex" | "grok" {
  if (kind === "codex") {
    return "codex";
  }
  if (kind === "grok") {
    return "grok";
  }
  return "claude-code";
}

/** 注入密钥和地址时用的模板 CLI。DeepSeek 用自己的来源，不走普通 Claude 来源。 */
export function workbenchKindToInjectionCli(
  kind: WorkbenchAiKind,
): "claude-code" | "codex" | "grok" | "deepseek" {
  if (kind === "deepseek") {
    return "deepseek";
  }
  return workbenchKindToRuntime(kind);
}

/** Profile runtime → AI 窗口 kind；非 AI runtime 返回 undefined。 */
export function runtimeToWorkbenchKind(runtime: string): WorkbenchAiKind | undefined {
  if (runtime === "claude-code") {
    return "claude";
  }
  if (runtime === "codex") {
    return "codex";
  }
  if (runtime === "grok") {
    return "grok";
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
  /**
   * 旧布局上的档案 id。读入时忽略，写入布局文件时剥离。
   */
  readonly profileId?: string;
  /** 本次启动实际走的连法。已开窗口不热改，下次启动时按当时的项目配置重写。 */
  readonly routeMode?: ConnectionMode;
  /** 中转来源的显示名。本机登录不设。 */
  readonly routeProviderName?: string;
  /** 本次启动下发的模型。缺省表示用 CLI 默认。 */
  readonly routeModel?: string;
  /** 本次启动下发的思考强度。缺省表示不下发。 */
  readonly routeEffort?: string;
  /**
   * 管理者改过的模型。启动时盖过项目配置里的模型；缺省表示不覆盖。
   * 优先级：本字段 → 项目配置这一路 → 都不填则不传参数。
   */
  readonly modelOverride?: string;
  /** 管理者改过的思考强度。优先级同 modelOverride。 */
  readonly effortOverride?: string;
  /**
   * 管理者窗口的压缩比例，50 到 90 的整数。
   * 缺省表示不指定：启动时不传，用命令行自己的默认。
   * 只在这个窗口的角色是管理者时才传给那一次进程。改完后，下一次启动、重启或续接才生效。
   */
  readonly compactPercent?: number;
  /**
   * AI 窗口：当前对话编号。
   * Claude 启动时用 `--session-id` 指定；Codex 按本窗口记号从 rollout 认领。
   * 没有编号时续接打开选择器，不用 `--continue` / `--last`。
   */
  readonly nativeSessionId?: string;
  /** Codex 记号没对上，或续接时还没有编号。 */
  readonly sessionUnidentified?: boolean;
  /** 本窗口对话历史。只含编号与时间，条数有上限。当前编号也在里面。 */
  readonly conversations?: readonly WorkbenchConversationRecord[];
  /** 工作台角色。缺省视为 none。shell 窗口通常不设。 */
  readonly role?: WorkbenchRole;
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
  /**
   * 有父级的 manager 在本进程里还没被重新授予。
   * 只驱动标题栏文案，不授予开窗口能力。
   */
  readonly managerGrantPending?: boolean;
}

/** 单个窗口保留的对话条数上限。 */
export const WORKBENCH_CONVERSATION_LIMIT = 24;

/** 本窗口的一段对话。只记编号和时间。 */
export interface WorkbenchConversationRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly lastActiveAt: number;
}

/** 界面上的短编号：取前 8 位。 */
export function shortSessionId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 8) {
    return trimmed;
  }
  return trimmed.slice(0, 8);
}

/**
 * 记下一段对话。同一编号只留一条，刷新最后活动时间。
 * 超过上限时丢掉最久没活动的。
 */
export function noteWorkbenchConversation(
  history: readonly WorkbenchConversationRecord[] | undefined,
  id: string,
  at: number,
): readonly WorkbenchConversationRecord[] {
  const trimmed = id.trim();
  const prev = history ?? [];
  if (trimmed === "" || !Number.isFinite(at)) {
    return prev;
  }
  const existing = prev.find((item) => item.id === trimmed);
  const nextRecord: WorkbenchConversationRecord =
    existing === undefined
      ? { id: trimmed, startedAt: at, lastActiveAt: at }
      : {
          id: trimmed,
          startedAt: existing.startedAt,
          lastActiveAt: Math.max(existing.lastActiveAt, at),
        };
  const merged = [nextRecord, ...prev.filter((item) => item.id !== trimmed)];
  merged.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.startedAt - a.startedAt);
  return merged.slice(0, WORKBENCH_CONVERSATION_LIMIT);
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
