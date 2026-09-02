/**
 * 会话续接的纯视图逻辑（T8.2b-b）。与 React 无关，便于单测。
 *
 * 预判逻辑全仓只允许这一份：SessionResumePanel 的列表徽标与续接横幅共用本函数，
 * 谁都不许在组件里内联一份 `session.native !== undefined`（resume-view.test.ts 有源码守卫）。
 */

import type { SessionRecord, SessionResumeKind } from "@ff-pane/shared";

/** 预判可用的续接方式（handoff 是显式动作，不在"续接这条会话"的预判范围）。 */
export type PredictedResumeKind = Extract<SessionResumeKind, "native" | "context_rebuild">;

/**
 * 预判某条会话登记的续接方式：有原生绑定 → 原生恢复；否则 → 上下文重建。
 * 只是预判——实际方式以下一轮 `started.resumeKind` 为准（如原生恢复失败退化为重建）。
 */
export function predictResumeKind(session: SessionRecord): PredictedResumeKind {
  return session.native !== undefined ? "native" : "context_rebuild";
}
