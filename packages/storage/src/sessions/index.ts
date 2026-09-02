/**
 * 会话层 barrel：会话登记表（T4.3，Local↔Native Session ID 映射 + 元数据，供原生恢复
 * 与上下文重建）+ 对话回放本与在飞轮次标记（T8.2b，text-only transcript，设计文档
 * §10.2 规则 3 修订版）。
 */

export * from "./errors.js";
export * from "./inflight.js";
export * from "./store.js";
export * from "./transcript.js";
