/**
 * 权限信封模块（W1.4c，设计文档 §7 / §29）。纯逻辑、零 IO。
 * 三家 AI CLI 的自带沙箱/审批均不可依赖（T2.0 结论），本模块是
 * FF-pane 唯一可信的权限事实源；主要消费者为 W2.7 权限执行层。
 */

export * from "./command.js";
export * from "./envelope.js";
export * from "./paths.js";
