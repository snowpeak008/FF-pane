/**
 * 上下文重建文本组装（T4.3，设计文档 §10.3）。
 *
 * 场景：Runtime 不支持原生会话恢复（或原生绑定 cwd 不匹配）时，工作台不能续接
 * Agent 自己的会话记录（Agent 的会话文件归 Agent，§10.2 规则 3）。此时用工作台
 * **确有登记的事实**——当前计划、任务状态、state.md 快照、最近 Run 报告，以及
 * T8.2b 起的对话回放本最近几条（用户提示词 / assistant 文本）——重建一段上下文文本，
 * 注入新会话的提示词，让换进程/重启后的 Agent 恢复工作认知。
 *
 * 纯函数：无 IO、无时钟。输入由编排层从 storage 读齐后传入，输出直接前置到提示词。
 * 刻意精简：只放"接续工作所需的最小事实"，不堆砌全文——过长上下文既费 token 又稀释
 * 当前输入（与 T4.1 注入条数上限同理）。Run 报告与对话摘录默认只取最近若干条。
 */

import type { Plan, Run, Task, TranscriptEntry } from "@ff-pane/shared";

/** assembleRebuildContext 的入参（全部可缺省，缺省即该维度无可重建事实）。 */
export interface RebuildContextInput {
  /** 当前计划（通常取最新版本）。缺省 = 尚无计划。 */
  readonly plan?: Plan;
  /** 项目任务（全量；本函数按状态归纳，不在意顺序）。 */
  readonly tasks?: readonly Task[];
  /** memory/state.md 当前状态快照正文。缺省 = 尚无快照。 */
  readonly stateSnapshot?: string;
  /** 执行记录（全量或已截断；本函数取末尾 maxRuns 条渲染）。 */
  readonly recentRuns?: readonly Run[];
  /** 最近 Run 取样条数上限（缺省 DEFAULT_RECENT_RUNS）。 */
  readonly maxRuns?: number;
  /** 单条 Run 报告截断字符数（缺省 DEFAULT_REPORT_CHARS）。 */
  readonly maxReportChars?: number;
  /**
   * 该会话的对话回放本（T8.2b；全量或已截断，按时间升序）。本函数只取其中的
   * user_message / assistant_message 末尾 maxTranscriptEntries 条渲染；turn_end 元数据
   * 不进提示词（Agent 不需要知道每轮怎么结束的，它需要的是"聊到哪了"）。
   */
  readonly recentTranscript?: readonly TranscriptEntry[];
  /** 对话摘录取样条数上限（缺省 DEFAULT_TRANSCRIPT_ENTRIES）。 */
  readonly maxTranscriptEntries?: number;
  /** 单条对话摘录截断字符数（缺省 DEFAULT_TRANSCRIPT_CHARS）。 */
  readonly maxTranscriptChars?: number;
}

/** 最近 Run 报告默认取样条数。 */
export const DEFAULT_RECENT_RUNS = 3;

/** 单条 Run 报告默认截断字符数。 */
export const DEFAULT_REPORT_CHARS = 400;

/** 对话摘录默认取样条数（用户 / 助手条目合计）。 */
export const DEFAULT_TRANSCRIPT_ENTRIES = 6;

/** 单条对话摘录默认截断字符数。 */
export const DEFAULT_TRANSCRIPT_CHARS = 600;

/** 上下文重建文本的节标题（提示词内可见，便于 Agent 与用户识别恢复来源）。 */
export const REBUILD_CONTEXT_HEADING = "# 会话恢复上下文（工作台重建）";

/** 对话摘录小节的标题（单测与排障据此定位）。 */
export const REBUILD_TRANSCRIPT_HEADING = "## 最近对话摘录";

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed;
}

function renderPlan(plan: Plan): string {
  const lines = [`## 当前计划 v${plan.version}（${plan.status}）`, `目标：${plan.goal}`];
  if (plan.constraints.length > 0) {
    lines.push(`约束：${plan.constraints.join("；")}`);
  }
  return lines.join("\n");
}

/** 按状态归纳任务：给出每个状态的计数 + 逐条「id：目标（状态）」，供 Agent 掌握全局进度。 */
function renderTasks(tasks: readonly Task[]): string {
  const lines = [`## 任务（共 ${tasks.length}）`];
  for (const task of tasks) {
    lines.push(`- ${task.id}：${task.goal}（${task.status}）`);
  }
  return lines.join("\n");
}

