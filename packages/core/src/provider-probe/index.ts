/**
 * Provider 连接探测（W1.5c，设计文档 §4.2）：testConnection 连接测试 + fetchModels 模型拉取。
 * 纯网络探测逻辑：不依赖 Electron / secrets 模块、不做密钥存取——明文 key 由主进程
 * （W1.5b revealSecret）取出后作为参数传入，仅用于构造请求头，用完即弃；
 * 一切输出经 redactSecret 兜底脱敏，key 不出现在任何返回值中（§4.3 密钥红线）。
 * 消费方：W3.2a 设置页（经主进程 IPC）。
 */

export * from "./fetch-models.js";
export * from "./model-kind.js";
export * from "./raw-error.js";
export * from "./test-connection.js";
export * from "./types.js";
export * from "./url.js";
