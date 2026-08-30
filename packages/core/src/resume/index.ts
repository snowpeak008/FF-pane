/**
 * 会话恢复（T4.3，设计文档 §10.3）barrel：恢复方式判定（native / context_rebuild）
 * 与上下文重建文本组装。跨 Agent 迁移（handoff）归 Phase 7，不在此。
 */

export * from "./decide.js";
export * from "./rebuild.js";
