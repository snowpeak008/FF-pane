/**
 * ffpane_tasks 工具（T11.24 计划 §9）：任务账本的列出、建、拆、派、检、结、取消。
 * 用户看不到账本，只有管理者后台用。执行者只看自己的，检查者写结论，监管者只读。
 */

import {
  applyTransition,
  findOverlapping,
  isTaskOpen,
  type LedgerTask,
  newTaskId,
  rollupParentStatus,
  sortForManager,
  type TaskParty,
  type TaskStatus,
  type TaskVerdict,
} from "./task-ledger";
import { readOpenLedger, updateLedger } from "./task-ledger-store";

export const TASK_ACTIONS = [
  "list",
  "add",
  "split",
  "assign",
  "verdict",
  "close",
  "cancel",
] as const;
type TaskAction = (typeof TASK_ACTIONS)[number];

export interface TaskToolCaller {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly projectRoot: string;
}

export interface TaskToolDeps {
  readonly now: () => number;
  readonly isManagerGranted: (windowId: string) => boolean;
  readonly describe: (
    windowId: string,
  ) => Promise<{ readonly id: string; readonly title: string; readonly role: string } | undefined>;
}

export interface TaskToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

type Args = Readonly<Record<string, unknown>>;
type Outcome = { readonly tasks: LedgerTask[]; readonly result: unknown };

class TaskError extends Error {}

const WRITE_ACTIONS: readonly TaskAction[] = ["add", "split", "assign", "close", "cancel"];
/** 免检直接结束时，先补走到待检查的几步。 */
const TO_SUBMITTED: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
  submitted: [],
  doing: ["submitted"],
  todo: ["doing", "submitted"],
  rework: ["doing", "submitted"],
  blocked: ["doing", "submitted"],
  failed: ["doing", "submitted"],
};

const ok = (value: unknown): TaskToolResult => ({ text: JSON.stringify(value, null, 2) });
const fail = (message: string): TaskToolResult => ({ text: message, isError: true });

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;
}

function need(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new TaskError(`缺少 ${name}。`);
  }
  return value;
}

function partyOf(who: { id: string; title: string; role: string }): TaskParty {
  return { windowId: who.id, title: who.title, role: who.role };
}

function pick(open: readonly LedgerTask[], id: string): LedgerTask {
  const found = open.find((task) => task.id === id);
  if (found === undefined) {
    throw new TaskError(`账本里没有未完成的任务 ${id}。`);
  }
  return found;
}

function replace(open: readonly LedgerTask[], next: LedgerTask): LedgerTask[] {
  return open.map((task) => (task.id === next.id ? next : task));
}

function step(
  task: LedgerTask,
  to: TaskStatus,
  by: string,
  note: string,
  now: number,
  verdict?: TaskVerdict,
): LedgerTask {
  const moved = applyTransition(task, to, by, note, now, verdict);
  if (!moved.ok) {
    throw new TaskError(moved.error);
  }
  return moved.task;
}

/** 大任务的状态由子任务汇总。 */
function withRollup(tasks: readonly LedgerTask[], now: number): LedgerTask[] {
  return tasks.map((parent) => {
    const kids = tasks.filter((task) => task.parentId === parent.id);
    const next =
      kids.length > 0 && isTaskOpen(parent.status) ? rollupParentStatus(kids) : undefined;
    if (next === undefined || next === parent.status) {
      return parent;
    }
    const event = { at: now, by: "平台", from: parent.status, to: next, note: "由子任务汇总" };
    return { ...parent, status: next, updatedAt: now, events: [...parent.events, event] };
  });
}

function blank(
  caller: TaskToolCaller,
  now: number,
  title: string,
  detail: string,
  acceptance: string,
  parentId: string | undefined,
  after: string | undefined,
  source: string | undefined,
): LedgerTask {
  return {
    id: newTaskId(),
    ...(parentId !== undefined ? { parentId } : {}),
    title,
    detail,
    acceptance,
    status: "todo",
    createdAt: now,
    updatedAt: now,
    createdBy: partyOf(caller),
    ...(source !== undefined ? { source } : {}),
    ...(after !== undefined ? { after } : {}),
    events: [{ at: now, by: caller.title, to: "todo", note: "建立" }],
  };
}

function view(task: LedgerTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.parentId !== undefined ? { parentId: task.parentId } : {}),
    detail: task.detail,
    acceptance: task.acceptance,
    ...(task.assignee !== undefined ? { assignee: task.assignee.title } : {}),
    ...(task.progress !== undefined ? { progress: task.progress } : {}),
    ...(task.after !== undefined ? { after: task.after } : {}),
    ...(task.verdict !== undefined ? { verdict: task.verdict } : {}),
    updatedAt: task.updatedAt,
  };
}

