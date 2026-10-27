/**
 * 工作台窗口角色（T10.6）。
 * 与旧会话 Role / CustomRole 无关：只描述多窗口工作台里的预定义角色。
 */

/** 工作台角色（none = 普通，默认）。supervisor = 监管者，researcher = 调研。 */
export const WORKBENCH_ROLES = [
  "manager",
  "planner",
  "worker",
  "reviewer",
  "supervisor",
  /** 调研（T11.1）：只读，只回答一个问题，结论写进 brief、附证据，交回后自关。取代子 agent 干的小调研。 */
  "researcher",
  "none",
] as const;

/** 工作台窗口角色。 */
export type WorkbenchRole = (typeof WORKBENCH_ROLES)[number];

/** 出厂：新窗口默认角色。 */
export const DEFAULT_WORKBENCH_ROLE: WorkbenchRole = "none";

/** 角色运行时守卫。 */
export function isWorkbenchRole(value: unknown): value is WorkbenchRole {
  return typeof value === "string" && (WORKBENCH_ROLES as readonly string[]).includes(value);
}

/**
 * 解析角色；缺失或无法识别时回退为 none（布局升版兼容）。
 */
export function parseWorkbenchRole(value: unknown): WorkbenchRole {
  return isWorkbenchRole(value) ? value : DEFAULT_WORKBENCH_ROLE;
}

/** 随应用打包的角色说明书 id（none 没有单独文件）。 */
export const WORKBENCH_ROLE_MANUAL_IDS = [
  "base",
  "manager",
  "planner",
  "worker",
  "reviewer",
  "supervisor",
  "researcher",
] as const;

/** 角色说明书 id。base 是所有 AI 窗口共用的说明。 */
export type WorkbenchRoleManualId = (typeof WORKBENCH_ROLE_MANUAL_IDS)[number];

/** 说明书 id 守卫。 */
export function isWorkbenchRoleManualId(value: unknown): value is WorkbenchRoleManualId {
  return (
    typeof value === "string" && (WORKBENCH_ROLE_MANUAL_IDS as readonly string[]).includes(value)
  );
}
