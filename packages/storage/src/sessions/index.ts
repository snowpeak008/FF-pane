/**
 * 会话登记表持久化（T4.3）barrel：Local↔Native Session ID 映射 + 会话元数据，
 * 供原生恢复与上下文重建（设计文档 §10.2 规则 3 / §10.3）。不复制会话内容。
 */

export * from "./errors.js";
export * from "./store.js";
