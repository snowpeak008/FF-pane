/**
 * 启动修正（T8.2b）：把上次工作台退出 / 崩溃时没来得及收尾的轮次补齐。
 *
 * 证据是 `sessions/inflight/<turnId>.json`：轮开始时写、正常收尾（或退出钩子）时删，
 * 残留即"被中断"。对每个残留标记：
 * - Worker 轮且任务仍 running → 补一条 Run(interrupted，report 为抢救的部分文本)，任务
 *   running → failed（可重试）；任务已不是 running（用户在别处改过 / 退出钩子已处理但标记
 *   没删掉）→ 不碰任务、只记日志；
 * - 所有轮 → 回放本补 `assistant_message{partial}`（有部分文本才写）+ `turn_end{interrupted}`；
 * - 删标记与部分文本。
 *
 * 幂等：标记删了就不会再修第二次；本进程仍在飞的轮（标记是它自己刚写的）按 isTurnActive
 * 跳过。单个标记失败不阻断其余，全部失败进 report 由调用方记日志——修正是启动路径上的
 * 后台整理，绝不能让它把窗口挡住。
 *
 * 依赖全注入（与编排器同款），可在 node 环境用假存取单测。
 */

import { failTask } from "@ff-pane/core";
import type {
  InflightTurnMarker,
  LocalSessionId,
  Run,
  RunId,
  Task,
  TaskId,
  TranscriptEntry,
} from "@ff-pane/shared";
import type { InflightMarkersListing, ProjectLayout } from "@ff-pane/storage";
import { buildInterruptedRun } from "./interrupted";

/** 修正所需的存取依赖。 */
export interface RepairDeps {
  readonly listInflightMarkers: (layout: ProjectLayout) => Promise<InflightMarkersListing>;
  readonly readInflightPartial: (
    layout: ProjectLayout,
    turnId: string,
  ) => Promise<string | undefined>;
  readonly deleteInflightMarker: (layout: ProjectLayout, turnId: string) => Promise<unknown>;
  readonly appendTranscript: (
    layout: ProjectLayout,
    sessionId: LocalSessionId,
    entry: TranscriptEntry,
  ) => Promise<void>;
  readonly loadTask: (layout: ProjectLayout, id: TaskId) => Promise<Task | undefined>;
  readonly saveTask: (layout: ProjectLayout, task: Task) => Promise<void>;
  readonly listRuns: (layout: ProjectLayout) => Promise<readonly Run[]>;
  readonly persistRun: (
    layout: ProjectLayout,
    run: Run,
    rawLog: string,
    changesDiff: string,
  ) => Promise<void>;
  readonly now: () => number;
  readonly newRunId: () => RunId;
  /** 本进程仍在飞的轮（标记是活的，不是残留）。缺省 = 没有在飞轮。 */
  readonly isTurnActive?: (turnId: string) => boolean;
  /** 开发者日志（英文）。 */
  readonly log?: (message: string) => void;
}

/** 单个标记的处置结果。 */
export type RepairAction =
  /** Worker 轮：补了 Run(interrupted) 并把任务 running → failed。 */
  | "run-and-task"
  /** Worker 轮：Run 铸不出来（如 core 拒绝），但任务已拉回 failed。 */
  | "task-only"
  /** Worker 轮：任务已不是 running，未动任务。 */
  | "task-already-settled"
  /**
   * Worker 轮：铸 Run 失败后连 failTask 落盘也失败——任务可能仍停在 running。
   * 与 task-already-settled 语义相反（那是「无需动任务」，这是「动不了任务」），
   * 单列取值让诊断者按字面即可判断现场（错误详情在 issues / 日志）。
   */
  | "task-save-failed"
  /** Worker 轮：任务记录不存在。 */
  | "task-missing"
  /** Planner / 审查轮：只补回放本。 */
  | "transcript-only";

/** 一个被修正的轮次。 */
export interface RepairedTurn {
  readonly turnId: string;
  readonly role: InflightTurnMarker["role"];
  readonly action: RepairAction;
  readonly runId?: RunId;
}

/** repairInterruptedTurns 的回报。 */
export interface RepairReport {
  readonly repaired: readonly RepairedTurn[];
  /** 因本进程仍在飞而跳过的 turnId。 */
  readonly skippedActive: readonly string[];
  /** 读不出来 / 处置中出错的标记（路径或 turnId + 原因）。 */
  readonly issues: readonly { readonly ref: string; readonly message: string }[];
}

async function attempt(
  issues: { ref: string; message: string }[],
  ref: string,
  work: () => Promise<void>,
): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (thrown) {
    issues.push({ ref, message: thrown instanceof Error ? thrown.message : String(thrown) });
    return false;
  }
}

