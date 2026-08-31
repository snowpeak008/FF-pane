/**
 * 项目摘要汇总（T7.4，设计文档 §11.1）。
 *
 * 项目卡片上的三项派生信息——当前计划版本与状态 / 进行中任务数 / 最后活动时间——在这里
 * 由计划 · 任务 · Run · 会话登记当场算出。**不持久化**（理由见 contracts.ts 的
 * `ProjectSummary` 注释）。
 *
 * 读取一律经注入的 `ProjectSummarySources`，与 `main/session/orchestrator.ts` 同款：
 * 汇总规则（哪些状态算进行中、时间取哪个、失败怎么降级）由此可以脱离 Electron 与真实
 * 磁盘单测，而不必去起一个应用。
 *
 * 本文件不产出任何面向用户的文案：出错时给的是源码枚举（`ProjectSummaryPart`），
 * 措辞由渲染层按语言包取。
 */

import type { Plan, ProjectRegistryEntry, Run, SessionRecord, Task } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import type {
  ProjectActivitySource,
  ProjectSummary,
  ProjectSummaryPart,
  ProjectSummaryView,
} from "../shared-ipc/contracts";

/**
 * 已收尾的任务状态：不计入「进行中任务数」。
 *
 * 只排除这两个而不是"只数 running"：`running` 仅在一轮 Worker 在飞时为真，闭着应用时
 * 它恒为 0，那样的数字回答不了 §11.1 要项目列表回答的「各自到哪了」。反过来 `done` 要算
 * 进去——§6.3 写明 done ≠ accepted，一个等着用户验收的任务显然还没完事。
 */
const SETTLED_TASK_STATUSES: readonly Task["status"][] = ["accepted", "cancelled"];

/** 汇总所需的四路读取 + 一次目录探测，全部由宿主注入。 */
export interface ProjectSummarySources {
  /** `.workbench/` 是否存在（探测失败一律按不存在处理，见 summarizeProject 注释）。 */
  readonly workbenchPresent: (layout: ProjectLayout) => Promise<boolean>;
  /** 全部计划版本（顺序不限，本模块按 version 自行取最大者）。 */
  readonly listPlans: (layout: ProjectLayout) => Promise<readonly Plan[]>;
  readonly listTasks: (layout: ProjectLayout) => Promise<readonly Task[]>;
  readonly listRuns: (layout: ProjectLayout) => Promise<readonly Run[]>;
  readonly listSessions: (layout: ProjectLayout) => Promise<readonly SessionRecord[]>;
  /** 项目根路径 → 布局（纯路径解析）。 */
  readonly resolveLayout: (projectRootDir: string) => ProjectLayout;
}

/** 数据目录不存在（或整份汇总崩了）时的零值摘要。 */
function emptySummary(unavailable: readonly ProjectSummaryPart[]): ProjectSummary {
  return { workbenchPresent: false, activeTaskCount: 0, taskCount: 0, unavailable };
}

/** 单路读取的结果：拿到值，或这一路不可用。 */
type PartResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * 跑一路读取并把失败吞掉。
 *
 * 吞异常而不是上抛：一个项目的 sessions.json 坏了，用户仍应看得见它的计划版本与任务数，
 * 也仍应看得见**别的项目**（§单文件失败不中断批量）。失败以 `unavailable` 如实上报，
 * 不伪装成"这一路是空的"。
 */
async function readPart<T>(read: () => Promise<T>): Promise<PartResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/** 版本号最大的那份计划即"当前计划"（改计划产出下一版，§11.3）。 */
function pickCurrentPlan(plans: readonly Plan[]): Plan | undefined {
  let current: Plan | undefined;
  for (const plan of plans) {
    if (current === undefined || plan.version > current.version) {
      current = plan;
    }
  }
  return current;
}

/** 一个候选时间点及其出处。 */
interface ActivityCandidate {
  readonly at: number;
  readonly source: ProjectActivitySource;
}

/**
 * 三路时间点里取最晚的一个。
 *
 * 按 plan → run → session 的固定顺序扫描且**严格大于**才替换，故并列时取先扫到的那一路
 * ——并列只会出现在人造数据里，要紧的是同样的磁盘内容永远算出同样的结果。
 */
