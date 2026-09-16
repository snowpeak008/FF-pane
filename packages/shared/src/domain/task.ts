/**
 * 任务合同与任务状态（设计文档 §6.2、§6.3、§6.5）。
 * 合法状态迁移表不在本工单（属 W1.4b），此处只定稿状态集合与结构。
 */

import type {
  ClarificationRequestId,
  EpochMillis,
  MemoryEntryId,
  PlanVersion,
  RunId,
  TaskId,
} from "./common.js";
import { createLiteralGuard } from "./common.js";

/**
 * 设计文档 §6.3 —— 任务状态。
 * 注意：§6.3 标题写"6 种"，但正文枚举了 7 个值（含 cancelled 终态）；
 * 任务页六列（§11.4）不含 cancelled。以正文枚举为准，共 7 个字面量，
 * 详见 W1.1 报告争议点。
 */
export const TASK_STATUSES = [
  "pending",
  "running",
  "blocked",
  "failed",
  "done",
  "accepted",
  "cancelled",
] as const;

/** 设计文档 §6.3 —— 任务状态。关键规则：done ≠ accepted。 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** TaskStatus 运行时守卫。 */
export const isTaskStatus = createLiteralGuard(TASK_STATUSES);

/** 设计文档 §6.3 —— 终态（accepted、cancelled 在枚举中被明确标注为终态）。 */
export const TASK_TERMINAL_STATUSES = ["accepted", "cancelled"] as const;

/** 设计文档 §6.3 —— 任务终态。 */
export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

/** TaskTerminalStatus 运行时守卫。 */
export const isTaskTerminalStatus = createLiteralGuard(TASK_TERMINAL_STATUSES);

/**
 * 任务落定状态（T9.7 B 栏落定高亮 / T9.10 结算摘要）：done / failed / blocked 三态。
 * 是 TaskStatus 的子集而不是全集：accepted / cancelled 是用户亲手操作的结果（他知道），
 * pending / running 不是落定——需要「被看见 / 被汇报」的只有这三个 Agent 侧产生的收场。
 *
 * 落点从 shared-ipc/contracts.ts 移到此处（T9.10）：结算摘要队列（storage）与摘要拼装
 * （core）都要消费这组字面量，而 packages 不依赖 apps 的契约层；contracts.ts 原样
 * 再导出，两端消费方不变、事实源只此一份。
 */
export const TASK_SETTLED_STATUSES = ["done", "failed", "blocked"] as const;

/** 任务落定状态（TaskStatus 的三态子集）。 */
export type TaskSettledStatus = (typeof TASK_SETTLED_STATUSES)[number];

/** TaskSettledStatus 运行时守卫。 */
export const isTaskSettledStatus = createLiteralGuard(TASK_SETTLED_STATUSES);

/**
 * 设计文档 §6.2 —— 任务合同（Worker 收到的不是聊天记录，是任务合同）。
 * 即 §6.2 的 Task 结构去掉 status：计划内的任务列表（§6.1 tasks）与
 * 派发给 Worker 的输入都是纯合同，运行状态由 Task 记录承载。
 */
export interface TaskContract {
  /** 设计文档 §6.2 —— id。 */
  readonly id: TaskId;
  /** 设计文档 §6.2 —— plan_version 所属计划版本。 */
  readonly planVersion: PlanVersion;
  /** 设计文档 §6.2 —— goal 任务目标。 */
  readonly goal: string;
  /** 设计文档 §6.2 —— write_scope 允许修改的路径列表（相对项目根的路径模式）。 */
  readonly writeScope: readonly string[];
  /** 设计文档 §6.2 —— forbidden 禁止事项。 */
  readonly forbidden: readonly string[];
  /** 设计文档 §6.2 —— depends_on 依赖的任务。 */
  readonly dependsOn: readonly TaskId[];
  /** 设计文档 §6.2 / §8.1 —— context_refs 注入的记忆条目 ID 列表（Planner 拆任务时挑选）。 */
  readonly contextRefs: readonly MemoryEntryId[];
  /** 设计文档 §6.2 —— acceptance 验收标准（可核对的条目）。 */
  readonly acceptance: readonly string[];
  /**
   * 设计文档 §6.2 —— verify_cmd 验证命令（如测试命令）。
   * 可选：并非所有任务都有可机验命令（如纯文档任务）；无验证命令时
   * done 的判定规则由 W1.4b 定义。
   */
  readonly verifyCmd?: string;
  /**
   * T9.11 —— 本任务派发给执行者时的思考强度。
   * 缺省 = 用执行者档案默认。规划者可在计划 JSON 里写；用户可在任务页改。
   * 取值须为 {@link ReasoningEffortLevel}；非法值解析时丢弃。
   */
  readonly reasoningEffort?: string;
}

/** 设计文档 §6.2 / §6.3 —— 任务记录 = 任务合同 + 运行状态。 */
export interface Task extends TaskContract {
  /** 设计文档 §6.3 —— status。 */
  readonly status: TaskStatus;
  /**
   * 最近一次失败原因（可选）。
   * running→failed 时写入（completeTask 证据被拒的 reason，或落盘/推进失败码）；
   * 再次派发时清掉。供任务卡与结算摘要说明「为什么活干完了仍是失败」。
   */
  readonly failReason?: string;
}

/** 设计文档 §6.5 —— 澄清请求的回答方：由用户或 Planner 回答后任务继续。 */
export const CLARIFICATION_ANSWERED_BY = ["user", "planner"] as const;

/** 设计文档 §6.5 —— 澄清请求回答方。 */
export type ClarificationAnsweredBy = (typeof CLARIFICATION_ANSWERED_BY)[number];

/** ClarificationAnsweredBy 运行时守卫。 */
export const isClarificationAnsweredBy = createLiteralGuard(CLARIFICATION_ANSWERED_BY);

/** 设计文档 §6.5 —— 澄清请求的回答。 */
export interface ClarificationAnswer {
  /** 设计文档 §6.5 —— 回答方（用户或 Planner）。 */
  readonly answeredBy: ClarificationAnsweredBy;
  /** 回答正文。 */
  readonly content: string;
  /** 回答时间（epoch 毫秒）。 */
  readonly answeredAt: EpochMillis;
}

/**
 * 设计文档 §6.5 —— 结构化澄清请求（格式固定：问题 / 影响 / 选项 / 建议）。
 * Worker 遇不确定问题时提交，任务转 blocked（§6.3）。
 * 这是 Worker 与用户/Planner 之间唯一的沟通通道——不允许 Worker 和 Planner
 * 绕开用户自由对话（§6.5；§13 红线"Agent 自由互聊"）。
 */
export interface ClarificationRequest {
  /** 请求唯一 ID。 */
  readonly id: ClarificationRequestId;
  /** 所属任务。 */
  readonly taskId: TaskId;
  /** 发起请求的 Run（若在执行中发起）。 */
  readonly runId?: RunId;
  /** 设计文档 §6.5 —— 问题。 */
  readonly question: string;
  /** 设计文档 §6.5 —— 影响（不解决会怎样）。 */
  readonly impact: string;
  /** 设计文档 §6.5 —— 选项。 */
  readonly options: readonly string[];
  /** 设计文档 §6.5 —— 建议（Worker 倾向的选项及理由）。 */
  readonly recommendation: string;
  /** 请求发起时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
  /** 设计文档 §6.5 —— 回答（未回答时缺省，任务保持 blocked）。 */
  readonly answer?: ClarificationAnswer;
}
