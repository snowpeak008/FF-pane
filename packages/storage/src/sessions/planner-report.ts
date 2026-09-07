/**
 * Planner 待汇报状态持久化（T9.10）：`.workbench/planner-report.json` 单文件承载
 * 「Worker 落定结算摘要队列」+「上次 Planner 轮的看板基准」。
 *
 * 落盘形状：整文件 `{ version, baseline?, queue[] }` 原子读写（照 sessions.json 款式）。
 * 队列与基准住同一个文件而不是两个：两者在同一时刻被消费与重建（Planner 轮注入即
 * 「出队 + 换基准」），拆两个文件会引入一个只在崩溃窗口可观察的不一致态。
 *
 * 语义纪律（合同落档取舍见各函数注释）：
 * - **入队去重按 taskId**：同一任务再次落定（重试后又失败 / failed → running → done）
 *   替换旧条目而非追加——Planner 关心的是任务的**当前**收场，两条同任务摘要只会互相矛盾。
 *   同一任务同状态的重复 save（编排器兜底路径可能对同任务 save 多次）天然幂等。
 * - **队列有硬上限**（MAX_QUEUE_ENTRIES）：超限丢最旧——「有上限不膨胀」是合同原文，
 *   最旧的落定在积压到几十条后早已过时（看板增量仍会如实反映其状态）。
 * - **消费 = 注入成功后出队**：编排器在 Planner 轮受理成功、prompt 已定形后才调
 *   consume；受理失败（Profile 缺失 / 并行互斥 / spawn 抛错）不消费，摘要不丢。
 *
 * 损坏处置：JSON 语法损坏由 fs 层隔离（读回 not-found → 空状态，队列重新积累——
 * 汇报是增强不是账本，丢一次可接受）；结构不符同样归一为空状态并由调用方日志留痕，
 * 不抛错挡落定路径（结算入队挂在 saveTask 落盘点，抛错会波及任务落盘的调用方）。
 */

import type {
  PlannerBoardBaseline,
  PlannerReportState,
  SettlementReportEntry,
} from "@ff-pane/shared";
import { isTaskSettledStatus, isTaskStatus } from "@ff-pane/shared";
import type { ProjectLayout } from "../fs/index.js";
import { readJson, writeJsonAtomic } from "../fs/index.js";

/** planner-report.json 的当前格式版本。 */
export const PLANNER_REPORT_FILE_VERSION = 1;

/**
 * 待汇报队列的硬上限（合同「有上限不膨胀」的落盘侧闸门）：入队超限丢最旧。
 * 注入侧另有渲染条数上限（core DEFAULT_REPORT_QUEUE_LIMIT），两道闸各管各的：
 * 这道防文件无界膨胀，那道防提示词膨胀。
 */
export const MAX_QUEUE_ENTRIES = 50;

/** planner-report.json 的整文件结构。 */
interface PlannerReportFile {
  readonly version: typeof PLANNER_REPORT_FILE_VERSION;
  readonly baseline?: PlannerBoardBaseline;
  readonly queue: readonly SettlementReportEntry[];
}

/** 空状态（文件不存在 / 损坏归一的读回值）。 */
const EMPTY_STATE: PlannerReportState = { queue: [] };

/** 一条队列条目的边界校验（用户可直改数据文件，非法条目整文件归零重来）。 */
function isValidEntry(value: unknown): value is SettlementReportEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<SettlementReportEntry>;
  return (
    typeof entry.taskId === "string" &&
    isTaskSettledStatus(entry.status) &&
    typeof entry.summary === "string" &&
    typeof entry.settledAt === "number"
  );
}

/** 基准的边界校验。 */
function isValidBaseline(value: unknown): value is PlannerBoardBaseline {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const baseline = value as Partial<PlannerBoardBaseline>;
  if (typeof baseline.plannerTurnAt !== "number") {
    return false;
  }
  const statuses = baseline.taskStatuses;
  if (typeof statuses !== "object" || statuses === null || Array.isArray(statuses)) {
    return false;
  }
  return Object.values(statuses).every((status) => isTaskStatus(status));
}

/**
 * 读取待汇报状态。文件不存在 / JSON 损坏（fs 层已隔离）/ 结构不符一律归一为空状态
 * （见模块注释「损坏处置」）；结构不符时经 onInvalid 留痕（缺省静默）。
 */
export async function readPlannerReport(
  layout: ProjectLayout,
  onInvalid?: (reason: string) => void,
): Promise<PlannerReportState> {
  const result = await readJson<unknown>(layout.plannerReportFile);
  if (!result.ok) {
    if (result.error.code !== "not-found") {
      onInvalid?.(result.error.message);
    }
    return EMPTY_STATE;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    onInvalid?.("顶层必须是对象");
    return EMPTY_STATE;
  }
  const file = raw as {
    readonly version?: unknown;
    readonly baseline?: unknown;
    readonly queue?: unknown;
  };
  if (file.version !== PLANNER_REPORT_FILE_VERSION || !Array.isArray(file.queue)) {
    onInvalid?.(`version/queue 结构不符：version=${String(file.version)}`);
    return EMPTY_STATE;
  }
  if (!file.queue.every(isValidEntry)) {
    onInvalid?.("queue 含非法条目");
    return EMPTY_STATE;
  }
  const baseline =
    file.baseline !== undefined && isValidBaseline(file.baseline) ? file.baseline : undefined;
  const queue = (file.queue as readonly SettlementReportEntry[]).toSorted(
    (a, b) => a.settledAt - b.settledAt,
  );
  return { ...(baseline !== undefined ? { baseline } : {}), queue };
}

/** 整文件原子写回。 */
async function savePlannerReport(layout: ProjectLayout, state: PlannerReportState): Promise<void> {
  const file: PlannerReportFile = {
    version: PLANNER_REPORT_FILE_VERSION,
    ...(state.baseline !== undefined ? { baseline: state.baseline } : {}),
    queue: state.queue,
  };
  await writeJsonAtomic(layout.plannerReportFile, file);
}

/**
 * 入队一条结算摘要：同 taskId 替换旧条目（去重语义见模块注释），
 * 按 settledAt 升序落位，超上限丢最旧。基准不动。
 */
export async function enqueueSettlementReport(
  layout: ProjectLayout,
  entry: SettlementReportEntry,
): Promise<void> {
  const state = await readPlannerReport(layout);
  const withoutSameTask = state.queue.filter((queued) => queued.taskId !== entry.taskId);
  const merged = [...withoutSameTask, entry].toSorted((a, b) => a.settledAt - b.settledAt);
  const bounded = merged.slice(Math.max(0, merged.length - MAX_QUEUE_ENTRIES));
  await savePlannerReport(layout, { ...state, queue: bounded });
}

/**
 * 消费待汇报状态（Planner 轮**受理成功**后调用）：清空队列 + 以本轮开始时的看板
 * 快照换基准。一次写盘完成两件事——出队与换基准必须同点发生，否则崩溃窗口里
 * 会出现「队列清了基准没换」的漏报或反向的重复汇报。
 */
export async function consumePlannerReport(
  layout: ProjectLayout,
  baseline: PlannerBoardBaseline,
): Promise<void> {
  await savePlannerReport(layout, { baseline, queue: [] });
}
