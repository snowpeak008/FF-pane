/**
 * Provider CRUD 与配置持久化（W1.5a）barrel。
 * 消费方：W1.5c 连接测试、W1.6 Profile、W3.2a 设置页。
 * 密钥红线（设计文档 §4.3）：本模块只经手 ApiKeyRef 引用，密钥本体归 W1.5b。
 */

export * from "./errors.js";
export * from "./store.js";
export * from "./validate.js";
