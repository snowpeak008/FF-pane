/**
 * 在飞轮次表（T8.3a，接口先行）：编排器并发轮次管理的状态形状与纯函数。
 *
 * 本模块只定形状与登记 / 注销 / 裁决的纯逻辑，**不做真正的并发执行**——
 * 编排器接线（start 时登记、finalize / settleInterrupted 时注销、并发 drain）
 * 归 T8.3b。纯函数化的理由与仓内既有款式一致（quit.ts 的「计算要做什么」、
 * interrupted.ts 的 Run 补写）：并发裁决是最容易出竞态 bug 的一层，抽成
 * 不可变数据 + 纯函数后单测可以穷举场景，编排器只剩「在哪个时刻调用」。
 *
 * 与编排器现状的关系：orchestrator.ts 的 `active: Map<string, ActiveTurn>` 已经
 * 允许多轮共存（start 对不同 turnId 不互斥），但它装的是进程句柄与收尾上下文，
 * 不含 writePaths——并行裁决需要的「这轮在写哪里」在这里补齐。T8.3b 装配时
 * 编排器同时维护两份：ActiveTurn 管生命周期，ActiveTurnRecord 管并行事实。
 */

import type { EpochMillis, LocalSessionId, Role, TaskId } from "@ff-pane/shared";
import {
  checkWritePathsExclusive,
  type ParallelWriteDecision,
  type ParallelWriteTask,
} from "./write-conflict.js";

/**
 * 一条在飞轮次的并行事实（T8.3a 定稿；per-项目，键 = turnId）。
 *
 * writePaths 取**装配后信封**的 writePaths（assembleRunEnvelope 的产物，
 * 即 角色默认 ∩ Profile 预设 ∩ 任务 writeScope 的交集）而非任务合同原文——
 * 信封才是这轮真正被放行写入的范围，用合同原文裁决会把已被信封收窄掉的
 * 范围也算作占用。Planner / Reviewer 轮的信封 writePaths 为空（角色默认
 * 不可写），按空 = 无写权限语义与任何轮可并行，无需特判角色。
 */
export interface ActiveTurnRecord {
  readonly turnId: string;
  readonly sessionId: LocalSessionId;
  readonly role: Role;
  /** Worker / 审查轮关联的任务；Planner 讨论 / 计划生成轮缺席。 */
  readonly taskId?: TaskId;
  /** 本轮装配后信封的可写范围（并行裁决的输入）。 */
  readonly writePaths: readonly string[];
  readonly startedAt: EpochMillis;
}

/**
 * 在飞轮次表：turnId → 记录。**不可变值**（每次登记 / 注销返回新表），
 * 与 zustand / 编排器内部的可变 Map 相区分——裁决函数拿到的表是一个
 * 时间点的快照，不会在遍历中途被另一轮的收尾改掉。
 */
export type ActiveTurnTable = ReadonlyMap<string, ActiveTurnRecord>;

/** 空表（登记的起点）。 */
export const EMPTY_ACTIVE_TURN_TABLE: ActiveTurnTable = new Map();

/** 登记一轮（同 turnId 重复登记是编排 bug，抛错快速失败——与注册表款式一致）。 */
export function registerActiveTurn(
  table: ActiveTurnTable,
  record: ActiveTurnRecord,
): ActiveTurnTable {
  if (table.has(record.turnId)) {
    throw new Error(`轮次「${record.turnId}」已在飞，重复登记是编排错误`);
  }
  const next = new Map(table);
  next.set(record.turnId, record);
  return next;
}

/** 注销一轮（对不存在的 turnId 幂等——收尾与退出钩子可能各删一次）。 */
export function unregisterActiveTurn(table: ActiveTurnTable, turnId: string): ActiveTurnTable {
  if (!table.has(turnId)) {
    return table;
  }
  const next = new Map(table);
  next.delete(turnId);
  return next;
}

/** 在飞轮次列表（按 startedAt 升序，稳定可遍历；契约查询与任务页呈现的数据源）。 */
export function listActiveTurns(table: ActiveTurnTable): readonly ActiveTurnRecord[] {
  return [...table.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 候选轮能否与当前在飞轮并行（复用 checkWritePathsExclusive，语义与拒绝原因
 * 见 write-conflict.ts）。候选以 taskId（有任务时）或 turnId 进入拒绝原因文本——
 * 用户在任务页认的是任务，不是轮次内部 ID。
 */
export function checkTurnParallelism(
  table: ActiveTurnTable,
  candidate: {
    readonly turnId: string;
    readonly taskId?: TaskId;
    readonly writePaths: readonly string[];
  },
): ParallelWriteDecision {
  const candidateTask: ParallelWriteTask = {
    id: candidate.taskId ?? candidate.turnId,
    writePaths: candidate.writePaths,
  };
  const inflight = listActiveTurns(table)
    // 自反守卫：同一轮重入（编排器 start 的 turnId 去重之外的第二道）不与自己互斥
    .filter((record) => record.turnId !== candidate.turnId)
    .map((record) => ({
      id: record.taskId ?? record.turnId,
      writePaths: record.writePaths,
    }));
  return checkWritePathsExclusive(candidateTask, inflight);
}
