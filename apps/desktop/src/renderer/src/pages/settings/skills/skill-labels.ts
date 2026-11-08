/**
 * 技能在界面上怎么称呼、有什么限制（T11.9）。设置页技能库和项目卡片共用，纯函数。
 */

import type { SkillView } from "../../../../../shared-ipc/contracts";

/** 列表里显示的名字：改过就用改的，没改用原名。 */
export function skillTitle(skill: Pick<SkillView, "name" | "displayName">): string {
  return skill.displayName.trim() !== "" ? skill.displayName : skill.name;
}

/** 搜索：显示名和原名都能搜到，不分大小写。 */
export function skillMatches(
  skill: Pick<SkillView, "name" | "displayName" | "description">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return [skill.name, skill.displayName, skill.description].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/**
 * 这个技能最要紧的一条限制的语言包键；没有限制返回 undefined。
 * 先说用不了，再说只适用于哪家，最后说 Codex 窗口里会失败的写法。
 */
export function skillLimitKey(
  skill: Pick<SkillView, "status" | "appliesTo" | "windowsHttps">,
): string | undefined {
  if (skill.status !== "ok") {
    return `settings.skills.status.${skill.status}`;
  }
  if (skill.appliesTo === "claude") {
    return "settings.skills.limit.claudeOnly";
  }
  if (skill.appliesTo === "codex") {
    return "settings.skills.limit.codexOnly";
  }
  if (skill.windowsHttps) {
    return "settings.skills.limit.windowsHttps";
  }
  return undefined;
}
