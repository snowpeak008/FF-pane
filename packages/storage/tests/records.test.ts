/**
 * W1.2b 单测：Plan / Task / Run 记录层读写，全部走 mkdtemp 临时目录真实读写。
 * 覆盖：三对象 round-trip（含中文内容）、状态过滤、非法状态拒读、
 * md 视图关键节、Run 证据文件写读、ID 文件名安全化（含单射性）。
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  MemoryEntryId,
  Plan,
  PlanVersion,
  ProfileId,
  Run,
  RunId,
  Task,
  TaskId,
} from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectLayout, RecordLoadError, RecordResult } from "../src/index.js";
import {
  initProjectLayout,
  listRuns,
  listTasks,
  loadPlan,
  loadRun,
  loadTask,
  planMdFileName,
  planMetaFileName,
  RUN_RAW_LOG_FILE_NAME,
  readRunChangesDiff,
  readRunRawLog,
  readText,
  resolveRunPaths,
  runDirName,
  StorageInvalidRecordError,
  sanitizeIdForFileName,
  savePlan,
  saveRun,
  saveTask,
  taskFileName,
  writeJsonAtomic,
  writeRunChangesDiff,
  writeRunRawLog,
} from "../src/index.js";

let tempRoot: string;
let layout: ProjectLayout;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-records-"));
  layout = await initProjectLayout(join(tempRoot, "音智体美劳项目"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function expectOk<T>(result: RecordResult<T>): T {
  if (!result.ok) {
    throw new Error(`预期成功结果，实际失败: ${result.error.message}`);
  }
  return result.value;
}

function expectErr<T>(result: RecordResult<T>): RecordLoadError {
  if (result.ok) {
    throw new Error("预期失败结果，实际成功");
  }
  return result.error;
}

function makeTask(id: string, status: Task["status"], overrides?: Partial<Task>): Task {
  return {
    id: id as TaskId,
    planVersion: 1 as PlanVersion,
    goal: `任务 ${id} 的中文目标`,
    writeScope: ["packages/storage/src/records/**"],
    forbidden: ["禁止 git 操作", "禁止安装依赖"],
    dependsOn: [],
    contextRefs: ["记忆-决策-001" as MemoryEntryId],
    acceptance: ["pnpm test 全绿"],
    status,
    ...overrides,
  };
}

function makeRun(id: string, taskId: string, attempt: number, startedAt: number): Run {
  return {
    id: id as RunId,
    taskId: taskId as TaskId,
    attempt,
    profileId: "profile-默认执行者" as ProfileId,
    startedAt,
    endedAt: startedAt + 60_000,
    endReason: "completed",
    fileChanges: [{ path: "src/入口.ts", diff: "--- a/src/入口.ts\n+++ b/src/入口.ts\n" }],
    commands: [{ command: "pnpm test", exitCode: 0 }],
    verifyResult: { command: "pnpm test", exitCode: 0, output: "全部通过 ✓" },
    report: "## 完成报告\n\n已按合同完成。",
    rawLogPath: RUN_RAW_LOG_FILE_NAME,
  };
}

const PLAN_V1: Plan = {
  version: 1 as PlanVersion,
  status: "approved",
  goal: "搭建计划 / 任务 / Run 的本地持久化层",
  scope: ["实现 records 读写 API", "覆盖中文内容往返"],
  nonGoals: ["不做云同步"],
  constraints: ["禁止改动并行工单目录"],
  decisions: ["meta.json 为权威数据源，md 为渲染视图"],
  tasks: [
    {
      id: "T-001" as TaskId,
      planVersion: 1 as PlanVersion,
      goal: "实现 Plan 双文件读写",
      writeScope: ["packages/storage/src/records/**"],
      forbidden: ["触碰 fs 层实现"],
      dependsOn: [],
      contextRefs: [],
      acceptance: ["round-trip 测试通过"],
      verifyCmd: "pnpm test",
    },
    {
      id: "T-002" as TaskId,
      planVersion: 1 as PlanVersion,
      goal: "实现 Run 证据文件",
      writeScope: ["packages/storage/src/records/run.ts"],
      forbidden: [],
      dependsOn: ["T-001" as TaskId],
      contextRefs: [],
      acceptance: ["证据文件可写可读"],
    },
  ],
  acceptance: ["pnpm lint / test / build 全绿"],
  approvedBy: { by: "user", at: 1_756_400_000_000 },
};

describe("Plan 双文件读写", () => {
  it("savePlan 同时落盘 meta.json 与 md，loadPlan 以 meta 为准完整 round-trip", async () => {
    const files = await savePlan(layout, PLAN_V1);
    expect(basename(files.metaFile)).toBe("plan-v1.meta.json");
    expect(basename(files.mdFile)).toBe("plan-v1.md");
    expect((await readdir(layout.plansDir)).sort()).toEqual(["plan-v1.md", "plan-v1.meta.json"]);

    const loaded = expectOk(await loadPlan(layout, 1 as PlanVersion));
    expect(loaded.plan).toEqual(PLAN_V1);
    expect(loaded.warnings).toEqual([]);
  });

  it("md 视图包含关键节与权威声明，任务合同逐条渲染", async () => {
    await savePlan(layout, PLAN_V1);
    const md = expectOk(await loadPlan(layout, 1 as PlanVersion));
    expect(md.warnings).toEqual([]);
    const mdText = await readText(join(layout.plansDir, planMdFileName(1)));
    if (!mdText.ok) {
      throw new Error("预期 md 视图可读");
    }
    for (const section of [
      "# 计划 v1",
      "## 目标",
      "## 范围",
      "## 非目标",
      "## 约束",
      "## 决策",
      "## 任务",
      "## 验收",
    ]) {
      expect(mdText.value).toContain(section);
    }
    expect(mdText.value).toContain("权威数据以 meta.json 为准");
    expect(mdText.value).toContain("搭建计划 / 任务 / Run 的本地持久化层");
    expect(mdText.value).toContain("- 状态：approved");
    expect(mdText.value).toContain("### T-001：实现 Plan 双文件读写");
    expect(mdText.value).toContain("- 依赖任务：T-001");
    expect(mdText.value).toContain("- 验证命令：`pnpm test`");
    expect(mdText.value).toContain("pnpm lint / test / build 全绿");
  });

  it("md 视图缺失只警告不阻塞，meta 数据仍完整返回", async () => {
    await savePlan(layout, PLAN_V1);
    await rm(join(layout.plansDir, planMdFileName(1)));
    const loaded = expectOk(await loadPlan(layout, 1 as PlanVersion));
    expect(loaded.plan).toEqual(PLAN_V1);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.code).toBe("plan-md-missing");
    expect(loaded.warnings[0]?.path).toBe(join(layout.plansDir, planMdFileName(1)));
  });

  it("meta.json 内状态非法：拒读并返回带路径与字段名的 invalid-record", async () => {
    const metaFile = join(layout.plansDir, planMetaFileName(1));
    await writeJsonAtomic(metaFile, { ...PLAN_V1, status: "已经批准" });
    const error = expectErr(await loadPlan(layout, 1 as PlanVersion));
    expect(error).toBeInstanceOf(StorageInvalidRecordError);
    expect(error.code).toBe("invalid-record");
    expect(error.path).toBe(metaFile);
    if (!(error instanceof StorageInvalidRecordError)) {
      throw new Error("预期 StorageInvalidRecordError");
    }
    expect(error.field).toBe("status");
    expect(error.message).toContain("已经批准");
  });

  it("meta.json 内版本与文件名不一致：拒读（field=version）", async () => {
    await writeJsonAtomic(join(layout.plansDir, planMetaFileName(1)), {
      ...PLAN_V1,
      version: 2,
    });
    const error = expectErr(await loadPlan(layout, 1 as PlanVersion));
    expect(error.code).toBe("invalid-record");
    expect(error instanceof StorageInvalidRecordError && error.field).toBe("version");
  });

  it("非法版本号：savePlan 抛异常，loadPlan 返回失败结果；不存在的版本返回 not-found", async () => {
    await expect(
      savePlan(layout, { ...PLAN_V1, version: 0 as PlanVersion }),
    ).rejects.toBeInstanceOf(StorageInvalidRecordError);
    expect(expectErr(await loadPlan(layout, 1.5 as PlanVersion)).code).toBe("invalid-record");
    expect(expectErr(await loadPlan(layout, 7 as PlanVersion)).code).toBe("not-found");
  });
});

describe("Task 读写与状态过滤", () => {
  it("round-trip：含中文内容与可选 verifyCmd 的有无", async () => {
    const withCmd = makeTask("T-中文-01", "running", { verifyCmd: "pnpm test" });
    const withoutCmd = makeTask("T-中文-02", "pending");
    await saveTask(layout, withCmd);
    await saveTask(layout, withoutCmd);

    expect(expectOk(await loadTask(layout, withCmd.id))).toEqual(withCmd);
    const loaded = expectOk(await loadTask(layout, withoutCmd.id));
    expect(loaded).toEqual(withoutCmd);
    expect("verifyCmd" in loaded).toBe(false);
  });

  it("listTasks 全量按文件名排序，可按状态过滤；不存在的 ID 返回 not-found", async () => {
    await saveTask(layout, makeTask("T-01", "pending"));
    await saveTask(layout, makeTask("T-02", "done"));
    await saveTask(layout, makeTask("T-03", "done"));

    const all = expectOk(await listTasks(layout));
    expect(all.map((task) => task.id)).toEqual(["T-01", "T-02", "T-03"]);

    const done = expectOk(await listTasks(layout, "done"));
    expect(done.map((task) => task.id)).toEqual(["T-02", "T-03"]);
    expect(expectOk(await listTasks(layout, "cancelled"))).toEqual([]);

    expect(expectErr(await loadTask(layout, "T-99" as TaskId)).code).toBe("not-found");
  });

  it("非法状态拒读：loadTask 与 listTasks 均返回带路径与字段名的 invalid-record", async () => {
    const task = makeTask("T-坏", "pending");
    const file = join(layout.tasksDir, taskFileName(task.id));
    await writeJsonAtomic(file, { ...task, status: "flying" });

    const error = expectErr(await loadTask(layout, task.id));
    expect(error).toBeInstanceOf(StorageInvalidRecordError);
    expect(error.code).toBe("invalid-record");
    expect(error.path).toBe(file);
    expect(error instanceof StorageInvalidRecordError && error.field).toBe("status");

    expect(expectErr(await listTasks(layout)).code).toBe("invalid-record");
  });

  it("文件内 id 被改错时按 invalid-record 拒读（field=id）", async () => {
    const task = makeTask("T-甲", "pending");
    await writeJsonAtomic(join(layout.tasksDir, taskFileName(task.id)), {
      ...task,
      id: "T-乙",
    });
    const error = expectErr(await loadTask(layout, task.id));
    expect(error.code).toBe("invalid-record");
    expect(error instanceof StorageInvalidRecordError && error.field).toBe("id");
  });
});

describe("ID 文件名安全化", () => {
  it("非法字符百分号编码，中文与常规字符保留原样", () => {
    expect(sanitizeIdForFileName('a/b:c*?"<>|')).toBe("a%2Fb%3Ac%2A%3F%22%3C%3E%7C");
    expect(sanitizeIdForFileName("任务-01.重构_v2")).toBe("任务-01.重构_v2");
    expect(sanitizeIdForFileName("a%2Fb")).toBe("a%252Fb");
    // 结尾的点与空格必须编码（Windows 会剥掉目录名结尾的点/空格），中间的保留
    expect(sanitizeIdForFileName("v1.0.. ")).toBe("v1.0%2E%2E%20");
    expect(runDirName("id.")).toBe("run-id%2E");
  });

  it("单射性实测：仅非法字符不同的 ID 各自落盘互不覆盖，round-trip 无损", async () => {
    const ids = ["a/b", "a\\b", "a:b", "a%3Ab"];
    for (const id of ids) {
      await saveTask(layout, makeTask(id, "pending"));
    }
    const all = expectOk(await listTasks(layout));
    expect(all.map((task) => task.id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(expectOk(await loadTask(layout, id as TaskId)).id).toBe(id);
    }
    for (const name of await readdir(layout.tasksDir)) {
      expect(name).not.toMatch(/[\\/:*?"<>|]/);
    }
  });
});

describe("Run 读写与证据文件", () => {
  it("round-trip：run.json + changes.diff + raw.log 三件套，中文内容完整往返", async () => {
    const run = makeRun("R-001", "T-01", 1, 1_756_400_100_000);
    const paths = await saveRun(layout, run);
    expect(paths.runDir).toBe(join(layout.runsDir, runDirName("R-001")));
    expect(paths).toEqual(resolveRunPaths(layout, run.id));

    const diffText = "--- a/src/入口.ts\n+++ b/src/入口.ts\n@@ -1 +1 @@\n-旧行\n+新行\n";
    const logText = "[10:00] 开始执行任务……\n[10:01] 完成 ✓\n";
    expect(await writeRunChangesDiff(layout, run.id, diffText)).toBe(paths.changesDiffFile);
    expect(await writeRunRawLog(layout, run.id, logText)).toBe(paths.rawLogFile);
    expect((await readdir(paths.runDir)).sort()).toEqual(["changes.diff", "raw.log", "run.json"]);

    const loaded = expectOk(await loadRun(layout, run.id));
    expect(loaded).toEqual(run);
    expect(loaded.rawLogPath).toBe(RUN_RAW_LOG_FILE_NAME);

    const diffBack = await readRunChangesDiff(layout, run.id);
    expect(diffBack.ok && diffBack.value).toBe(diffText);
    const logBack = await readRunRawLog(layout, run.id);
    expect(logBack.ok && logBack.value).toBe(logText);
  });

  it("证据文件未写入时读取返回 not-found 结果而非抛异常", async () => {
    const run = makeRun("R-空", "T-01", 1, 1_756_400_100_000);
    await saveRun(layout, run);
    const diffBack = await readRunChangesDiff(layout, run.id);
    expect(!diffBack.ok && diffBack.error.code).toBe("not-found");
  });

  it("saveRun 强制 rawLogPath 为相对文件名（拒绝目录分隔符与绝对路径）", async () => {
    const bad = { ...makeRun("R-002", "T-01", 1, 1_756_400_100_000), rawLogPath: "logs/raw.log" };
    await expect(saveRun(layout, bad)).rejects.toBeInstanceOf(StorageInvalidRecordError);
    const abs = { ...bad, rawLogPath: "C:\\logs\\raw.log" };
    await expect(saveRun(layout, abs)).rejects.toBeInstanceOf(StorageInvalidRecordError);
    await expect(saveRun(layout, bad)).rejects.toMatchObject({
      code: "invalid-record",
      field: "rawLogPath",
    });
  });

  it("listRuns 按 startedAt/attempt 排序，可按 taskId 过滤，跳过缺 run.json 的目录", async () => {
    const runA2 = makeRun("R-A2", "T-A", 2, 1_756_400_300_000);
    const runA1 = makeRun("R-A1", "T-A", 1, 1_756_400_100_000);
    const runB1 = makeRun("R-B1", "T-B", 1, 1_756_400_200_000);
    await saveRun(layout, runA2);
    await saveRun(layout, runA1);
    await saveRun(layout, runB1);
    // saveRun 前崩溃留下的空目录：应被静默跳过
    await mkdir(join(layout.runsDir, "run-崩溃残留"), { recursive: true });

    const all = expectOk(await listRuns(layout));
    expect(all.map((run) => run.id)).toEqual(["R-A1", "R-B1", "R-A2"]);

    const taskARuns = expectOk(await listRuns(layout, "T-A" as TaskId));
    expect(taskARuns.map((run) => run.id)).toEqual(["R-A1", "R-A2"]);
  });

  it("非法 endReason 拒读：invalid-record 携带路径与字段名", async () => {
    const run = makeRun("R-坏", "T-A", 1, 1_756_400_100_000);
    const { runJsonFile } = resolveRunPaths(layout, run.id);
    await writeJsonAtomic(runJsonFile, { ...run, endReason: "exploded" });

    const error = expectErr(await loadRun(layout, run.id));
    expect(error).toBeInstanceOf(StorageInvalidRecordError);
    expect(error.code).toBe("invalid-record");
    expect(error.path).toBe(runJsonFile);
    expect(error instanceof StorageInvalidRecordError && error.field).toBe("endReason");
    expect(expectErr(await listRuns(layout)).code).toBe("invalid-record");
  });

  it("执行中的 Run（无 endedAt/endReason）round-trip 后可选字段保持缺省", async () => {
    const {
      endedAt: _endedAt,
      endReason: _endReason,
      ...inProgress
    } = makeRun("R-进行中", "T-A", 1, 1_756_400_100_000);
    await saveRun(layout, inProgress);
    const loaded = expectOk(await loadRun(layout, inProgress.id));
    expect(loaded).toEqual(inProgress);
    expect("endReason" in loaded).toBe(false);
  });
});
