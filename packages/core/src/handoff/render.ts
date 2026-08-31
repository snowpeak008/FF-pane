/**
 * Handoff 交接包渲染（T7.1，设计文档 §10.4）。
 *
 * 一份文本，两个用途：给用户预览与编辑，以及确认后作为提示词前缀注入新 Agent 会话。
 * **刻意只有一份**——若预览渲染一套、注入再从结构体渲染另一套，用户在预览框里改的每一个字
 * 都会被悄悄丢掉，而"生成后展示给用户预览（可编辑），确认后注入"（§10.4 原文）承诺的正是
 * 他改完的那一份会生效。故编排层注入的是本函数的输出（或用户改过的它），不是 Handoff 结构体。
 *
 * 纯函数：无 IO、无时钟、无随机——同一个交接包恒渲染出同一段文本（可快照）。
 */

import type { Handoff, MemoryEntry, Plan } from "@ff-pane/shared";

/**
 * 交接包文本的首行标题。
 * 明写"跨 Agent 交接"而不是含糊的"上下文"：接手方必须知道自己是**接手**而非**续接**，
 * 否则它会把交接包当成自己的记忆，进而对"我们之前聊过的某某"这类不存在的历史照单全收
 * （§2"不伪装成会话恢复"）。
 */
export const HANDOFF_HEADING = "# 跨 Agent 交接包（工作台生成）";

/** 标题下的一段话：告诉接手方这份文本是什么、边界在哪、该怎么用。 */
const HANDOFF_PREAMBLE = [
  "你正在接手一个已经进行中的项目。以下是工作台登记的全部可交接事实——",
  "**没有**上一个 Agent 的会话记录（会话正文归它自己，工作台从不复制），",
  "也**没有**密钥、原始执行日志与其他项目的任何内容。",
  "凡本文档未写明的历史，一律视为你不知道，不要凭印象补全；需要时直接问用户。",
].join("");

function renderItems(items: readonly string[], emptyText = "（无）"): string[] {
  return items.length === 0 ? [emptyText] : items.map((item) => `- ${item}`);
}

/**
 * 计划正文（§10.4 plan"当前计划版本全文"）。
 * 任务清单不在这里渲染——它由 progress 节带状态列出；同一份任务列两遍，
 * 一遍还是没状态的，只会让接手方分不清哪一份作数。
 */
function renderPlan(plan: Plan): string {
  const lines = [`## 计划 v${plan.version}（${plan.status}）`, "", `目标：${plan.goal}`, ""];
  lines.push("范围：", ...renderItems(plan.scope), "");
  lines.push("非目标：", ...renderItems(plan.nonGoals), "");
  lines.push("约束：", ...renderItems(plan.constraints), "");
  lines.push("已确认的决定：", ...renderItems(plan.decisions), "");
  lines.push("验收：", ...renderItems(plan.acceptance));
  return lines.join("\n");
}

/** 任务清单及状态（§10.4 progress）。状态用领域原值，不翻译成"进行中"之类的近似说法。 */
function renderProgress(progress: Handoff["progress"]): string {
  const lines = [`## 任务进度（共 ${progress.length}）`, ""];
  lines.push(
    ...(progress.length === 0
      ? ["（尚未拆出任务）"]
      : progress.map((item) => `- [${item.status}] ${item.taskId}：${item.goal}`)),
  );
  return lines.join("\n");
}

/** 记忆条目：标题 + 正文。正文不截断——decision/rule 是约束，截断即改变含义。 */
function renderMemory(heading: string, entries: readonly MemoryEntry[]): string {
  const lines = [heading, ""];
  if (entries.length === 0) {
    lines.push("（无）");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`### ${entry.title}`, "", entry.body.trim(), "");
  }
  return lines.join("\n").trimEnd();
}

/**
 * 渲染交接包为可读文本。
 * 八个字段一一成节、顺序与 §10.4 一致，且**空字段照样成节并写明"（无）"**：
 * 一个静默消失的节会让接手方以为"这一项没交接"，而"确实没有"与"忘了给"是两回事。
 */
export function renderHandoff(handoff: Handoff): string {
  const sections = [
    `${HANDOFF_HEADING}\n\n${HANDOFF_PREAMBLE}`,
    `## 项目目标\n\n${handoff.projectGoal.trim().length > 0 ? handoff.projectGoal.trim() : "（工作台侧未登记项目目标。）"}`,
    handoff.plan !== undefined ? renderPlan(handoff.plan) : "## 计划\n\n（尚无计划。）",
    renderProgress(handoff.progress),
    renderMemory("## 已确认的决定（decision）", handoff.decisions),
    renderMemory("## 必须遵守的规则（rule）", handoff.rules),
    renderMemory("## 最近的经验教训（lesson）", handoff.recentLessons),
    `## 阻塞与未决问题\n\n${renderItems(handoff.openIssues).join("\n")}`,
    `## 期望你接下来做什么\n\n${handoff.expectation.trim()}`,
  ];
  return `${sections.join("\n\n").trimEnd()}\n`;
}