function add(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
): Outcome {
  const title = need(text(args["title"], 120), "title");
  const detail = text(args["detail"], 2000) ?? "";
  const acceptance = need(text(args["acceptance"], 500), "acceptance（验收标准）");
  const parentId = text(args["parentId"], 40);
  if (parentId !== undefined) {
    if (pick(open, parentId).parentId !== undefined) {
      throw new TaskError("只拆一层：子任务下面不能再挂子任务。");
    }
  } else if (args["force"] !== true) {
    const same = findOverlapping(open, title, detail);
    if (same.length > 0) {
      const names = same.map((task) => `${task.id}「${task.title}」`).join("、");
      throw new TaskError(
        `已有同主题的未完成任务：${names}。重合就带 parentId 挂成它的子任务；确实是新事，再传 force: true。`,
      );
    }
  }
  const task = blank(
    caller,
    now,
    title,
    detail,
    acceptance,
    parentId,
    text(args["after"], 40),
    text(args["source"], 60),
  );
  return { tasks: [...open, task], result: { created: task.id, title } };
}

function split(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
): Outcome {
  const parentId = need(text(args["parentId"], 40), "parentId");
  if (pick(open, parentId).parentId !== undefined) {
    throw new TaskError("只拆一层：子任务下面不能再拆。");
  }
  const subs = args["subtasks"];
  if (!Array.isArray(subs) || subs.length < 2 || subs.length > 10) {
    throw new TaskError(
      "subtasks 要 2 到 10 条，每条写 title、acceptance，可选 detail、after（第几条之后，从 1 数）。",
    );
  }
  const made: LedgerTask[] = [];
  for (const raw of subs) {
    const sub = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const index = typeof sub["after"] === "number" ? sub["after"] : undefined;
    const prior = index !== undefined ? made[index - 1] : undefined;
    const title = need(text(sub["title"], 120), "subtasks[].title");
    const acceptance = need(text(sub["acceptance"], 500), "subtasks[].acceptance");
    made.push(
      blank(
        caller,
        now,
        title,
        text(sub["detail"], 2000) ?? "",
        acceptance,
        parentId,
        prior?.id,
        undefined,
      ),
    );
  }
  const created = made.map((task) => ({ id: task.id, title: task.title }));
  return { tasks: [...open, ...made], result: { parent: parentId, created } };
}

function assign(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
  target: TaskParty | undefined,
): Outcome {
  const task = pick(open, need(text(args["taskId"], 40), "taskId"));
  if (target === undefined) {
    throw new TaskError("找不到要派的窗口，windowId 要填本项目里的窗口。");
  }
  if (open.some((item) => item.parentId === task.id)) {
    throw new TaskError("大任务不直接派人，派它的子任务。");
  }
  const prior = task.after === undefined ? undefined : open.find((item) => item.id === task.after);
  if (prior !== undefined) {
    throw new TaskError(`要等「${prior.title}」（${prior.id}）做完才能派这一条。`);
  }
  const brief = text(args["brief"], 300);
  const moved = step(task, "doing", caller.title, `派给「${target.title}」`, now);
  const next = { ...moved, assignee: target, ...(brief !== undefined ? { brief } : {}) };
  return {
    tasks: replace(open, next),
    result: { taskId: task.id, assignee: target.title, status: "doing" },
  };
}

function verdict(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
): Outcome {
  const task = pick(open, need(text(args["taskId"], 40), "taskId"));
  const result = args["result"];
  if (result !== "pass" && result !== "rework") {
    throw new TaskError("result 只能是 pass 或 rework。");
  }
  const reason = need(text(args["reason"], 500), "reason");
  if (task.status !== "submitted") {
    throw new TaskError(`任务现在是 ${task.status}，只有已汇报待检查的才能写结论。`);
  }
  if (caller.role === "reviewer" && task.assignee?.windowId === caller.id) {
    throw new TaskError("检查者不能是执行者本人。");
  }
  const given: TaskVerdict = { result, reason };
  const event = {
    at: now,
    by: caller.title,
    from: task.status,
    to: task.status,
    note: `通过：${reason}`,
  };
  const base =
    result === "rework"
      ? step(task, "rework", caller.title, reason, now, given)
      : { ...task, verdict: given, updatedAt: now, events: [...task.events, event] };
  return {
    tasks: replace(open, { ...base, reviewedBy: partyOf(caller) }),
    result: { taskId: task.id, verdict: result },
  };
}

