/**
 * 续接 / 重新开始 yolo 或管理者窗口时的确认。
 * 每个窗口在一次应用启动里确认过就不再问。取消不记入。
 */

import type { WorkbenchPermissionLevel, WorkbenchRole } from "@ff-pane/shared";

const acceptedWindowIds = new Set<string>();

export function needsSensitiveLaunchConfirm(
  windowId: string,
  permission: WorkbenchPermissionLevel,
  role: WorkbenchRole,
): boolean {
  if (acceptedWindowIds.has(windowId)) {
    return false;
  }
  return permission === "yolo" || role === "manager";
}

export function rememberSensitiveLaunchConfirm(windowId: string): void {
  acceptedWindowIds.add(windowId);
}

export function resetSensitiveLaunchConfirmForTests(): void {
  acceptedWindowIds.clear();
}
