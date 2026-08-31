/**
 * Handoff 交接包：跨 Agent 迁移（设计文档 §10.4，精简为 8 字段）。
 * 生成后展示给用户预览（可编辑），确认后注入新 Agent 会话（渲染与注入属 T7.1）。
 * 红线（§4.3 / §10.4）：密钥、原始日志、其他项目内容永不进入 Handoff——
 * 本结构的所有字段类型均不含这三类数据。
 */

import type { TaskId } from "./common.js";
import type { MemoryEntry } from "./memory.js";
import type { Plan } from "./plan.js";
import type { TaskStatus } from "./task.js";

/**
 * 设计文档 §10.4 —— progress 条目：任务清单及状态（done/进行中/待办）。
 * 状态沿用 §6.3 的完整集合，比原文的三档更精确且无信息损失。
 */
export interface HandoffTaskProgress {
  /** 任务 ID。 */
  readonly taskId: TaskId;
  /** 任务目标（§6.2 goal，交接包需自含可读）。 */
  readonly goal: string;
  /** 任务状态。 */
  readonly status: TaskStatus;
}

/** 设计文档 §10.4 —— Handoff 交接包（8 字段，不多不少）。 */
export interface Handoff {
  /** 设计文档 §10.4 —— project_goal 项目目标（一段话）。 */
  readonly projectGoal: string;
  /**
   * 设计文档 §10.4 —— plan 当前计划版本全文（结构化，渲染为文本见 core/handoff/render）。
   *
   * T7.1 改为可选：换 Agent 未必发生在有计划之后（最典型的一次就是"和这个 Planner
   * 聊不下去，换一个再谈"——此刻计划恰恰还没出来）。要求必有计划会让交接包在最需要它的
   * 时刻反而生成不出来。缺省 = 尚无计划，渲染层如实写明，与 §10.3 上下文重建对
   * "无计划"的处理同构（assembleRebuildContext 也是缺省即不渲染该节）。
   */
  readonly plan?: Plan;
  /** 设计文档 §10.4 —— progress 任务清单及状态。 */
  readonly progress: readonly HandoffTaskProgress[];
  /** 设计文档 §10.4 —— decisions：active 状态的 decision 记忆。 */
  readonly decisions: readonly MemoryEntry[];
  /** 设计文档 §10.4 —— rules：active 状态的 rule 记忆。 */
  readonly rules: readonly MemoryEntry[];
  /** 设计文档 §10.4 —— recent_lessons：最近的 lesson 记忆。 */
  readonly recentLessons: readonly MemoryEntry[];
  /** 设计文档 §10.4 —— open_issues 阻塞与未决问题。 */
  readonly openIssues: readonly string[];
  /** 设计文档 §10.4 —— expectation 期望接收方接下来做什么。 */
  readonly expectation: string;
}
