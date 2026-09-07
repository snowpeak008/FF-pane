/**
 * Planner 跟进回路第一档（T9.10）：Worker 落定结算摘要（规则拼装）+
 * 任务看板增量组装（队列 + 基准 diff，上限截断）。纯逻辑零 IO；
 * 队列落盘归 storage sessions/planner-report.ts，接线归编排器。
 */

export * from "./board-delta.js";
export * from "./settlement.js";
