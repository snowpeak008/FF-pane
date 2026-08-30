/**
 * 三层记忆体系的第 1、2 层（设计文档 §8.1 项目记忆、§8.2 共享记忆/用户习惯）。
 * 第 3 层知识库独立成文件（knowledge.ts）。
 * 注入策略与 Prompt 组装属 T4.1 / T5.2，冲突检测属 T5.1，不在本文件。
 */

import type {
  EpochMillis,
  HabitEntryId,
  MemoryEntryId,
  PlanVersion,
  ProjectId,
  TaskId,
} from "./common.js";
import { createLiteralGuard } from "./common.js";

/** 设计文档 §8.1 —— 项目记忆分类（4 类，够用）。 */
export const MEMORY_CATEGORIES = ["decision", "rule", "lesson", "state"] as const;

/** 设计文档 §8.1 —— 项目记忆分类。 */
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** MemoryCategory 运行时守卫。 */
export const isMemoryCategory = createLiteralGuard(MEMORY_CATEGORIES);

/**
 * 设计文档 §8.1 —— 记忆状态（3 态）。
 * 流转：candidate ─用户通过→ active ─被替代/过时→ archived；用户拒绝 = 直接删除。
 * Agent 只能产生 candidate，写入 active 的唯一途径是用户在界面上点通过；
 * 用户手写的条目直接 active。习惯条目（§8.2.4）复用同一状态集合。
 */
export const MEMORY_STATUSES = ["candidate", "active", "archived"] as const;

/** 设计文档 §8.1 —— 记忆状态。 */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** MemoryStatus 运行时守卫。 */
export const isMemoryStatus = createLiteralGuard(MEMORY_STATUSES);

/**
 * 设计文档 §8.1 —— confidence：
 * high = 用户确认/测试证实；low = AI 提议未验证。
 */
export const MEMORY_CONFIDENCES = ["high", "low"] as const;

/** 设计文档 §8.1 —— 记忆置信度。 */
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

/** MemoryConfidence 运行时守卫。 */
export const isMemoryConfidence = createLiteralGuard(MEMORY_CONFIDENCES);

/** 设计文档 §8.1 —— source 来源类别（user_manual | task_<id> | plan_<version> | agent_proposed）。 */
export const MEMORY_SOURCE_KINDS = ["user_manual", "task", "plan", "agent_proposed"] as const;

/** 设计文档 §8.1 —— 记忆来源类别。 */
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** MemorySourceKind 运行时守卫。 */
export const isMemorySourceKind = createLiteralGuard(MEMORY_SOURCE_KINDS);

/**
 * 设计文档 §8.1 —— source 来源。
 * 原文的 `task_<id>` / `plan_<version>` 编码形式在类型层展开为判别联合，
 * 序列化格式由存储层（W1.2c）决定。
 */
export type MemorySource =
  | { readonly kind: "user_manual" }
  | { readonly kind: "task"; readonly taskId: TaskId }
  | { readonly kind: "plan"; readonly planVersion: PlanVersion }
  | { readonly kind: "agent_proposed" };

/** 设计文档 §8.1 —— 注入上限缺省值：单次注入不超过 20 条，超出按类别优先级 + 更新时间截断。 */
export const MEMORY_INJECTION_DEFAULT_LIMIT = 20;

/** 设计文档 §8.1 —— 项目记忆条目（MemoryEntry）。 */
export interface MemoryEntry {
  /** 设计文档 §8.1 —— id。 */
  readonly id: MemoryEntryId;
  /** 设计文档 §8.1 —— category。 */
  readonly category: MemoryCategory;
  /** 设计文档 §8.1 —— title 一句话标题。 */
  readonly title: string;
  /** 设计文档 §8.1 —— body 正文（Markdown，建议 200 字内）。 */
  readonly body: string;
  /** 设计文档 §8.1 —— status。 */
  readonly status: MemoryStatus;
  /** 设计文档 §8.1 —— source 来源。 */
  readonly source: MemorySource;
  /** 设计文档 §8.1 —— confidence。 */
  readonly confidence: MemoryConfidence;
  /** 设计文档 §8.1 —— created（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
  /** 设计文档 §8.1 —— updated（epoch 毫秒）。 */
  readonly updatedAt: EpochMillis;
  /** 设计文档 §8.1 —— supersedes 替代了哪条旧记忆（可空）。 */
  readonly supersedes?: MemoryEntryId;
  /** 设计文档 §8.1 —— tags 可选标签。 */
  readonly tags?: readonly string[];
}

