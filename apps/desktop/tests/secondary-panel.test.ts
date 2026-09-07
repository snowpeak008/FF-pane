/**
 * T9.7 B 栏布局壳 + 项目快速切换器单测（node 环境，纯逻辑直测——仓内款式：
 * 无 @testing-library，DOM 级行为归 E2E secondary-panel.spec.ts）。
 *
 * 覆盖面：
 * 1. 落定事件派生（主进程 task-settled.ts）：done/failed/blocked 三态推送、
 *    非落定态不推送；
 * 2. 落定守卫（@ff-pane/shared isTaskSettledStatus，T9.10 起事实源在 shared）与三态清单；
 * 3. project-alerts store：置位 / 幂等 / 已读消除 / 已读后再落定重新高亮 /
 *    持久化形状（重启不复活由「持久化的是未读集合」这一形状保证，此处钉形状）；
 * 4. 即时已读判定（isInstantRead）与已读路由判定（isReadClearingPath）；
 * 5. ui store 收敛迁移（migrateUiState）：旧 localStorage 键采纳 / v1 blob 保留 /
 *    detailPanelCollapsed 丢弃 / secondaryPanelCollapsed 初始展开；
 * 6. A/B 独立收展（store action 层面：toggle 互不影响）。
 */

import {
  isTaskSettledStatus,
  TASK_SETTLED_STATUSES,
  type Task,
  type TaskId,
  type TaskSettledStatus,
} from "@ff-pane/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { taskSettledEventOf } from "../src/main/session/task-settled";
import {
  isInstantRead,
  isReadClearingPath,
  PROJECT_ALERTS_STORAGE_KEY,
  READ_CLEARING_PATHS,
  useProjectAlertsStore,
  withoutProject,
  withSettled,
} from "../src/renderer/src/stores/project-alerts";
import {
  LEGACY_SIDEBAR_COLLAPSED_KEY,
  migrateUiState,
  UI_STORE_VERSION,
  useUiStore,
} from "../src/renderer/src/stores/ui";

const ROOT_A = "D:\\proj\\alpha";
const ROOT_B = "D:\\proj\\beta";

function taskWith(status: Task["status"]): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 1 as Task["planVersion"],
    goal: "测试任务",
    writeScope: ["src/**"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["单测全绿"],
    status,
  };
}

describe("T9.7 落定事件派生（主进程 saveTask 落盘点）", () => {
  it("done / failed / blocked 三态各派生一条 tasks:settled 事件", () => {
    for (const status of TASK_SETTLED_STATUSES) {
      const event = taskSettledEventOf(ROOT_A, taskWith(status));
      expect(event).toEqual({ projectRoot: ROOT_A, taskId: "task-1", status });
    }
  });

  it("非落定状态（pending / running / accepted / cancelled）不派生事件", () => {
    for (const status of ["pending", "running", "accepted", "cancelled"] as const) {
      expect(taskSettledEventOf(ROOT_A, taskWith(status))).toBeNull();
    }
  });

  it("isTaskSettledStatus 守卫与三态清单一致，拒绝其余取值", () => {
    for (const status of TASK_SETTLED_STATUSES) {
      expect(isTaskSettledStatus(status)).toBe(true);
    }
    expect(TASK_SETTLED_STATUSES).toEqual(["done", "failed", "blocked"]);
    for (const value of ["pending", "running", "accepted", "cancelled", "", 1, null, undefined]) {
      expect(isTaskSettledStatus(value)).toBe(false);
    }
  });
});

