/**
 * 自定义角色持久化（T8.4）barrel。
 * 消费方：设置页角色管理（roles:* IPC）、编排器角色解析（Prompt 第 1 层 + 信封装配）。
 * 领域校验归 @ff-pane/core 的 permission/custom-role 模块（依赖注入接线，两包互不依赖）。
 */

export * from "./errors.js";
export * from "./store.js";