function close(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
): Outcome {
  const task = pick(open, need(text(args["taskId"], 40), "taskId"));
  const reason = text(args["reason"], 500);
  if (open.some((item) => item.parentId === task.id && isTaskOpen(item.status))) {
    throw new TaskError("它还有没做完的子任务。");
  }
  let current = task;
  let waived: TaskVerdict | undefined;
  if (args["waived"] === true) {
    if (reason === undefined) {
      throw new TaskError("免检必须写理由（reason）。");
    }
    waived = { result: "waived", reason };
    for (const to of TO_SUBMITTED[task.status] ?? []) {
      current = step(current, to, caller.title, "免检直接结束", now);
    }
  }
  current = step(current, "done", caller.title, reason ?? "验收通过", now, waived);
  return {
    tasks: replace(open, current),
    result: { taskId: task.id, status: "done", waived: waived !== undefined },
  };
}

function cancel(
  caller: TaskToolCaller,
  args: Args,
  open: readonly LedgerTask[],
  now: number,
): Outcome {
  const task = pick(open, need(text(args["taskId"], 40), "taskId"));
  const reason = need(text(args["reason"], 500), "reason");
  const ids = new Set([task.id]);
  for (const item of open) {
    if (item.parentId === task.id && isTaskOpen(item.status)) {
      ids.add(item.id);
    }
  }
  const tasks = open.map((item) =>
    ids.has(item.id) ? step(item, "cancelled", caller.title, reason, now) : item,
  );
  return { tasks, result: { cancelled: [...ids] } };
}

async function list(caller: TaskToolCaller): Promise<unknown> {
  const { tasks, recovered } = await readOpenLedger(caller.projectRoot);
  const open = tasks.filter((task) => isTaskOpen(task.status));
  const mine =
    caller.role === "worker" ? open.filter((task) => task.assignee?.windowId === caller.id) : open;
  return {
    count: mine.length,
    tasks: sortForManager(mine).map(view),
    ...(recovered ? { note: "账本文件坏了，已用最近一份备份恢复，先核对一遍。" } : {}),
  };
}

async function change(
  action: TaskAction,
  caller: TaskToolCaller,
  args: Args,
  deps: TaskToolDeps,
): Promise<unknown> {
  const windowId = text(args["windowId"], 80);
  const found =
    action === "assign" && windowId !== undefined ? await deps.describe(windowId) : undefined;
  const target = found !== undefined ? partyOf(found) : undefined;
  const now = deps.now();
  const outcome: { value: unknown } = { value: {} };
  await updateLedger(
    caller.projectRoot,
    (open) => {
      const handlers: Record<string, () => Outcome> = {
        add: () => add(caller, args, open, now),
        split: () => split(caller, args, open, now),
        assign: () => assign(caller, args, open, now, target),
        verdict: () => verdict(caller, args, open, now),
        close: () => close(caller, args, open, now),
        cancel: () => cancel(caller, args, open, now),
      };
      const done = (handlers[action] ?? (() => ({ tasks: [...open], result: {} })))();
      outcome.value = done.result;
      return { tasks: withRollup(done.tasks, now) };
    },
    deps.now,
  );
  return outcome.value;
}

export async function executeTasksTool(
  caller: TaskToolCaller,
  args: Args,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const action = args["action"];
  if (typeof action !== "string" || !(TASK_ACTIONS as readonly string[]).includes(action)) {
    return fail(`action 只能是 ${TASK_ACTIONS.join("、")}。`);
  }
  const named = action as TaskAction;
  const isManager = caller.role === "manager";
  if (WRITE_ACTIONS.includes(named) && !(isManager && deps.isManagerGranted(caller.id))) {
    return fail("只有现任管理者能改任务账本。");
  }
  if (named === "verdict" && caller.role !== "reviewer" && !isManager) {
    return fail("只有检查窗口和管理者能写结论。");
  }
  if (named === "list" && !["manager", "worker", "reviewer", "supervisor"].includes(caller.role)) {
    return fail("这个角色用不到任务账本。");
  }
  try {
    return ok(named === "list" ? await list(caller) : await change(named, caller, args, deps));
  } catch (error) {
    if (error instanceof TaskError) {
      return fail(error.message);
    }
    throw error;
  }
}

// ---------- 自动记账（计划 §9）：开窗派活、汇报到达时由平台改账本 ----------

export interface AutoBookResult {
  readonly ok: boolean;
  readonly note?: string;
}

/**
 * 开窗成功后把任务标成执行中、记下负责窗口和说明路径。
 * 记不了账不影响开窗：失败只返回一句说明，由调用方附在结果里。
 */
