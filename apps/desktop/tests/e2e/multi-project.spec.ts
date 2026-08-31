/**
 * 冒烟 10：多项目并存（T7.4，§11.1）。
 *
 * 两件事在这里同时取证，因为它们本就是同一个场景的两面：
 * 1. 项目间数据隔离——两个项目同时登记在工作台里时，项目记忆互不可见、`.workbench/`
 *    各自独立、会话登记不串项目；而知识库与共享记忆（习惯）确为全局，两个项目同见。
 *    经真实 preload → 主进程 → storage 链路取证，并辅以磁盘落点核对。
 * 2. 项目卡片的派生信息——当前计划版本与状态 / 进行中任务数 / 最后活动时间，由查询层
 *    当场汇总（不持久化），两个项目各算各的，缺数据如实降级。
 *
 * 数据用直接落盘的方式种进去：计划 / 任务 / Run / 会话登记都没有"凭空创建"的 IPC——
 * 它们是 §12 十步流程跑出来的产物，起真流程需要可用 Provider。落盘格式即 W1.2b/c 的
 * 持久层约定，由主进程真实读回，读链路与生产完全一致。
 *
 * hermetic：不联网、不起任何 Agent 进程；数据根与 userData 均在临时区（见 _launch.ts）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoRoute, type LaunchedApp, launchApp } from "./_launch";

/** 三个时刻，全部在过去且互不相等，供"最后活动取最晚者"这条断言看得出取的是哪一个。 */
const PLAN_APPROVED_AT = 1_700_000_100_000;
const SESSION_ACTIVE_AT = 1_700_000_400_000;
const RUN_ENDED_AT = 1_700_000_500_000;

