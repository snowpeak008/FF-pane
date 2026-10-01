/**
 * project-alerts store（T9.7）—— B 栏项目切换器的「落定高亮」未读状态。
 *
 * 语义（合同 v1.16）：
 * - 项目内任务进入落定状态（done / failed / blocked）时该项目条目高亮；
 * - 用户**切换到该项目并打开会话页或任务页任一**即算已读、高亮消除；
 * - 已读按项目持久化——重启不复活已读项。
 *
 * 持久化落点裁决：**渲染层 localStorage（zustand persist，键 ffpane.project-alerts）**，
 * 弃「主进程项目设置（project.json）」备选。理由：
 * 1. 「已读」是**这台工作台界面**的注意力状态，不是项目事实——project.json 是项目级
 *    数据（角色绑定 / 工具开关），把界面注意力状态写进项目目录会让 git 同步该目录的
 *    用户平白多出无意义 diff；
 * 2. localStorage 天然满足「重启不复活」（持久化的是未读集合，已读 = 从集合移除，
 *    重启后读回的就是移除后的集合）；
 * 3. 与 ui store 同一迁移路径（Phase 3 暂存 localStorage，后续统一入 config.json）。
 *
 * 键用 projectRoot 而非 projectId：落定记录按项目根路径比对，
 * 不引入一次注册表反查。项目被移除再恢复（projects:restore 原样放回）root 不变，
 * 未读状态自然延续。
 *
 * 「已读后又有新落定 → 重新高亮」无需特殊处理：已读 = 键被删掉，新事件重新置位。
 * 「活跃项目正开着会话页/任务页时新落定 = 即时已读」由订阅桥（TaskSettledBridge）
 * 在入口处判定（isInstantRead），不进本 store——store 只管集合，不管路由。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TaskSettledStatus } from "../../../shared-ipc/contracts";

/** 每个项目的未读落定状态集合（三态各自置位；空集合 = 该键不存在）。 */
export type ProjectAlertMap = Readonly<Record<string, readonly TaskSettledStatus[]>>;

export interface ProjectAlertsState {
  /** projectRoot → 未读落定状态（有键即高亮）。 */
  readonly alerts: ProjectAlertMap;
}

export interface ProjectAlertsActions {
  /** 登记一次落定（同状态幂等；新状态并入该项目的集合）。 */
  readonly recordSettled: (projectRoot: string, status: TaskSettledStatus) => void;
  /** 该项目已读：整键移除（下次落定重新置位）。 */
  readonly markProjectRead: (projectRoot: string) => void;
}

export type ProjectAlertsStore = ProjectAlertsState & ProjectAlertsActions;

export const PROJECT_ALERTS_STORAGE_KEY = "ffpane.project-alerts";

/** 落定登记的纯函数形式（单测直调；幂等：已含该状态时返回原引用）。 */
export function withSettled(
  alerts: ProjectAlertMap,
  projectRoot: string,
  status: TaskSettledStatus,
): ProjectAlertMap {
  const existing = alerts[projectRoot] ?? [];
  if (existing.includes(status)) {
    return alerts;
  }
  return { ...alerts, [projectRoot]: [...existing, status] };
}

/** 已读消除的纯函数形式（键不存在时返回原引用）。 */
export function withoutProject(alerts: ProjectAlertMap, projectRoot: string): ProjectAlertMap {
  if (alerts[projectRoot] === undefined) {
    return alerts;
  }
  const next = { ...alerts };
  delete next[projectRoot];
  return next;
}

/**
 * 「已读动作」的路由判定（合同：切换到该项目并打开会话页或任务页**任一**即算已读）。
 * pathname 取 HashRouter 的 location.pathname（如 "/session"）。
 */
export const READ_CLEARING_PATHS = ["/session", "/tasks"] as const;

export function isReadClearingPath(pathname: string): boolean {
  return (READ_CLEARING_PATHS as readonly string[]).includes(pathname);
}

/**
 * 即时已读判定（合同语义细节）：活跃项目自己正开着会话页或任务页时，该项目的新落定
 * 视为即时已读（用户正看着，不该先亮再灭）。eventRoot 与 activeRoot 均为项目根路径
 * 原串（两端同源，见 store 头注），null = 无活跃项目。
 */
export function isInstantRead(
  eventRoot: string,
  activeRoot: string | null,
  pathname: string,
): boolean {
  return activeRoot !== null && eventRoot === activeRoot && isReadClearingPath(pathname);
}

export const useProjectAlertsStore = create<ProjectAlertsStore>()(
  persist(
    (set) => ({
      alerts: {},
      recordSettled: (projectRoot, status) => {
        set((state) => ({ alerts: withSettled(state.alerts, projectRoot, status) }));
      },
      markProjectRead: (projectRoot) => {
        set((state) => ({ alerts: withoutProject(state.alerts, projectRoot) }));
      },
    }),
    {
      name: PROJECT_ALERTS_STORAGE_KEY,
      version: 1,
      partialize: (state): ProjectAlertsState => ({ alerts: state.alerts }),
    },
  ),
);
