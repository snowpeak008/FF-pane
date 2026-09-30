/**
 * 工作台窗口权限等级（T10.5）。
 * 前三级 = 沙盒模式；yolo = 完全放开。
 * Windows 上仅靠 CLI 规则 + 本软件 MCP 裁决，不是操作系统级隔离。
 */

/** 权限等级（自低到高）。 */
export const WORKBENCH_PERMISSION_LEVELS = ["read-only", "edit", "edit-exec", "yolo"] as const;

/** 工作台权限等级。 */
export type WorkbenchPermissionLevel = (typeof WORKBENCH_PERMISSION_LEVELS)[number];

/** 等级运行时守卫。 */
export function isWorkbenchPermissionLevel(value: unknown): value is WorkbenchPermissionLevel {
  return (
    typeof value === "string" && (WORKBENCH_PERMISSION_LEVELS as readonly string[]).includes(value)
  );
}

/** 等级序（越大越宽）。 */
export const WORKBENCH_PERMISSION_RANK: Readonly<Record<WorkbenchPermissionLevel, number>> = {
  "read-only": 0,
  edit: 1,
  "edit-exec": 2,
  yolo: 3,
};

/** 比较：a 是否 ≤ b。 */
export function permissionLevelLte(
  a: WorkbenchPermissionLevel,
  b: WorkbenchPermissionLevel,
): boolean {
  return WORKBENCH_PERMISSION_RANK[a] <= WORKBENCH_PERMISSION_RANK[b];
}

/** 取两级中较严者。 */
export function minPermissionLevel(
  a: WorkbenchPermissionLevel,
  b: WorkbenchPermissionLevel,
): WorkbenchPermissionLevel {
  return permissionLevelLte(a, b) ? a : b;
}

/** 出厂：新窗口默认权限。 */
export const DEFAULT_WORKBENCH_WINDOW_PERMISSION: WorkbenchPermissionLevel = "edit";

/**
 * 开启者：界面用户，或某管理者窗口。
 * 持久化为 `"user"` 或 `{ "windowId": "…" }`。
 */
export type WorkbenchOpenedBy = "user" | { readonly windowId: string };

/** openedBy 运行时守卫。 */
export function isWorkbenchOpenedBy(value: unknown): value is WorkbenchOpenedBy {
  if (value === "user") {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as { readonly windowId?: unknown };
  return typeof raw.windowId === "string" && raw.windowId.trim() !== "";
}

/** 解析 openedBy；无法识别时回退为 user。 */
export function parseWorkbenchOpenedBy(value: unknown): WorkbenchOpenedBy {
  if (isWorkbenchOpenedBy(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && value !== "user") {
    // 旧预留字段曾用裸字符串；无法可靠区分 → 视为 user
    return "user";
  }
  return "user";
}