describe("T9.7 project-alerts store：落定高亮的未读语义", () => {
  beforeEach(() => {
    useProjectAlertsStore.setState({ alerts: {} });
  });

  it("落定置位：三态各自并入该项目的未读集合", () => {
    const s = useProjectAlertsStore.getState();
    s.recordSettled(ROOT_A, "done");
    s.recordSettled(ROOT_A, "failed");
    s.recordSettled(ROOT_A, "blocked");
    expect(useProjectAlertsStore.getState().alerts[ROOT_A]).toEqual(["done", "failed", "blocked"]);
  });

  it("同状态重复落定幂等（withSettled 返回原引用）", () => {
    const once = withSettled({}, ROOT_A, "failed");
    const twice = withSettled(once, ROOT_A, "failed");
    expect(twice).toBe(once);
  });

  it("项目间互不影响：A 的落定不点亮 B", () => {
    useProjectAlertsStore.getState().recordSettled(ROOT_A, "done");
    expect(useProjectAlertsStore.getState().alerts[ROOT_B]).toBeUndefined();
  });

  it("已读消除：markProjectRead 整键移除，其他项目保留", () => {
    const s = useProjectAlertsStore.getState();
    s.recordSettled(ROOT_A, "failed");
    s.recordSettled(ROOT_B, "done");
    s.markProjectRead(ROOT_A);
    const alerts = useProjectAlertsStore.getState().alerts;
    expect(alerts[ROOT_A]).toBeUndefined();
    expect(alerts[ROOT_B]).toEqual(["done"]);
  });

  it("已读后又有新落定 → 重新高亮（合同语义细节）", () => {
    const s = useProjectAlertsStore.getState();
    s.recordSettled(ROOT_A, "done");
    s.markProjectRead(ROOT_A);
    expect(useProjectAlertsStore.getState().alerts[ROOT_A]).toBeUndefined();
    s.recordSettled(ROOT_A, "blocked");
    expect(useProjectAlertsStore.getState().alerts[ROOT_A]).toEqual(["blocked"]);
  });

  it("withoutProject 对不存在的键幂等（返回原引用）", () => {
    const alerts = withSettled({}, ROOT_A, "done");
    expect(withoutProject(alerts, ROOT_B)).toBe(alerts);
  });

  it("持久化形状：存的是未读集合本身——已读项不在集合里，重启读回即不复活", () => {
    // persist 的 partialize 只落 alerts；已读 = 键被删除，落盘的就是删除后的集合。
    // 这里钉住键名与「已读后集合里确实没有该项目」两个事实（E2E 钉真实 localStorage 往返）。
    expect(PROJECT_ALERTS_STORAGE_KEY).toBe("ffpane.project-alerts");
    const s = useProjectAlertsStore.getState();
    s.recordSettled(ROOT_A, "failed");
    s.markProjectRead(ROOT_A);
    expect(Object.keys(useProjectAlertsStore.getState().alerts)).toEqual([]);
  });
});

describe("T9.7 已读判定（切到该项目并打开会话页或任务页任一）", () => {
  it("会话页与任务页是已读路由，其余不是", () => {
    expect(READ_CLEARING_PATHS).toEqual(["/session", "/tasks"]);
    expect(isReadClearingPath("/session")).toBe(true);
    expect(isReadClearingPath("/tasks")).toBe(true);
    for (const path of ["/projects", "/plan", "/runs", "/memory", "/knowledge", "/settings"]) {
      expect(isReadClearingPath(path), path).toBe(false);
    }
  });

  it("即时已读：活跃项目自己正开着会话页/任务页时，新落定视为已读（不置位）", () => {
    expect(isInstantRead(ROOT_A, ROOT_A, "/session")).toBe(true);
    expect(isInstantRead(ROOT_A, ROOT_A, "/tasks")).toBe(true);
  });

  it("非即时已读：别的项目落定 / 活跃项目在其他页面 / 无活跃项目，都要置位", () => {
    expect(isInstantRead(ROOT_B, ROOT_A, "/session")).toBe(false);
    expect(isInstantRead(ROOT_A, ROOT_A, "/plan")).toBe(false);
    expect(isInstantRead(ROOT_A, null, "/session")).toBe(false);
  });
});

