/**
 * Worker 落定结算摘要（T9.10 ①）：规则拼装的一句话，写入项目级待汇报队列。
 *
 * 第一档**不用模型生成**（合同明文）：摘要的职责是让 Planner / 用户一眼知道
 * 「哪个任务、什么收场、凭什么」，规则拼装完全够——目标 + 状态 + 关键证据
 * （尝试次数 / 验证结果 / 失败原因 / 报告首行）。模型化另立诉求。
 *
 * 纯函数：无 IO、无时钟。入队动作归宿主（saveTask 落盘点旁），本函数只产文本。
 */

import type { Run, Task, TaskSettledStatus } from "@ff-pane/shared";

/** 摘要中任务目标的截断长度（目标可能是一整段话，摘要只要头一截）。 */
export const SUMMARY_GOAL_CHARS = 60;

/** 摘要中报告 / 失败信息的截断长度。 */
export const SUMMARY_DETAIL_CHARS = 120;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 报告首行（多行报告取第一行非空内容作为摘要细节）。 */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** composeSettlementSummary 的入参。 */
export interface SettlementSummaryInput {
  readonly task: Task;
  /** 落定状态（调用方已按 TASK_SETTLED_STATUSES 判定）。 */
  readonly status: TaskSettledStatus;
  /** 本次落定对应的 Run（有则摘要带尝试次数与证据细节）。 */
  readonly run?: Run;
}

/**
 * 拼装一句话结算摘要。三态款式：
 * - done   ：任务 <id>「<goal>」已完成（第 n 次尝试，验证通过/未跑验证）：<报告首行>
 * - failed ：任务 <id>「<goal>」执行失败（第 n 次尝试，<endReason>）：<报告首行>
 * - blocked：任务 <id>「<goal>」被阻塞，等待澄清或权限
 */
export function composeSettlementSummary(input: SettlementSummaryInput): string {
  const { task, status, run } = input;
  const goal = truncate(task.goal, SUMMARY_GOAL_CHARS);
  const head = `任务 ${task.id}「${goal}」`;
  const attempt = run !== undefined ? `第 ${run.attempt} 次尝试` : undefined;

  if (status === "blocked") {
    return `${head}被阻塞，等待澄清或权限`;
  }

  const detail =
    run?.report !== undefined ? truncate(firstLine(run.report), SUMMARY_DETAIL_CHARS) : "";
  const detailSuffix = detail.length > 0 ? `：${detail}` : "";

  if (status === "done") {
    const verify =
      run?.verifyResult !== undefined
        ? run.verifyResult.exitCode === 0
          ? "验证通过"
          : `验证退出码 ${run.verifyResult.exitCode}`
        : "未跑验证";
    const meta = [attempt, verify].filter((part) => part !== undefined).join("，");
    return `${head}已完成（${meta}）${detailSuffix}`;
  }

  // failed：带 Run 的结束原因（crashed / interrupted 与 failed 对任务同义，
  // 但对 Planner 判断「要不要换个思路重派」是有用信息）
  const reason = run?.endReason !== undefined ? `原因 ${run.endReason}` : undefined;
  const meta = [attempt, reason].filter((part) => part !== undefined).join("，");
  return meta.length > 0
    ? `${head}执行失败（${meta}）${detailSuffix}`
    : `${head}执行失败${detailSuffix}`;
}
