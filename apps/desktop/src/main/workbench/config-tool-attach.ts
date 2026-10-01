/**
 * 自配置 MCP 是否挂到这次启动。
 * 只给已能行使管理权的管理者，并且该项目的开关必须打开。
 * 冷读后尚未恢复、或被清洗锁住因而不会授予的，不算已能行使。
 */

import type { ManagerGrantAction } from "./manager-grant";

/** 这次启动会授予或已经授予管理权。待恢复、不授予都不算。 */
export function isConfigToolAuthorized(action: ManagerGrantAction): boolean {
  return action === "already" || action === "user-reauth" || action === "inherit";
}

export function shouldAttachConfigTool(input: {
  readonly role: string;
  readonly configToolEnabled: boolean;
  readonly managerAuthorized: boolean;
}): boolean {
  return input.role === "manager" && input.configToolEnabled === true && input.managerAuthorized;
}