export async function bookAssignment(input: {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly assignee: { readonly windowId: string; readonly title: string; readonly role: string };
  readonly briefPath?: string;
  readonly byTitle: string;
  readonly now: () => number;
}): Promise<AutoBookResult> {
  let note: string | undefined;
  try {
    await updateLedger(
      input.projectRoot,
      (open) => {
        const task = open.find((item) => item.id === input.taskId);
        if (task === undefined) {
          note = `账本里没有任务 ${input.taskId}，这次开窗没有记账。`;
          return { tasks: [...open] };
        }
        if (task.status !== "todo" && task.status !== "rework") {
          note = `任务 ${task.id} 现在是 ${task.status}，没有改成执行中。`;
          return { tasks: [...open] };
        }
        const moved = applyTransition(
          task,
          "doing",
          input.byTitle,
          `派给「${input.assignee.title}」`,
          input.now(),
        );
        if (!moved.ok) {
          note = moved.error;
          return { tasks: [...open] };
        }
        const next = {
          ...moved.task,
          assignee: input.assignee,
          ...(input.briefPath !== undefined ? { brief: input.briefPath } : {}),
        };
        return {
          tasks: open.map((item) => (item.id === next.id ? next : item)),
        };
      },
      () => input.now(),
    );
  } catch (error) {
    note = `任务记账失败：${error instanceof Error ? error.message : String(error)}`;
  }
  return note === undefined ? { ok: true } : { ok: false, note };
}

/**
 * 执行者汇报到账：working → 执行中，blocked → 卡住，done → 待检查，failed → 失败。
 * 不叫醒任何人、不改谁有权判定；结账仍由检查者和管理者做。失败不影响汇报。
 */ export async function bookReport(input: {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly status: "progress" | "blocked" | "done" | "failed";
  readonly reporter: { readonly windowId: string; readonly title: string; readonly role: string };
  readonly summary: string;
  readonly now: () => number;
}): Promise<AutoBookResult> {
  const target: TaskStatus =
    input.status === "progress"
      ? "doing"
      : input.status === "blocked"
        ? "blocked"
        : input.status === "done"
          ? "submitted"
          : "failed";
  let note: string | undefined;
  try {
    await updateLedger(
      input.projectRoot,
      (open) => {
        const task = open.find((item) => item.id === input.taskId);
        if (task === undefined) {
          note = `账本里没有任务 ${input.taskId}。`;
          return { tasks: [...open] };
        }
        const progress = input.summary
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 300);
        const base = {
          ...task,
          progress,
          reportedBy: input.reporter,
          updatedAt: input.now(),
        };
        if (task.status === target) {
          // 执行中反复报进度：只刷新执行情况，不再往时间线里堆同一种事件
          return {
            tasks: open.map((item) => (item.id === base.id ? base : item)),
          };
        }
        const moved = applyTransition(
          base,
          target,
          input.reporter.title,
          progress === "" ? "汇报" : progress,
          input.now(),
        );
        if (!moved.ok) {
          note = moved.error;
          return { tasks: [...open] };
        }
        return { tasks: open.map((item) => (item.id === moved.task.id ? moved.task : item)) };
      },
      () => input.now(),
    );
  } catch (error) {
    note = `任务记账失败：${error instanceof Error ? error.message : String(error)}`;
  }
  return note === undefined ? { ok: true } : { ok: false, note };
}

/** 管理者每轮开始时看的一行：未完成几条、有几条要它处理。 */
export async function summarizeForManager(projectRoot: string): Promise<string | undefined> {
  try {
    const { tasks, recovered } = await readOpenLedger(projectRoot);
    const open = tasks.filter((task) => isTaskOpen(task.status));
    const waiting = open.filter((task) =>
      ["failed", "blocked", "submitted", "rework"].includes(task.status),
    );
    if (open.length === 0) {
      return recovered ? "任务账本文件坏了，已用备份恢复；现在没有未完成的任务。" : undefined;
    }
    const first = sortForManager(waiting.length > 0 ? waiting : open)[0];
    const head =
      waiting.length > 0
        ? `任务账本：未完成 ${open.length} 条，其中 ${waiting.length} 条要你处理`
        : `任务账本：未完成 ${open.length} 条`;
    return first === undefined
      ? head
      : `${head}，最先看 ${first.id}「${first.title}」（${first.status}）。查账用 ffpane_tasks action=list。`;
  } catch {
    return undefined;
  }
}

/** 交接消息里带的未完成清单：只列标题、状态、负责人，最多 20 行，超出指向账本.md。 */
export async function ledgerListForManager(projectRoot: string): Promise<string | undefined> {
  try {
    const { tasks } = await readOpenLedger(projectRoot);
    const open = sortForManager(tasks.filter((task) => isTaskOpen(task.status)));
    if (open.length === 0) {
      return undefined;
    }
    const lines = open.slice(0, 20).map((task) => {
      const who = task.assignee !== undefined ? ` @${task.assignee.title}` : "";
      return `${task.id} [${task.status}] ${task.title}${who}`;
    });
    const more = open.length > 20 ? `；还有 ${open.length - 20} 条，看 .ffpane/tasks/账本.md` : "";
    return `未完成 ${open.length} 条：${lines.join("；")}${more}`;
  } catch {
    return undefined;
  }
}