describe("T9.7 ui store 收展状态收敛（v1 → v2 迁移）", () => {
  it("旧 localStorage 键（实际生效的那套）优先于 v1 blob 的 navCollapsed", () => {
    const migrated = migrateUiState(
      { activePage: "session", navCollapsed: false, listDensity: "compact" },
      "1",
    );
    expect(migrated.navCollapsed).toBe(true);
    expect(migrated.activePage).toBe("session");
    expect(migrated.listDensity).toBe("compact");
  });

  it("旧键不存在时保留 v1 blob 的 navCollapsed", () => {
    expect(migrateUiState({ navCollapsed: true }, null).navCollapsed).toBe(true);
    expect(migrateUiState({ navCollapsed: false }, null).navCollapsed).toBe(false);
  });

  it('旧键为展开（"0"）时覆盖 v1 blob 的折叠值', () => {
    expect(migrateUiState({ navCollapsed: true }, "0").navCollapsed).toBe(false);
  });

  it("detailPanelCollapsed 被丢弃，secondaryPanelCollapsed 初始展开", () => {
    const migrated = migrateUiState({ detailPanelCollapsed: true }, null);
    expect("detailPanelCollapsed" in migrated).toBe(false);
    expect(migrated.secondaryPanelCollapsed).toBe(false);
  });

  it("v1 blob 缺字段 / 非对象时用初始值兜底", () => {
    const migrated = migrateUiState(undefined, null);
    expect(migrated.activePage).toBe("projects");
    expect(migrated.navCollapsed).toBe(false);
    expect(migrated.activeProjectId).toBeNull();
    expect(migrated.listDensity).toBe("default");
  });

  it("版本号已升到 2，旧键名导出可供迁移与 E2E 复用", () => {
    expect(UI_STORE_VERSION).toBe(2);
    expect(LEGACY_SIDEBAR_COLLAPSED_KEY).toBe("ffpane.ui-sidebar-collapsed");
  });
});

describe("T9.7 A/B 独立收展（store action 层面）", () => {
  beforeEach(() => {
    useUiStore.setState({ navCollapsed: false, secondaryPanelCollapsed: false });
  });

  it("toggleNavCollapsed 只动 A 栏，toggleSecondaryPanelCollapsed 只动 B 栏", () => {
    useUiStore.getState().toggleNavCollapsed();
    expect(useUiStore.getState().navCollapsed).toBe(true);
    expect(useUiStore.getState().secondaryPanelCollapsed).toBe(false);

    useUiStore.getState().toggleSecondaryPanelCollapsed();
    expect(useUiStore.getState().navCollapsed).toBe(true);
    expect(useUiStore.getState().secondaryPanelCollapsed).toBe(true);

    useUiStore.getState().toggleNavCollapsed();
    expect(useUiStore.getState().navCollapsed).toBe(false);
    expect(useUiStore.getState().secondaryPanelCollapsed).toBe(true);
  });

  it("bumpProjectsRefresh 单调递增（B 栏项目列表的刷新信号）", () => {
    const before = useUiStore.getState().projectsRefreshSeq;
    useUiStore.getState().bumpProjectsRefresh();
    useUiStore.getState().bumpProjectsRefresh();
    expect(useUiStore.getState().projectsRefreshSeq).toBe(before + 2);
  });
});

describe("T9.7 B 栏未读圆点的状态色区分（视觉上失败/阻塞/完成三色各异）", () => {
  it("三态取三个不同的状态色 token（§3.3）", async () => {
    const { TASK_STATUS_BADGE } = await import("../src/renderer/src/components/ui/badge.variants");
    const dots = (TASK_SETTLED_STATUSES as readonly TaskSettledStatus[]).map(
      (status) => TASK_STATUS_BADGE[status].dot,
    );
    expect(new Set(dots).size).toBe(3);
    expect(dots).toEqual(["bg-status-done", "bg-status-failed", "bg-status-blocked"]);
  });
});