/** 扫一个项目的残留标记并逐个修正。 */
export async function repairInterruptedTurns(
  layout: ProjectLayout,
  deps: RepairDeps,
): Promise<RepairReport> {
  const log = deps.log ?? (() => undefined);
  const isTurnActive = deps.isTurnActive ?? (() => false);
  const listing = await deps.listInflightMarkers(layout);
  const issues: { ref: string; message: string }[] = listing.issues.map((issue) => ({
    ref: issue.path,
    message: issue.message,
  }));
  const repaired: RepairedTurn[] = [];
  const skippedActive: string[] = [];

  for (const marker of listing.markers) {
    if (isTurnActive(marker.turnId)) {
      skippedActive.push(marker.turnId);
      continue;
    }
    const partial = await deps.readInflightPartial(layout, marker.turnId).catch((thrown) => {
      issues.push({ ref: marker.turnId, message: `partial unreadable: ${String(thrown)}` });
      return undefined;
    });
    const partialText = partial ?? "";

    let action: RepairAction = "transcript-only";
    let runId: RunId | undefined = marker.role === "reviewer" ? marker.runId : undefined;
    const taskId = marker.taskId;

    if (marker.role === "worker" && taskId !== undefined) {
      const task = await deps.loadTask(layout, taskId).catch(() => undefined);
      if (task === undefined) {
        action = "task-missing";
        log(`[repair] turn ${marker.turnId}: task ${taskId} not found; transcript only`);
      } else if (task.status !== "running") {
        action = "task-already-settled";
        log(`[repair] turn ${marker.turnId}: task ${taskId} already ${task.status}; left as is`);
      } else {
        const newRunId = deps.newRunId();
        const ok = await attempt(issues, marker.turnId, async () => {
          const existingRuns = await deps.listRuns(layout);
          const outcome = buildInterruptedRun({
            task,
            runId: newRunId,
            profileId: marker.profileId,
            startedAt: marker.startedAt,
            endedAt: deps.now(),
            existingRuns,
            partialReport: partialText,
          });
          await deps.persistRun(layout, outcome.run, partialText, "");
          await deps.saveTask(layout, outcome.task);
        });
        if (ok) {
          action = "run-and-task";
          runId = newRunId;
        } else {
          // core 拒绝铸 Run（如磁盘上已有一条在飞 Run）或落盘失败：至少把任务拉回 failed
          const settled = await attempt(issues, marker.turnId, () =>
            deps.saveTask(layout, failTask(task)),
          );
          action = settled ? "task-only" : "task-save-failed";
          if (!settled) {
            log(`[repair] turn ${marker.turnId}: could not fail task ${taskId}`);
          }
        }
      }
    }

    const at = deps.now();
    if (partialText.trim().length > 0) {
      await attempt(issues, marker.turnId, () =>
        deps.appendTranscript(layout, marker.sessionId, {
          kind: "assistant_message",
          turnId: marker.turnId,
          at,
          text: partialText,
          partial: true,
        }),
      );
    }
    await attempt(issues, marker.turnId, () =>
      deps.appendTranscript(layout, marker.sessionId, {
        kind: "turn_end",
        turnId: marker.turnId,
        at,
        role: marker.role,
        profileId: marker.profileId,
        ...(marker.resumeKind !== undefined ? { resumeKind: marker.resumeKind } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        endReason: "interrupted",
      }),
    );
    await attempt(issues, marker.turnId, async () => {
      await deps.deleteInflightMarker(layout, marker.turnId);
    });

    repaired.push({
      turnId: marker.turnId,
      role: marker.role,
      action,
      ...(runId !== undefined ? { runId } : {}),
    });
    log(`[repair] turn ${marker.turnId} (${marker.role}) repaired: ${action}`);
  }

  return { repaired, skippedActive, issues };
}

/**
 * 按项目根去重的修正入口：同一项目在本进程生命周期内只扫一次（标记删了本就不会再有，
 * 去重只是省掉每次触碰都读一遍目录）；并发触碰共享同一个 promise；失败则丢掉记忆，
 * 下次触碰重试。
 */
export interface ProjectRepairer {
  ensureRepaired(layout: ProjectLayout): Promise<RepairReport | undefined>;
}

export function createProjectRepairer(deps: RepairDeps): ProjectRepairer {
  const inProgress = new Map<string, Promise<RepairReport | undefined>>();
  const done = new Set<string>();
  const log = deps.log ?? (() => undefined);

  return {
    ensureRepaired(layout) {
      const key = layout.projectRootDir;
      if (done.has(key)) {
        return Promise.resolve(undefined);
      }
      const existing = inProgress.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const run = repairInterruptedTurns(layout, deps)
        .then((report) => {
          done.add(key);
          if (report.repaired.length > 0 || report.issues.length > 0) {
            log(
              `[repair] ${key}: repaired ${report.repaired.length}, skipped ${report.skippedActive.length}, issues ${report.issues.length}`,
            );
          }
          return report;
        })
        .catch((thrown: unknown) => {
          log(`[repair] ${key}: scan failed: ${String(thrown)}`);
          return undefined;
        })
        .finally(() => {
          inProgress.delete(key);
        });
      inProgress.set(key, run);
      return run;
    },
  };
}
