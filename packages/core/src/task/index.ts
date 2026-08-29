/**
 * W1.4b —— Task 状态机 + Run 生命周期（纯逻辑、零 IO，任务执行语义的权威定义）。
 * 迁移表：transitions.ts；迁移函数与 done 判定：task-machine.ts；
 * Run 生命周期与联动：run-lifecycle.ts；词汇与标记：model.ts；错误：errors.ts。
 */

export * from "./errors.js";
export * from "./model.js";
export * from "./run-lifecycle.js";
export * from "./task-machine.js";
export * from "./transitions.js";