function pickLastActivity(
  plans: readonly Plan[],
  runs: readonly Run[],
  sessions: readonly SessionRecord[],
): ActivityCandidate | undefined {
  const candidates: ActivityCandidate[] = [];
  for (const plan of plans) {
    // 计划本身不带时间戳，批准是它唯一带时刻的事件（草稿因此不贡献时间点）
    if (plan.approvedBy !== undefined) {
      candidates.push({ at: plan.approvedBy.at, source: "plan" });
    }
  }
  for (const run of runs) {
    // 在飞的 Run 没有 endedAt，用起始时刻；审查发生在收尾之后，故它也是一次活动
    candidates.push({ at: run.endedAt ?? run.startedAt, source: "run" });
    if (run.review !== undefined) {
      candidates.push({ at: run.review.reviewedAt, source: "run" });
    }
  }
  for (const session of sessions) {
    candidates.push({ at: session.lastActiveAt, source: "session" });
  }

  let latest: ActivityCandidate | undefined;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.at)) {
      continue;
    }
    if (latest === undefined || candidate.at > latest.at) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * 汇总单个项目。**不抛错**：任何一路读不到都降级为 `unavailable` 里的一项。
 *
 * `.workbench/` 不存在时直接给零值摘要并短路四路读取——它们只会一路 ENOENT，而
 * "目录不在"这件事本身比四个空列表更有信息量，界面据 `workbenchPresent` 如实标注。
 */
export async function summarizeProject(
  layout: ProjectLayout,
  sources: ProjectSummarySources,
): Promise<ProjectSummary> {
  const present = await readPart(() => sources.workbenchPresent(layout));
  if (!present.ok || !present.value) {
    return emptySummary([]);
  }

  const [plans, tasks, runs, sessions] = await Promise.all([
    readPart(() => sources.listPlans(layout)),
    readPart(() => sources.listTasks(layout)),
    readPart(() => sources.listRuns(layout)),
    readPart(() => sources.listSessions(layout)),
  ]);

  // 顺序固定按 PROJECT_SUMMARY_PARTS 排，不随并发完成先后变化
  const unavailable: ProjectSummaryPart[] = [];
  if (!plans.ok) {
    unavailable.push("plan");
  }
  if (!tasks.ok) {
    unavailable.push("task");
  }
  if (!runs.ok) {
    unavailable.push("run");
  }
  if (!sessions.ok) {
    unavailable.push("session");
  }

  const planList = plans.ok ? plans.value : [];
  const taskList = tasks.ok ? tasks.value : [];
  const runList = runs.ok ? runs.value : [];
  const sessionList = sessions.ok ? sessions.value : [];

  const currentPlan = pickCurrentPlan(planList);
  const activity = pickLastActivity(planList, runList, sessionList);
  const activeTaskCount = taskList.filter(
    (task) => !SETTLED_TASK_STATUSES.includes(task.status),
  ).length;

  return {
    workbenchPresent: true,
    ...(currentPlan !== undefined
      ? { planVersion: currentPlan.version, planStatus: currentPlan.status }
      : {}),
    activeTaskCount,
    taskCount: taskList.length,
    ...(activity !== undefined
      ? { lastActivityAt: activity.at, lastActivitySource: activity.source }
      : {}),
    unavailable,
  };
}

/**
 * 汇总整份注册表。
 *
 * 逐项目独立 try：一个项目的路径解析或汇总整体崩掉（坏盘、路径非法），其余项目照常出结果
 * ——项目列表是用户找回工作现场的入口，它不该因为其中一个项目出事就整页红。崩掉的那个
 * 项目四路全标 `unavailable`，卡片如实显示读不到，而不是显示成空项目。
 */
export async function summarizeProjects(
  entries: readonly ProjectRegistryEntry[],
  sources: ProjectSummarySources,
): Promise<readonly ProjectSummaryView[]> {
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const layout = sources.resolveLayout(entry.rootPath);
        return { entry, summary: await summarizeProject(layout, sources) };
      } catch {
        return { entry, summary: emptySummary(["plan", "task", "run", "session"]) };
      }
    }),
  );
}
