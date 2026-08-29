/**
 * Run：某任务的一次实际尝试与其证据（设计文档 §6.4）。
 * Run 是可追溯的证据记录：文件修改、命令、验证结果全部落盘（§11.5 执行记录页）。
 */

import type { EpochMillis, ProfileId, RunId, TaskId } from "./common.js";
import { createLiteralGuard } from "./common.js";

/** 设计文档 §6.4 —— end_reason 结束原因。 */
export const RUN_END_REASONS = ["completed", "failed", "cancelled", "crashed"] as const;

/** 设计文档 §6.4 —— Run 结束原因。 */
export type RunEndReason = (typeof RUN_END_REASONS)[number];

/** RunEndReason 运行时守卫。 */
export const isRunEndReason = createLiteralGuard(RUN_END_REASONS);

/**
 * 设计文档 §6.4 —— file_changes 条目：修改文件 + diff。
 * diff 为 unified diff 文本（新建/删除/改名同样以 diff 表达）；
 * 无法从事件流取得 diff 的 Runtime（如 Codex）由适配器用 git 快照采集（W2.3）。
 */
export interface FileChange {
  /** 修改的文件路径（相对项目根）。 */
  readonly path: string;
  /** unified diff 文本。 */
  readonly diff: string;
}

/**
 * 设计文档 §6.4 —— commands 条目：执行过的命令 + 退出码。
 * 命令的完整输出不入 Run 记录（体积不可控），归 raw_log_path 的原始日志。
 */
export interface CommandRecord {
  /** 执行的命令原文。 */
  readonly command: string;
  /** 退出码（适配器无法取得结构化退出码时按其映射规则推断，如 -1）。 */
  readonly exitCode: number;
}

/** 设计文档 §6.4 —— verify_result 验证命令输出。通过与否 = exitCode === 0。 */
export interface VerifyResult {
  /** 实际执行的验证命令（来自任务合同 verify_cmd，§6.2）。 */
  readonly command: string;
  /** 验证命令退出码。 */
  readonly exitCode: number;
  /** 验证命令输出（stdout + stderr 合并文本）。 */
  readonly output: string;
}

/**
 * 设计文档 §6.4 —— Run（执行记录）：每次尝试一条。
 * 任务 failed 后重试即产生新 Run（§6.3），attempt 递增。
 */
export interface Run {
  /** Run 内部唯一 ID（存储目录 run-<id>，§10.2）。 */
  readonly id: RunId;
  /** 设计文档 §6.4 —— task_id 所属任务。 */
  readonly taskId: TaskId;
  /** 设计文档 §6.4 —— 序号：该任务的第几次尝试，从 1 起。 */
  readonly attempt: number;
  /** 设计文档 §6.4 —— profile 用哪个 Agent Profile 执行的。 */
  readonly profileId: ProfileId;
  /** 设计文档 §6.4 —— started 开始时间（epoch 毫秒）。 */
  readonly startedAt: EpochMillis;
  /** 设计文档 §6.4 —— ended 结束时间（执行中缺省）。 */
  readonly endedAt?: EpochMillis;
  /** 设计文档 §6.4 —— end_reason（执行中缺省，与 endedAt 同时出现）。 */
  readonly endReason?: RunEndReason;
  /** 设计文档 §6.4 —— file_changes 修改文件列表 + diff。 */
  readonly fileChanges: readonly FileChange[];
  /** 设计文档 §6.4 —— commands 执行过的命令 + 退出码。 */
  readonly commands: readonly CommandRecord[];
  /** 设计文档 §6.4 —— verify_result 验证命令输出（未跑验证时缺省）。 */
  readonly verifyResult?: VerifyResult;
  /** 设计文档 §6.4 —— report Worker 的完成报告（Markdown，未产出时缺省）。 */
  readonly report?: string;
  /** 设计文档 §6.4 —— raw_log_path 原始日志文件路径（保留但不进主界面）。 */
  readonly rawLogPath: string;
}
