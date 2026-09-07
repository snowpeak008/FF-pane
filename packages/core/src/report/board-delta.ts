/**
 * 任务看板增量组装（T9.10 ②）：Planner 轮开始时注入的「自上次 Planner 轮以来」
 * 战况文本 = 待汇报结算摘要队列 + 看板状态 diff。
 *
 * 款式照 resume/rebuild.ts「最近对话摘录」小节：固定标题 + `- ` 列表行 + 超限截断
 * 带「（已截断）」标注。**有上限不膨胀**（合同原文）：队列条数、增量行数、单行字符
 * 三个上限各自兜底，注入体积与积压规模解耦。
 *
 * 增量语义：与基准快照（上次 Planner 轮开始时的 taskId → status 映射）diff——
 * 新增 / 状态变化 / 移除三类。首次注入（无基准）不假装有增量：给一行当前看板
 * 计数概览，从本轮起建立基准。
 *
 * 纯函数：无 IO、无时钟。读队列 / 存基准归 storage，接线归编排器。
 */

import type {
  PlannerBoardBaseline,
  SettlementReportEntry,
  Task,
  TaskStatus,
} from "@ff-pane/shared";
import { TASK_STATUSES } from "@ff-pane/shared";

/** 注入文本的节标题（提示词内可见，单测与排障据此定位）。 */
export const REPORT_CONTEXT_HEADING = "# 任务看板增量（自上次 Planner 轮以来，工作台注入）";

/** 待汇报小节标题。 */
export const REPORT_QUEUE_HEADING = "## 待汇报结算摘要";

/** 看板变化小节标题。 */
export const REPORT_DELTA_HEADING = "## 看板变化";

/** 待汇报摘要默认取样条数（取最近的；更早的落定由看板变化行兜住）。 */
export const DEFAULT_REPORT_QUEUE_LIMIT = 10;

/** 看板变化默认行数上限。 */
export const DEFAULT_BOARD_DELTA_LIMIT = 20;

/** 单行默认截断字符数（摘要拼装时已截断，这里防手改落盘文件的超长行）。 */
export const DEFAULT_REPORT_LINE_CHARS = 200;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed;
}

/** 看板 diff 的一行（新增 / 状态变化 / 移除）。 */
export interface BoardDeltaLine {
  readonly taskId: string;
  readonly kind: "added" | "status-changed" | "removed";
  /** 变化前状态（added 缺席）。 */
  readonly from?: TaskStatus;
  /** 变化后状态（removed 缺席）。 */
  readonly to?: TaskStatus;
  /** 任务目标（removed 时基准里没有存目标，缺席）。 */
  readonly goal?: string;
}

/**
 * 与基准快照 diff 出看板变化（确定性顺序：按 taskId 升序）。
 * 状态未变的任务不产行——增量的意义就是不重复 Planner 已知的事实。
 */
