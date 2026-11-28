/**
 * 监管者名单自动推送（T11.1b §4）。
 *
 * 监管者名下新开或关掉窗口时，平台推一句给它，管理者不用再手动发「名单更新」。
 * 纯函数：只拼话，不碰终端和收件箱；谁收、怎么送由调用方定。
 */

import { stripControls } from "./remind";

export interface RosterWindow {
  readonly windowId: string;
  readonly title: string;
  /** 角色的中文名，如「执行」「检查」。 */
  readonly roleLabel: string;
}

const MAX_TITLE_CHARS = 60;
const MAX_PATH_CHARS = 200;

function clean(value: string, max: number): string {
  return stripControls(value).trim().slice(0, max);
}

/** 新开了一个归它盯的窗口。 */
export function buildRosterOpenedLine(window: RosterWindow, briefPath?: string): string {
  const brief =
    briefPath !== undefined && briefPath.trim() !== "" ? clean(briefPath, MAX_PATH_CHARS) : "";
  return `[名单] 新开 ${clean(window.title, MAX_TITLE_CHARS)}（${window.roleLabel}，${window.windowId}${brief !== "" ? `，执行说明 ${brief}` : ""}），归你盯。`;
}

/** 归它盯的窗口关掉了。 */
export function buildRosterClosedLine(window: RosterWindow): string {
  return `[名单] 已关闭 ${clean(window.title, MAX_TITLE_CHARS)}（${window.roleLabel}，${window.windowId}），不用再盯。`;
}
