/**
 * Agent Profile 校验模块（W1.6，设计文档 §4.4 / §3.1）barrel。纯逻辑、零 IO。
 * 持久化归 @ff-pane/storage 的 profiles 模块（两包互不依赖，宿主接线）；
 * 消费方：W3.2b 设置页 Profile 管理、Phase 4 Prompt 组装。
 */

export * from "./errors.js";
export * from "./validate.js";