/** 设计文档 §8.2.1 —— 习惯条目分类（4 类）。 */
export const HABIT_CATEGORIES = ["workflow", "tech", "communication", "environment"] as const;

/**
 * 设计文档 §8.2.1 —— 习惯分类：
 * workflow 做事顺序与流程习惯；tech 技术偏好；communication 沟通偏好；
 * environment 环境经验。不收架构决定（归项目记忆）、任务状态、资料（归知识库）。
 */
export type HabitCategory = (typeof HABIT_CATEGORIES)[number];

/** HabitCategory 运行时守卫。 */
export const isHabitCategory = createLiteralGuard(HABIT_CATEGORIES);

/** 设计文档 §8.2.4 —— 习惯的三种来源类别。 */
export const HABIT_SOURCE_KINDS = ["user_manual", "distilled", "observed"] as const;

/** 设计文档 §8.2.4 —— 习惯来源类别。 */
export type HabitSourceKind = (typeof HABIT_SOURCE_KINDS)[number];

/** HabitSourceKind 运行时守卫。 */
export const isHabitSourceKind = createLiteralGuard(HABIT_SOURCE_KINDS);

/**
 * 设计文档 §8.2.4 —— 习惯来源：
 * user_manual 用户手写（来源一）；distilled 从项目记忆提炼（来源二，
 * 保留溯源字段 source_project + source_entry_id）；observed 系统观察建议（来源三）。
 */
export type HabitSource =
  | { readonly kind: "user_manual" }
  | {
      readonly kind: "distilled";
      /** 设计文档 §8.2.4 —— source_project 溯源：提炼自哪个项目。 */
      readonly sourceProject: ProjectId;
      /** 设计文档 §8.2.4 —— source_entry_id 溯源：提炼自哪条项目记忆。 */
      readonly sourceEntryId: MemoryEntryId;
    }
  | { readonly kind: "observed" };

/** 设计文档 §8.2.5 —— 全量注入上限缺省值：80 条，接近上限时提示合并或归档，不自动淘汰。 */
export const HABIT_ENTRY_SOFT_LIMIT = 80;

/**
 * 设计文档 §8.2 —— 共享记忆（用户习惯）条目。跨项目生效，直接参与 Prompt 组装。
 * 任何来源的习惯条目都必须经用户确认才能 active（§8.2.4），状态复用 MemoryStatus。
 */
export interface HabitEntry {
  /** 内部唯一 ID。 */
  readonly id: HabitEntryId;
  /** 设计文档 §8.2.1 —— 分类。 */
  readonly category: HabitCategory;
  /** 习惯指令文本（编译进习惯档案的原文，§8.2.2）。 */
  readonly content: string;
  /** 设计文档 §8.1 / §8.2.4 —— 状态（candidate | active | archived）。 */
  readonly status: MemoryStatus;
  /**
   * 设计文档 §8.2.4 —— 单条停用开关（"全程可见、可编辑、可单条停用"）。
   * false = 暂不参与 Prompt 组装但保留条目；与 archived 的语义区分见 W1.1 报告。
   */
  readonly enabled: boolean;
  /** 设计文档 §8.2.4 —— 来源（三种，附提炼溯源）。 */
  readonly source: HabitSource;
  /**
   * 设计文档 §8.2.2 —— 重要度：习惯档案编译时的排序依据（值大者先渲染），
   * 用户可调整；同值按 updatedAt 排序（编译逻辑属 T5.2）。
   */
  readonly importance: number;
  /** 创建时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
  /** 更新时间（epoch 毫秒；变更触发习惯档案自动重编译，§8.2.2）。 */
  readonly updatedAt: EpochMillis;
}

/**
 * 设计文档 §8.2.4 来源三 —— 跨会话「纠正观察」记录（系统观察建议的累计依据）。
 * 用户在会话中反复用同类的话纠正 AI 时，把每次纠正归并到一条观察并累加 count；
 * 达到阈值即生成一条 observed 习惯候选（绝不自动 active）。全局持久（跨项目、跨会话）。
 */
export interface HabitObservation {
  /** 内部唯一 ID。 */
  readonly id: string;
  /** 代表性纠正文本（首次出现时记录，用于相似归并与候选正文）。 */
  readonly content: string;
  /** 累计出现次数（同类纠正相似归并后累加）。 */
  readonly count: number;
  /** 首次出现时间（epoch 毫秒）。 */
  readonly firstSeenAt: EpochMillis;
  /** 最近出现时间（epoch 毫秒）。 */
  readonly lastSeenAt: EpochMillis;
  /** 是否已据此生成过候选（生成后置真，避免每轮重复打扰）。 */
  readonly suggested: boolean;
}
