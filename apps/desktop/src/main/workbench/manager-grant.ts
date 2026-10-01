/**
 * 冷启动之后的管理权（T10.7b）。
 * 布局里的 manager 只用于显示。开窗口能力只来自本进程的授予。
 * 用户续接或重新开始顶层（openedBy=user、无父级）管理者时，视为重新授权。
 * 有父级的管理者，仅当父级当前已是被授予的管理者才继承；否则保持待恢复。
 */

import type { WorkbenchOpenedBy, WorkbenchRole } from "@ff-pane/shared";

export type ManagerGrantAction = "user-reauth" | "inherit" | "pending" | "already" | "none";

export function decideManagerGrantRestore(input: {
  readonly role: WorkbenchRole | undefined;
  readonly openedBy: WorkbenchOpenedBy;
  readonly parentWindowId?: string;
  readonly parentRole?: WorkbenchRole;
  readonly parentGranted: boolean;
  readonly alreadyGranted: boolean;
  /** 冷启动清洗锁住的窗口，续接不得重新授权。 */
  readonly sanitizeLocked?: boolean;
  /** 界面用户改过角色后，锁不再挡住管理权。 */
  readonly userRoleSet?: boolean;
}): ManagerGrantAction {
  if (input.role !== "manager") {
    return "none";
  }
  if (input.alreadyGranted) {
    return "already";
  }
  if (input.sanitizeLocked === true && input.userRoleSet !== true) {
    return "none";
  }
  const hasParent = input.parentWindowId !== undefined && input.parentWindowId.trim() !== "";
  if (!hasParent) {
    return input.openedBy === "user" ? "user-reauth" : "none";
  }
  if (input.parentRole === "manager" && input.parentGranted) {
    return "inherit";
  }
  return "pending";
}
