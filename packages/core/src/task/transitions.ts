/**
 * 任务状态合法迁移表（W1.4b，设计文档 §6.3 / §11.4）。
 * 数据形式导出：storage 校验、UI 按钮可用性、测试矩阵共用同一份事实来源。
 */

import type { TaskStatus } from "@ff-pane/shared";

/**
 * 合法迁移表：键为当前状态，值为允许迁入的目标状态集合。
 *
 * 边界取舍（W1.4b 设计决策）：
 * - 无 running→pending：pending 专指"已批准、从未派发"（§6.3）。执行一旦开始，
 *   回退语义由 failed（保留任务、可重试）或 cancelled（放弃任务）表达，
 *   不伪造"未派发"假象——历史 Run 已经存在，归属必须清晰。
 * - 无 blocked→failed / blocked→done：blocked 只是等待答复（澄清 §6.5 / 权限 §7），
 *   答复无论批准还是拒绝都先回 running（Run 仍在飞），失败或完成必须由执行结果驱动。
 * - 无 failed→done：失败后必须经重试（dispatchTask 产生派发、startRun 铸造新 Run，
 *   §6.3）再走 completeTask 的证据校验，不允许把失败直接改写成完成。
 * - done→running 仅表示用户要求返工（reworkTask）；done→accepted 仅限用户验收
 *   （acceptTask），done ≠ accepted 是产品核心原则（§6.3）。
 * - accepted / cancelled 为终态零出边（§6.3 明确标注）：验收即封存、取消不可复活；
 *   同一目标重新来过属于新任务。
 * - 全部自环非法：幂等重放（重复派发、重复取消）由调用方先查状态规避，
 *   状态机不静默吞并，避免掩盖调用方的时序 bug。
 */
export const TASK_TRANSITION_TABLE: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["running", "cancelled"],
  running: ["blocked", "failed", "done", "cancelled"],
  blocked: ["running", "cancelled"],
  failed: ["running", "cancelled"],
  done: ["accepted", "running", "cancelled"],
  accepted: [],
  cancelled: [],
};

/** 判断 from→to 是否为合法迁移（表驱动，终态与自环自然落在否定侧）。 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITION_TABLE[from].includes(to);
}
