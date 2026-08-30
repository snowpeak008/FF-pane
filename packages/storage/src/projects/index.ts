/**
 * 项目注册表（工作台已登记项目）barrel。
 * 消费方：主进程 projects:* handlers、W3.3 项目列表页。
 * 本层只维护登记记录，不创建 / 不删除项目磁盘目录（见 registry.ts 模块注释）。
 */

export * from "./errors.js";
export * from "./registry.js";