function renderState(snapshot: string): string {
  return `## 当前状态（state.md）\n${snapshot.trim()}`;
}

function renderRuns(runs: readonly Run[], maxRuns: number, maxReportChars: number): string {
  // 取末尾 maxRuns 条（listRuns 按 startedAt 升序，末尾即最近）
  const recent = runs.slice(Math.max(0, runs.length - maxRuns));
  const lines = [`## 最近执行记录（${recent.length}/${runs.length}）`];
  for (const run of recent) {
    const reason = run.endReason ?? "进行中";
    const head = `- Run ${run.id}（任务 ${run.taskId}，第 ${run.attempt} 次，${reason}）`;
    const report = run.report !== undefined ? run.report.trim() : "";
    lines.push(report.length > 0 ? `${head}\n  报告：${truncate(report, maxReportChars)}` : head);
  }
  return lines.join("\n");
}

/** 对话回放本里进提示词的两类条目（turn_end 元数据不进）。 */
type TranscriptMessage = Extract<
  TranscriptEntry,
  { readonly kind: "user_message" | "assistant_message" }
>;

function isTranscriptMessage(entry: TranscriptEntry): entry is TranscriptMessage {
  return entry.kind === "user_message" || entry.kind === "assistant_message";
}

/**
 * 最近对话摘录：用户 / 助手交替，取末尾 maxEntries 条（末尾即最近），超长逐条截断。
 * 被中断的部分答复如实标注——Agent 该知道它上次没说完，而不是把半句话当成结论。
 */
function renderTranscript(
  entries: readonly TranscriptEntry[],
  maxEntries: number,
  maxChars: number,
): string | undefined {
  const messages = entries.filter(isTranscriptMessage).filter((m) => m.text.trim().length > 0);
  if (messages.length === 0) {
    return undefined;
  }
  const recent = messages.slice(Math.max(0, messages.length - maxEntries));
  const lines = [`${REBUILD_TRANSCRIPT_HEADING}（${recent.length}/${messages.length}）`];
  for (const message of recent) {
    const speaker = message.kind === "user_message" ? "用户" : "助手";
    const suffix =
      message.kind === "assistant_message" && message.partial === true ? "（被中断，不完整）" : "";
    lines.push(`- ${speaker}${suffix}：${truncate(message.text, maxChars)}`);
  }
  return lines.join("\n");
}

/**
 * 组装上下文重建文本。各维度有事实才渲染其节；全空时只返回标题 + 一句"无登记事实"
 * （仍是有效上下文：明确告知 Agent 工作台侧尚无可重建的历史，避免其臆造进度）。
 * 节的顺序固定为 计划 → 任务 → 状态 → 最近执行记录 → 最近对话摘录：前四节是"工作
 * 台登记的事实"，对话摘录放最末、紧挨着本轮的新输入，是"聊到哪了"的直接上文。
 */
export function assembleRebuildContext(input: RebuildContextInput): string {
  const maxRuns = input.maxRuns ?? DEFAULT_RECENT_RUNS;
  const maxReportChars = input.maxReportChars ?? DEFAULT_REPORT_CHARS;
  const maxTranscriptEntries = input.maxTranscriptEntries ?? DEFAULT_TRANSCRIPT_ENTRIES;
  const maxTranscriptChars = input.maxTranscriptChars ?? DEFAULT_TRANSCRIPT_CHARS;
  const tasks = input.tasks ?? [];
  const runs = input.recentRuns ?? [];
  const transcript = input.recentTranscript ?? [];
  const stateSnapshot = input.stateSnapshot?.trim();

  const sections: string[] = [REBUILD_CONTEXT_HEADING];
  const body: string[] = [];
  if (input.plan !== undefined) {
    body.push(renderPlan(input.plan));
  }
  if (tasks.length > 0) {
    body.push(renderTasks(tasks));
  }
  if (stateSnapshot !== undefined && stateSnapshot.length > 0) {
    body.push(renderState(stateSnapshot));
  }
  if (runs.length > 0) {
    body.push(renderRuns(runs, maxRuns, maxReportChars));
  }
  const transcriptSection = renderTranscript(transcript, maxTranscriptEntries, maxTranscriptChars);
  if (transcriptSection !== undefined) {
    body.push(transcriptSection);
  }

  sections.push(
    body.length > 0
      ? body.join("\n\n")
      : "（工作台侧暂无可重建的计划/任务/状态/执行记录/对话摘录。）",
  );
  return sections.join("\n\n");
}
