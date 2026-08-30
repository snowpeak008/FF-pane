/**
 * 记忆候选派生（T4.4，设计文档 §8.1）。
 *
 * 闭环起点：任务进入 accepted 时，系统从「任务沉淀」派生记忆候选（§8.1 来源之一：
 * task_<id>）。规则红线（§8.1）：Agent / 系统只能产生 candidate，写入 active 的唯一
 * 途径是用户在界面上点通过——故本函数产出的一律是 status="candidate"、confidence="low"
 * 的待审条目，用户在记忆页审核（通过 / 编辑后通过 / 拒绝）后才进入注入池生效。
 *
 * M1 的派生源是已验收任务的最近一次 Run 报告（Agent 对本任务做了什么的自述）：把它
 * 沉淀为一条 lesson 候选，标题取任务目标，正文取报告（截断）。无 Run 报告则不产出
 * （N=0 是正常结果，不造空候选）。纯函数：无 IO、无时钟，now 与 id 生成注入。
 */

import type { EpochMillis, MemoryEntry, MemoryEntryId, Run, Task } from "@ff-pane/shared";

/** deriveAcceptanceCandidates 的入参（存取与时钟由宿主注入）。 */
export interface AcceptanceCandidateInput {
  /** 刚进入 accepted 的任务。 */
  readonly task: Task;
  /** 项目全部 Run（本函数按 taskId 过滤取最近一条有报告者）。 */
  readonly runs: readonly Run[];
  /** 当前时间（epoch 毫秒）。 */
  readonly now: EpochMillis;
  /** 生成一个新的记忆条目 ID。 */
  readonly newId: () => MemoryEntryId;
  /** 正文截断字符数（缺省 DEFAULT_CANDIDATE_BODY_CHARS）。 */
  readonly maxBodyChars?: number;
}

/** 候选正文默认截断字符数（§8.1 建议正文 200 字内，留余量便于用户编辑收敛）。 */
export const DEFAULT_CANDIDATE_BODY_CHARS = 400;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 取某任务最近一次「有报告」的 Run：按 attempt→startedAt 取大者（listRuns 已升序，取末尾）。 */
function latestReportedRun(runs: readonly Run[], taskId: Task["id"]): Run | undefined {
  let best: Run | undefined;
  for (const run of runs) {
    if (run.taskId !== taskId) {
      continue;
    }
    const report = run.report?.trim() ?? "";
    if (report.length === 0) {
      continue;
    }
    if (
      best === undefined ||
      run.attempt > best.attempt ||
      (run.attempt === best.attempt && run.startedAt >= best.startedAt)
    ) {
      best = run;
    }
  }
  return best;
}

/**
 * 从已验收任务派生记忆候选。当前策略：最近一次有报告的 Run → 一条 lesson 候选；
 * 无此 Run 则返回空数组（N=0）。返回的条目已成型（含 id / 时间戳），调用方直接落库。
 */
export function deriveAcceptanceCandidates(
  input: AcceptanceCandidateInput,
): readonly MemoryEntry[] {
  const run = latestReportedRun(input.runs, input.task.id);
  if (run === undefined) {
    return [];
  }
  const maxBody = input.maxBodyChars ?? DEFAULT_CANDIDATE_BODY_CHARS;
  const candidate: MemoryEntry = {
    id: input.newId(),
    category: "lesson",
    title: truncate(input.task.goal, 120),
    body: truncate(run.report ?? "", maxBody),
    status: "candidate",
    source: { kind: "task", taskId: input.task.id },
    confidence: "low",
    createdAt: input.now,
    updatedAt: input.now,
  };
  return [candidate];
}
