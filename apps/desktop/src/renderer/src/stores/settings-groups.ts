/**
 * 设置页分组词表（T11.9 / 技能计划 §6）。
 *
 * 设置页左边一列分组，右边一次只显示一组。组的顺序与身份只在这里写一份；
 * 路由用 `/settings?group=<key>` 直达某一组（项目卡片、E2E 都走这条），
 * 不带参数时回到上次打开的那一组（存在 ui store 里）。
 * 本文件零依赖，ui store 和设置页都从这里取，可直接单测。
 */

export const SETTINGS_GROUPS = ["general", "workbench", "models", "tools"] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const DEFAULT_SETTINGS_GROUP: SettingsGroup = "general";

const SETTINGS_GROUP_SET: ReadonlySet<string> = new Set(SETTINGS_GROUPS);

export function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === "string" && SETTINGS_GROUP_SET.has(value);
}

/** 地址里的组优先；没有或不认识就用上次那一组；都不行回到第一组。 */
export function resolveSettingsGroup(fromUrl: string | null, remembered: unknown): SettingsGroup {
  if (isSettingsGroup(fromUrl)) {
    return fromUrl;
  }
  return isSettingsGroup(remembered) ? remembered : DEFAULT_SETTINGS_GROUP;
}
