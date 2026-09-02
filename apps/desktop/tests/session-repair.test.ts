/**
 * T8.2b 启动修正单测：对残留的在飞标记做修正。三种标记各一（Planner / Worker 且任务
 * running / Worker 但任务已 failed）+ 审查轮 + 本进程在飞跳过 + 幂等 + 坏标记不阻断。
 * 走 mkdtemp 临时目录 + 真实 storage 函数，修正模块的依赖绑定与 session/index.ts 同形。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InflightTurnMarker,
  LocalSessionId,
  ProfileId,
  Run,
  RunId,
  Task,
  TaskId,
} from "@ff-pane/shared";
import {
  appendTranscriptEntry,
  deleteInflightMarker,
  initProjectLayout,
  listInflightMarkers,
  listRuns,
  loadTask,
  type ProjectLayout,
  readInflightPartial,
  readTranscript,
  resolveInflightPaths,
  saveRun,
  saveTask,
  writeInflightMarker,
  writeInflightPartial,
  writeJsonAtomic,
  writeRunChangesDiff,
  writeRunRawLog,
} from "@ff-pane/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectRepairer,
  type RepairDeps,
  repairInterruptedTurns,
} from "../src/main/session/repair";

let tempRoot: string;
let layout: ProjectLayout;
const SESSION = "sess-1" as LocalSessionId;
const PROFILE = "prof-1" as ProfileId;
const NOW = 5_000;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-repair-"));
  layout = await initProjectLayout(tempRoot);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function realDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  let seq = 0;
  return {
    listInflightMarkers,
    readInflightPartial,
    deleteInflightMarker,
    appendTranscript: appendTranscriptEntry,
    loadTask: async (l, id) => {
      const loaded = await loadTask(l, id);
      return loaded.ok ? loaded.value : undefined;
    },
    saveTask: async (l, task) => {
      await saveTask(l, task);
    },
    listRuns: async (l) => {
      const result = await listRuns(l);
      return result.ok ? result.value : [];
    },
    persistRun: async (l, run, rawLog, changesDiff) => {
      await saveRun(l, run);
      await writeRunRawLog(l, run.id, rawLog);
      if (changesDiff.length > 0) {
        await writeRunChangesDiff(l, run.id, changesDiff);
      }
    },
    now: () => NOW,
    newRunId: () => {
      seq += 1;
      return `run-new-${seq}` as RunId;
    },
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1" as TaskId,
    planVersion: 1,
    goal: "do the thing",
    writeScope: ["**"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["ok"],
    status: "running",
    ...overrides,
  } as unknown as Task;
}

function marker(overrides: Partial<InflightTurnMarker> = {}): InflightTurnMarker {
  return {
    turnId: `turn-${randomUUID().slice(0, 8)}`,
    sessionId: SESSION,
    role: "planner",
    profileId: PROFILE,
    startedAt: 1_000,
    ...overrides,
  };
}

async function transcriptOf(sessionId = SESSION) {
  return (await readTranscript(layout, sessionId)).entries;
}

describe("repairInterruptedTurns", () => {
  it("没有标记 → 空报告，不触碰任何文件", async () => {
    const report = await repairInterruptedTurns(layout, realDeps());
    expect(report).toEqual({ repaired: [], skippedActive: [], issues: [] });
    expect(await transcriptOf()).toEqual([]);
  });

  it("Planner 轮标记 → transcript 补 assistant_message{partial} + turn_end{interrupted}，删标记，不铸 Run", async () => {
    const m = marker({ resumeKind: "context_rebuild" });
    await writeInflightMarker(layout, m);
    await writeInflightPartial(layout, m.turnId, "说了一半");

    const report = await repairInterruptedTurns(layout, realDeps());

    expect(report.repaired).toEqual([
      { turnId: m.turnId, role: "planner", action: "transcript-only" },
    ]);
    expect(report.issues).toEqual([]);
    expect(await transcriptOf()).toEqual([
      { kind: "assistant_message", turnId: m.turnId, at: NOW, text: "说了一半", partial: true },
      {
        kind: "turn_end",
        turnId: m.turnId,
        at: NOW,
        role: "planner",
        profileId: PROFILE,
        resumeKind: "context_rebuild",
        endReason: "interrupted",
      },
    ]);
    expect((await listInflightMarkers(layout)).markers).toEqual([]);
    expect(await readInflightPartial(layout, m.turnId)).toBeUndefined();
    const runs = await listRuns(layout);
    expect(runs.ok && runs.value).toEqual([]);
  });

  it("Worker 轮标记且任务 running → 补 Run(interrupted，report 为部分文本) + 任务 failed + transcript 带 runId", async () => {
    await saveTask(layout, task({ status: "running" }));
    const m = marker({ role: "worker", taskId: "task-1" as TaskId });
    await writeInflightMarker(layout, m);
    await writeInflightPartial(layout, m.turnId, "改了两个文件");

    const report = await repairInterruptedTurns(layout, realDeps());

    expect(report.repaired).toEqual([
      { turnId: m.turnId, role: "worker", action: "run-and-task", runId: "run-new-1" },
    ]);
    const runs = await listRuns(layout);
    expect(runs.ok && runs.value).toHaveLength(1);
    expect(runs.ok && runs.value[0]).toMatchObject({
      id: "run-new-1",
      taskId: "task-1",
      attempt: 1,
      profileId: PROFILE,
      startedAt: 1_000,
      endedAt: NOW,
      endReason: "interrupted",
      report: "改了两个文件",
    });
    const reloaded = await loadTask(layout, "task-1" as TaskId);
    expect(reloaded.ok && reloaded.value.status).toBe("failed");
    expect((await transcriptOf()).at(-1)).toMatchObject({
      kind: "turn_end",
      role: "worker",
      runId: "run-new-1",
      taskId: "task-1",
      endReason: "interrupted",
    });
    expect((await listInflightMarkers(layout)).markers).toEqual([]);
  });

  it("Worker 轮标记但任务已 failed → 不动任务、不铸 Run，只补 transcript 并删标记（记日志）", async () => {
    await saveTask(layout, task({ status: "failed" }));
    const m = marker({ role: "worker", taskId: "task-1" as TaskId });
    await writeInflightMarker(layout, m);
    const logs: string[] = [];

    const report = await repairInterruptedTurns(layout, realDeps({ log: (l) => logs.push(l) }));

    expect(report.repaired).toEqual([
      { turnId: m.turnId, role: "worker", action: "task-already-settled" },
    ]);
    const runs = await listRuns(layout);
    expect(runs.ok && runs.value).toEqual([]);
    const reloaded = await loadTask(layout, "task-1" as TaskId);
    expect(reloaded.ok && reloaded.value.status).toBe("failed");
    // 没有部分文本 → 只有 turn_end，且不带 runId
    const entries = await transcriptOf();
    expect(entries.map((e) => e.kind)).toEqual(["turn_end"]);
    expect(entries[0]).not.toHaveProperty("runId");
    expect(logs.some((l) => l.includes("already failed"))).toBe(true);
    expect((await listInflightMarkers(layout)).markers).toEqual([]);
  });

  it("Worker 轮 attempt 递增沿用该任务已有 Run 的最大值", async () => {
    await saveTask(layout, task({ status: "running" }));
    const prior: Run = {
      id: "run-old" as RunId,
      taskId: "task-1" as TaskId,
      attempt: 3,
      profileId: PROFILE,
      startedAt: 1,
      endedAt: 2,
      endReason: "failed",
      fileChanges: [],
      commands: [],
      rawLogPath: "raw.log",
    };
    await saveRun(layout, prior);
    await writeInflightMarker(layout, marker({ role: "worker", taskId: "task-1" as TaskId }));

    await repairInterruptedTurns(layout, realDeps());

    const runs = await listRuns(layout);
    expect(runs.ok && runs.value.map((r) => r.attempt)).toEqual([3, 4]);
  });

  it("审查轮标记 → transcript turn_end 带被审 Run 的 runId / taskId，不动任务", async () => {
    await saveTask(layout, task({ status: "done" }));
    const m = marker({
      role: "reviewer",
      taskId: "task-1" as TaskId,
      runId: "run-under-review" as RunId,
    });
    await writeInflightMarker(layout, m);

    const report = await repairInterruptedTurns(layout, realDeps());

    expect(report.repaired[0]).toMatchObject({
      action: "transcript-only",
      runId: "run-under-review",
    });
    expect((await transcriptOf()).at(-1)).toMatchObject({
      kind: "turn_end",
      role: "reviewer",
      runId: "run-under-review",
      taskId: "task-1",
    });
    const reloaded = await loadTask(layout, "task-1" as TaskId);
    expect(reloaded.ok && reloaded.value.status).toBe("done");
  });

  it("本进程仍在飞的轮按 isTurnActive 跳过（标记是活的，不是残留）", async () => {
    const live = marker({ turnId: "live-turn" });
    const stale = marker({ turnId: "stale-turn" });
    await writeInflightMarker(layout, live);
    await writeInflightMarker(layout, stale);

    const report = await repairInterruptedTurns(
      layout,
      realDeps({ isTurnActive: (id) => id === "live-turn" }),
    );

    expect(report.skippedActive).toEqual(["live-turn"]);
    expect(report.repaired.map((r) => r.turnId)).toEqual(["stale-turn"]);
    expect((await listInflightMarkers(layout)).markers.map((m) => m.turnId)).toEqual(["live-turn"]);
  });

  it("幂等：第二次扫描无事可做", async () => {
    await saveTask(layout, task({ status: "running" }));
    await writeInflightMarker(layout, marker({ role: "worker", taskId: "task-1" as TaskId }));

    const first = await repairInterruptedTurns(layout, realDeps());
    const second = await repairInterruptedTurns(layout, realDeps());

    expect(first.repaired).toHaveLength(1);
    expect(second.repaired).toHaveLength(0);
    const runs = await listRuns(layout);
    expect(runs.ok && runs.value).toHaveLength(1);
    expect((await transcriptOf()).filter((e) => e.kind === "turn_end")).toHaveLength(1);
  });

  it("坏标记进 issues、不阻断其余；Run 落盘失败时任务仍被拉回 failed（task-only）", async () => {
    await saveTask(layout, task({ status: "running" }));
    await writeJsonAtomic(resolveInflightPaths(layout, "bad").markerFile, {
      turnId: "bad",
      role: "x",
    });
    const m = marker({ role: "worker", taskId: "task-1" as TaskId });
    await writeInflightMarker(layout, m);

    const report = await repairInterruptedTurns(
      layout,
      realDeps({
        persistRun: async () => {
          throw new Error("disk full");
        },
      }),
    );

    expect(report.issues.some((i) => i.ref.endsWith("bad.json"))).toBe(true);
    expect(report.issues.some((i) => i.ref === m.turnId && i.message.includes("disk full"))).toBe(
      true,
    );
    expect(report.repaired).toEqual([{ turnId: m.turnId, role: "worker", action: "task-only" }]);
    const reloaded = await loadTask(layout, "task-1" as TaskId);
    expect(reloaded.ok && reloaded.value.status).toBe("failed");
    // 好标记已删；坏标记原地保留（人工检视）
    const remaining = await listInflightMarkers(layout);
    expect(remaining.markers).toEqual([]);
    expect(remaining.issues).toHaveLength(1);
  });
});

describe("createProjectRepairer", () => {
  it("同一项目只扫一次；并发触碰共享同一次扫描", async () => {
    let scans = 0;
    const deps = realDeps({
      listInflightMarkers: async (l) => {
        scans += 1;
        return listInflightMarkers(l);
      },
    });
    await writeInflightMarker(layout, marker());
    const repairer = createProjectRepairer(deps);

    const [a, b] = await Promise.all([
      repairer.ensureRepaired(layout),
      repairer.ensureRepaired(layout),
    ]);
    const c = await repairer.ensureRepaired(layout);

    expect(scans).toBe(1);
    expect(a?.repaired).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBeUndefined();
  });

  it("扫描抛错 → 记日志返回 undefined，下次触碰重试", async () => {
    let fail = true;
    const logs: string[] = [];
    const deps = realDeps({
      listInflightMarkers: async (l) => {
        if (fail) {
          throw new Error("EACCES");
        }
        return listInflightMarkers(l);
      },
      log: (l) => logs.push(l),
    });
    const repairer = createProjectRepairer(deps);

    expect(await repairer.ensureRepaired(layout)).toBeUndefined();
    expect(logs.some((l) => l.includes("scan failed"))).toBe(true);
    fail = false;
    expect(await repairer.ensureRepaired(layout)).toEqual({
      repaired: [],
      skippedActive: [],
      issues: [],
    });
  });
});
