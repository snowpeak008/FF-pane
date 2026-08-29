/**
 * shared-ipc：类型安全 IPC 框架（契约 / 信封 / 客户端 / 服务端装配）。
 * 本目录不依赖 Electron，可在任意进程与测试环境中引用。
 * 消费方（main / preload / renderer）建议直接 import 具体模块以保持打包精简。
 */
export * from "./client";
export * from "./contracts";
export * from "./envelope";
export * from "./server";
