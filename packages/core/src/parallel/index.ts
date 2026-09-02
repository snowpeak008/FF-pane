/**
 * 任务并行（T8.3a，设计文档 §14 M3）：writePaths 互斥核查 + 在飞轮次表。
 * 接口先行——本模块只有纯逻辑，真正的并发执行与装配归 T8.3b。
 */

export * from "./active-turns.js";
export * from "./write-conflict.js";
