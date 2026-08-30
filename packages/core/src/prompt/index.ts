/**
 * Prompt 组装层（T4.1，设计文档 §8.2.2）barrel。
 * 纯逻辑：四层组装 + 记忆注入策略 + 输出语言三级取值。消费方：T4.2 会话执行接线。
 */

export * from "./assemble.js";
export * from "./inject.js";
export * from "./language.js";
export * from "./roles.js";
