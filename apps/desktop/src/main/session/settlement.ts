/**
 * Worker 落定结算摘要入队（T9.10 ①）：saveTask 落盘点旁的接缝。
 *
 * 事实源选择：与 T9.7 tasks:settled 同点——**主进程 saveTask 落盘点**。任务状态推进
 * 全部经 saveTask（编排器正常收尾 / 收尾异常兜底 / 退出钩子 / 启动修正四条路径），
 * 在 session/index.ts 的 saveTask 绑定处落盘后调本函数即覆盖全部 Worker 落定路径，
 * 编排器与修正器本体零改动。落定三态之外的 save（pending / running / accepted /
 * cancelled）不入队——与 taskSettledEventOf 同一判定口径（isTaskSettledStatus）。
 *
 * 去重（合同「同一任务多次 save 不应重复入队」）：兜底路径可能对同一任务连续 save
 * 两次（persistRun 失败后 failTask 再 save），存储层 enqueueSettlementReport 按
 * taskId 替换旧条目，多次入队收敛为一条最新摘要，此处不必感知。
 *
 * 摘要细节的取材：从磁盘读该任务最近一条 Run（attempt / 验证结果 / 报告首行）。
 * 读不到（修正路径 Run 铸造失败 / 落库失败兜底）就拼无 Run 的简版摘要——摘要是
 * 增强不是账本，缺细节不该让落定路径失败。整个入队 catch 兜底：任何失败只记日志，
 * 绝不波及 saveTask 的调用方（落定入队挂在任务落盘的必经之路上）。
 *
 * 红线（T9.10 第一档）：本模块只**写队列**——不触发任何轮次、不 import 编排器。
 */

import { composeSettlementSummary } from "@ff-pane/core";
import type { Run, SettlementReportEntry, Task } from "@ff-pane/shared";
import { isTaskSettledStatus } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";

/** 依赖注入（与编排器 deps 同款纪律，可用假存取单测）。 */
export interface SettlementEnqueueDeps {
  /** 项目全部 Run（取该任务最近一条做摘要细节；读失败视为无 Run）。 */
  readonly listRuns: (layout: ProjectLayout) => Promise<readonly Run[]>;
  /** 入队一条结算摘要（storage enqueueSettlementReport 的绑定）。 */
  readonly enqueue: (layout: ProjectLayout, entry: SettlementReportEntry) => Promise<void>;
  readonly now: () => number;
  /** 开发者日志（英文）；缺省静默。 */
  readonly log?: (message: string) => void;
}

/** 该任务最近一条 Run（listRuns 按文件名序，此处按 startedAt 取最大）。 */
function latestRunOf(runs: readonly Run[], taskId: Task["id"]): Run | undefined {
  let latest: Run | undefined;
  for (const run of runs) {
    if (run.taskId !== taskId) {
      continue;
    }
    if (latest === undefined || run.startedAt > latest.startedAt) {
      latest = run;
    }
  }
  return latest;
}

/**
 * 任务落盘后按状态入队结算摘要：非落定态直接返回 false；落定态拼装摘要写入
 * 项目级待汇报队列，返回 true。失败吞掉只记日志（见模块注释）。
 */
export async function enqueueSettlementIfSettled(
  deps: SettlementEnqueueDeps,
  layout: ProjectLayout,
  task: Task,
): Promise<boolean> {
  if (!isTaskSettledStatus(task.status)) {
    return false;
  }
  const status = task.status;
  try {
    const runs = await deps.listRuns(layout).catch(() => [] as readonly Run[]);
    const run = latestRunOf(runs, task.id);
    const summary = composeSettlementSummary({
      task,
      status,
      ...(run !== undefined ? { run } : {}),
    });
    const entry: SettlementReportEntry = {
      taskId: task.id,
      status,
      summary,
      settledAt: deps.now(),
      ...(run !== undefined ? { runId: run.id } : {}),
    };
    await deps.enqueue(layout, entry);
    return true;
  } catch (thrown) {
    deps.log?.(`[session] settlement enqueue failed for task ${task.id}: ${String(thrown)}`);
    return false;
  }
}