export function computeBoardDelta(
  baseline: PlannerBoardBaseline,
  tasks: readonly Task[],
): readonly BoardDeltaLine[] {
  const lines: BoardDeltaLine[] = [];
  const currentIds = new Set<string>();
  for (const task of [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    currentIds.add(task.id);
    const before = baseline.taskStatuses[task.id];
    if (before === undefined) {
      lines.push({ taskId: task.id, kind: "added", to: task.status, goal: task.goal });
    } else if (before !== task.status) {
      lines.push({
        taskId: task.id,
        kind: "status-changed",
        from: before,
        to: task.status,
        goal: task.goal,
      });
    }
  }
  for (const taskId of Object.keys(baseline.taskStatuses).sort()) {
    if (!currentIds.has(taskId)) {
      const from = baseline.taskStatuses[taskId];
      lines.push({ taskId, kind: "removed", ...(from !== undefined ? { from } : {}) });
    }
  }
  return lines;
}

/** 从当前任务列表建立新基准的快照映射（编排器消费队列时用）。 */
export function boardSnapshotOf(tasks: readonly Task[]): Readonly<Record<string, TaskStatus>> {
  return Object.fromEntries(tasks.map((task) => [task.id, task.status]));
}

/** assembleBoardDelta 的入参。 */
export interface BoardDeltaInput {
  /** 待汇报队列（storage 读回，按 settledAt 升序）。 */
  readonly queue: readonly SettlementReportEntry[];
  /** 项目当前全部任务。 */
  readonly tasks: readonly Task[];
  /** 上次 Planner 轮的看板基准；缺席 = 首次注入（给计数概览，不假装有增量）。 */
  readonly baseline?: PlannerBoardBaseline;
  /** 待汇报摘要取样条数上限（缺省 DEFAULT_REPORT_QUEUE_LIMIT）。 */
  readonly maxQueueEntries?: number;
  /** 看板变化行数上限（缺省 DEFAULT_BOARD_DELTA_LIMIT）。 */
  readonly maxDeltaLines?: number;
  /** 单行截断字符数（缺省 DEFAULT_REPORT_LINE_CHARS）。 */
  readonly maxLineChars?: number;
}

function renderQueue(
  queue: readonly SettlementReportEntry[],
  maxEntries: number,
  maxChars: number,
): string {
  // 取末尾（最近的）maxEntries 条：更早的落定其状态仍会在看板变化里出现
  const recent = queue.slice(Math.max(0, queue.length - maxEntries));
  const lines = [`${REPORT_QUEUE_HEADING}（${recent.length}/${queue.length}）`];
  for (const entry of recent) {
    lines.push(`- ${truncate(entry.summary, maxChars)}`);
  }
  return lines.join("\n");
}

function renderDeltaLine(line: BoardDeltaLine, maxChars: number): string {
  const goal = line.goal !== undefined ? `：${line.goal}` : "";
  switch (line.kind) {
    case "added":
      return truncate(`- 新增 ${line.taskId}（${line.to}）${goal}`, maxChars);
    case "status-changed":
      return truncate(`- ${line.taskId}：${line.from} → ${line.to}${goal}`, maxChars);
    case "removed":
      return truncate(
        `- 移除 ${line.taskId}${line.from !== undefined ? `（原 ${line.from}）` : ""}`,
        maxChars,
      );
  }
}

/** 首次注入（无基准）的看板计数概览：一行有界文本，非空状态才列出。 */
function renderBoardOverview(tasks: readonly Task[]): string {
  const counts = TASK_STATUSES.map((status) => {
    const count = tasks.filter((task) => task.status === status).length;
    return count > 0 ? `${status} ${count}` : undefined;
  }).filter((part) => part !== undefined);
  return `${REPORT_DELTA_HEADING}\n- 首次注入（尚无基准）：当前看板共 ${tasks.length} 个任务${
    counts.length > 0 ? `（${counts.join("，")}）` : ""
  }`;
}

/**
 * 组装注入文本。队列为空且看板无变化（或首次注入且看板为空）时返回 undefined——
 * 没战况就不占提示词，一个恒在的空节只会稀释当前输入。
 */
export function assembleBoardDelta(input: BoardDeltaInput): string | undefined {
  const maxQueueEntries = input.maxQueueEntries ?? DEFAULT_REPORT_QUEUE_LIMIT;
  const maxDeltaLines = input.maxDeltaLines ?? DEFAULT_BOARD_DELTA_LIMIT;
  const maxLineChars = input.maxLineChars ?? DEFAULT_REPORT_LINE_CHARS;

  const sections: string[] = [];
  if (input.queue.length > 0) {
    sections.push(renderQueue(input.queue, maxQueueEntries, maxLineChars));
  }

  if (input.baseline === undefined) {
    if (input.tasks.length > 0) {
      sections.push(renderBoardOverview(input.tasks));
    }
  } else {
    const delta = computeBoardDelta(input.baseline, input.tasks);
    if (delta.length > 0) {
      const shown = delta.slice(0, maxDeltaLines);
      const lines = [`${REPORT_DELTA_HEADING}（${shown.length}/${delta.length}）`];
      for (const line of shown) {
        lines.push(renderDeltaLine(line, maxLineChars));
      }
      sections.push(lines.join("\n"));
    }
  }

  if (sections.length === 0) {
    return undefined;
  }
  return [REPORT_CONTEXT_HEADING, ...sections].join("\n\n");
}
