/**
 * Plan 状态机（开发计划 W1.4a）：合法迁移表、迁移函数、版本演进与 typed error。
 * 纯逻辑、零 IO；本目录不依赖 task / permission 等并行工单目录。
 */

export * from "./errors.js";
export * from "./next-draft.js";
export * from "./transitions.js";