/** 一条记忆条目（一条一文件 Markdown，§10.2 / W1.2c）。 */
function seedMemoryEntry(projectRoot: string, id: string): void {
  const iso = new Date(1_700_000_000_000).toISOString();
  writeFileSync(
    join(projectRoot, ".workbench", "memory", "rules", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "category: rule",
      "status: active",
      "source: user_manual",
      "confidence: high",
      `created: ${iso}`,
      `updated: ${iso}`,
      "---",
      "",
      `# 条目 ${id}`,
      "",
      `这是 ${id} 的正文。`,
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 计划 v1（已批准）：meta.json 是权威数据，md 是渲染视图（缺了只警告，故一并写上）。 */
function seedPlan(projectRoot: string): void {
  const plansDir = join(projectRoot, ".workbench", "plans");
  const plan = {
    version: 1,
    status: "approved",
    goal: "隔离核查用计划",
    scope: [],
    nonGoals: [],
    constraints: [],
    decisions: [],
    tasks: [],
    acceptance: [],
    approvedBy: { by: "user", at: PLAN_APPROVED_AT },
  };
  writeFileSync(join(plansDir, "plan-v1.meta.json"), JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(join(plansDir, "plan-v1.md"), "# 计划 v1\n", "utf8");
}

function seedTask(projectRoot: string, id: string, status: string): void {
  const task = {
    id,
    planVersion: 1,
    goal: `任务 ${id}`,
    writeScope: ["src/**"],
    forbidden: [],
    dependsOn: [],
    contextRefs: [],
    acceptance: ["单测全绿"],
    status,
  };
  writeFileSync(
    join(projectRoot, ".workbench", "tasks", `task-${id}.json`),
    JSON.stringify(task, null, 2),
    "utf8",
  );
}

function seedRun(projectRoot: string, id: string, taskId: string): void {
  const runDir = join(projectRoot, ".workbench", "runs", `run-${id}`);
  mkdirSync(runDir, { recursive: true });
  const run = {
    id,
    taskId,
    attempt: 1,
    profileId: "prof-iso",
    startedAt: RUN_ENDED_AT - 100_000,
    endedAt: RUN_ENDED_AT,
    endReason: "completed",
    fileChanges: [],
    commands: [],
    rawLogPath: "raw.log",
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf8");
  writeFileSync(join(runDir, "raw.log"), "", "utf8");
}

function seedSession(projectRoot: string, id: string): void {
  const file = {
    version: 1,
    sessions: [
      {
        id,
        profileId: "prof-iso",
        role: "planner",
        createdAt: SESSION_ACTIVE_AT - 1000,
        lastActiveAt: SESSION_ACTIVE_AT,
      },
    ],
  };
  writeFileSync(
    join(projectRoot, ".workbench", "sessions.json"),
    JSON.stringify(file, null, 2),
    "utf8",
  );
}

/** 目录内的条目名（目录不存在返回空数组）。 */
function namesIn(dir: string): readonly string[] {
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

let launched: LaunchedApp;
let alphaDir: string;
let betaDir: string;
let gammaDir: string;

test.beforeAll(async () => {
  launched = await launchApp();
  alphaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-iso-alpha-"));
  betaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-iso-beta-"));
  gammaDir = mkdtempSync(join(tmpdir(), "ffpane-e2e-iso-gamma-"));
});

test.afterAll(async () => {
  await launched.cleanup();
  for (const dir of [alphaDir, betaDir, gammaDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("两项目并存：项目记忆 / .workbench / 会话登记三处互不串，知识库与共享记忆确为全局", async () => {
  const { page, dataRoot } = launched;

  // 三个项目都经 projects:create 登记（顺带生成各自的 .workbench/ 全套目录）
  await page.evaluate(
    async (dirs: readonly string[]) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      await invoke("projects:create", { name: "E2E Iso Alpha", rootPath: dirs[0] });
      await invoke("projects:create", { name: "E2E Iso Beta", rootPath: dirs[1] });
      await invoke("projects:create", { name: "E2E Iso Gamma", rootPath: dirs[2] });
    },
    [alphaDir, betaDir, gammaDir],
  );

  // Alpha 有全套项目数据；Beta 只有一条自己的记忆；Gamma 建完就把数据目录端掉（坏盘 / 被删）
  seedMemoryEntry(alphaDir, "rule-alpha");
  seedPlan(alphaDir);
  seedTask(alphaDir, "task-alpha-1", "running");
  seedTask(alphaDir, "task-alpha-2", "accepted");
  seedRun(alphaDir, "run-alpha-1", "task-alpha-1");
  seedSession(alphaDir, "ls-alpha");
  seedMemoryEntry(betaDir, "rule-beta");
  rmSync(join(gammaDir, ".workbench"), { recursive: true, force: true });

  const result = await page.evaluate(
    async (dirs: readonly string[]) => {
      const invoke = (channel: string, req?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: E2E 里按通道字符串调用，类型在契约层已保证
        (window as any).ffpane.invoke(channel, req);
      const alpha = dirs[0] as string;
      const beta = dirs[1] as string;

      // 共享记忆（习惯）与知识库都是全局通道——请求里根本没有 projectRoot 可填
      await invoke("habits:create", {
        draft: {
          category: "workflow",
          content: "跨项目共享的习惯：改动前先看验收标准。",
          importance: 80,
          status: "active",
          enabled: true,
          source: { kind: "user_manual" },
        },
      });
      await invoke("knowledge:create-entry", {
        importId: "e2e-iso-note",
        title: "跨项目知识",
        content: "这条知识属于工作台，不属于任何一个项目。",
        source: { kind: "manual" },
      });

      const scoped = async (dir: string) => ({
        memory: (await invoke("memory:list", { projectRoot: dir })).map(
          (entry: { id: string }) => entry.id,
        ),
        plans: (await invoke("plans:list", { projectRoot: dir })).map(
          (plan: { version: number }) => plan.version,
        ),
        tasks: (await invoke("tasks:list", { projectRoot: dir })).map(
          (task: { id: string }) => task.id,
        ),
        runs: (await invoke("runs:list", { projectRoot: dir })).map(
          (run: { id: string }) => run.id,
        ),
        sessions: (await invoke("sessions:list", { projectRoot: dir })).map(
          (session: { id: string }) => session.id,
        ),
      });

      return {
        alpha: await scoped(alpha),
        beta: await scoped(beta),
        habits: (await invoke("habits:list")).map((habit: { content: string }) => habit.content),
        knowledge: (await invoke("knowledge:list")).entries.map(
          (view: { entry: { title: string } }) => view.entry.title,
        ),
        summaries: await invoke("projects:summary"),
      };
    },
    [alphaDir, betaDir],
  );

  // 项目记忆互不可见（§8.1 项目记忆是项目作用域）
  expect(result.alpha.memory).toEqual(["rule-alpha"]);
  expect(result.beta.memory).toEqual(["rule-beta"]);

  // `.workbench/` 边界：Alpha 的计划 / 任务 / Run 一个都没漏进 Beta
  expect(result.alpha.plans).toEqual([1]);
  expect(result.alpha.tasks).toEqual(["task-alpha-1", "task-alpha-2"]);
  expect(result.alpha.runs).toEqual(["run-alpha-1"]);
  expect(result.beta.plans).toEqual([]);
  expect(result.beta.tasks).toEqual([]);
  expect(result.beta.runs).toEqual([]);

  // 会话登记不串项目（sessions.json 在各自 .workbench/ 下，§10.2 规则 3）
  expect(result.alpha.sessions).toEqual(["ls-alpha"]);
  expect(result.beta.sessions).toEqual([]);

  // 共享记忆与知识库是全局的：同一份内容，两个项目都看得见（通道本身就不带项目作用域）
  expect(result.habits).toContain("跨项目共享的习惯：改动前先看验收标准。");
  expect(result.knowledge).toContain("跨项目知识");

  // 磁盘落点核对：项目数据在各自 .workbench/ 下，全局数据在数据根下，两边不交叉
  expect(namesIn(join(alphaDir, ".workbench", "plans"))).toEqual([
    "plan-v1.md",
    "plan-v1.meta.json",
  ]);
  expect(namesIn(join(betaDir, ".workbench", "plans"))).toEqual([]);
  expect(namesIn(join(betaDir, ".workbench", "tasks"))).toEqual([]);
  expect(namesIn(join(betaDir, ".workbench", "runs"))).toEqual([]);
  expect(namesIn(join(alphaDir, ".workbench", "memory", "rules"))).toEqual(["rule-alpha.md"]);
  expect(namesIn(join(betaDir, ".workbench", "memory", "rules"))).toEqual(["rule-beta.md"]);
  expect(existsSync(join(betaDir, ".workbench", "sessions.json"))).toBe(false);

  // 知识库落在全局数据根（notes/ + index.sqlite），项目的 .workbench/knowledge 空着
  expect(namesIn(join(dataRoot, "knowledge", "notes")).length).toBeGreaterThan(0);
  expect(existsSync(join(dataRoot, "index.sqlite"))).toBe(true);
  expect(namesIn(join(alphaDir, ".workbench", "knowledge"))).toEqual([]);
  expect(namesIn(join(betaDir, ".workbench", "knowledge"))).toEqual([]);
  expect(existsSync(join(alphaDir, ".workbench", "index.sqlite"))).toBe(false);
  expect(existsSync(join(betaDir, ".workbench", "index.sqlite"))).toBe(false);

  // 共享记忆落在全局 habits/ 下，不在任何项目里
  expect(namesIn(join(dataRoot, "habits", "workflow")).length).toBe(1);

  // 派生摘要各算各的（T7.4）：Alpha 有计划有任务有活动，Beta 全空，Gamma 数据目录没了
  type SummaryView = {
    readonly entry: { readonly name: string };
    readonly summary: Record<string, unknown>;
  };
  const byName = new Map(
    (result.summaries as SummaryView[]).map((view) => [view.entry.name, view.summary]),
  );

  expect(byName.get("E2E Iso Alpha")).toMatchObject({
    workbenchPresent: true,
    planVersion: 1,
    planStatus: "approved",
    // 两条任务，accepted 的那条已收尾，故进行中只剩一条
    activeTaskCount: 1,
    taskCount: 2,
    // 三个时刻里 Run 收尾最晚，它才是最后一次活动
    lastActivityAt: RUN_ENDED_AT,
    lastActivitySource: "run",
    unavailable: [],
  });
  expect(byName.get("E2E Iso Beta")).toMatchObject({
    workbenchPresent: true,
    activeTaskCount: 0,
    taskCount: 0,
    unavailable: [],
  });
  expect(byName.get("E2E Iso Beta")?.["planVersion"]).toBeUndefined();
  expect(byName.get("E2E Iso Beta")?.["lastActivityAt"]).toBeUndefined();
  // 数据目录缺失如实报，不伪装成一个干净的新项目
  expect(byName.get("E2E Iso Gamma")).toMatchObject({
    workbenchPresent: false,
    activeTaskCount: 0,
    taskCount: 0,
  });
});

test("项目列表页：三张卡片各显各的派生信息，数据目录缺失的那张如实标注", async () => {
  const { page } = launched;

  // 上一条用例经 IPC 建的项目不在页面的查询缓存里，重载一次让列表拉到它们
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await gotoRoute(page, "/projects");

  const alpha = page.getByRole("button", { name: /^E2E Iso Alpha/ });
  await expect(alpha).toContainText("Plan v1 · Approved");
  await expect(alpha).toContainText("1 in progress");
  await expect(alpha).toContainText(/Last activity .+ · runs/);

  // 空态如实：没有计划就说没有计划，不造一个 v0；没有活动就说没有活动
  const beta = page.getByRole("button", { name: /^E2E Iso Beta/ });
  await expect(beta).toContainText("No plan yet");
  await expect(beta).toContainText("0 in progress");
  await expect(beta).toContainText("No activity yet");

  const gamma = page.getByRole("button", { name: /^E2E Iso Gamma/ });
  await expect(gamma).toContainText("details unavailable");
});
