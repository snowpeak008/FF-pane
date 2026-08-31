/**
 * Handoff 交接包组装（T7.1，设计文档 §10.4）。
 *
 * 场景：用户换一个 Agent 继续同一个项目。这不是会话恢复——新 Agent 没有、也不可能有
 * 旧 Agent 的会话记录（会话正文归 Agent 自己，§10.2 规则 3）。设计文档的立场是
 * **不伪装成会话恢复**（§2 表"跨 Agent 用交接包（Handoff），不伪装成会话恢复"），
 * 而是把工作台确有登记的事实精简成一份 8 字段交接包，明说这是一次交接。
 *
 * 纯函数：无 IO、无时钟、无随机。输入由编排层从 storage 读齐后传入。
 *
 * **红线（§4.3 规则 2 / §10.4）——密钥、原始日志、其他项目内容永不进入交接包。**
 * 这里的落法不是"生成后再扫一遍关键词"（那种事后过滤既漏且给人虚假的安全感），而是
 * **取材源里物理不含这三类**：入参只有本项目的计划、任务、项目记忆三样，
 * 既不接收 Run（`raw.log` 的宿主）、也不接收任何跨项目句柄、更不认识密钥模块。
 * 想让密钥进交接包，得先改本函数的签名——那是一次显眼的改动，而不是一次静默的疏漏。
 */

import type { Handoff, HandoffTaskProgress, MemoryEntry, Plan, Task } from "@ff-pane/shared";

/** buildHandoff 的入参（除 tasks/memory 外全部可缺省，缺省即该维度无可交接事实）。 */
export interface HandoffInput {
  /**
   * 项目目标（§10.4 project_goal，"一段话"）。
   * 缺省时取当前计划的 goal——计划的目标就是当前这一轮工作的目标，
   * 而工作台并无独立的"项目目标"字段（§10.2 project.json 里没有这一项）。
   */
  readonly projectGoal?: string;
  /**
   * 当前计划（通常取最新版本）。缺省 = 尚无计划。
   * 注：`Handoff.plan` 在类型上是可选的，理由见 shared/domain/handoff.ts 的注释。
   */
  readonly plan?: Plan;
  /** 项目任务（全量；本函数按状态归纳，不在意入参顺序）。 */
  readonly tasks?: readonly Task[];
  /** 项目记忆（全量；本函数自行按状态与类别筛选，调用方不必预筛）。 */
  readonly memory?: readonly MemoryEntry[];
  /**
   * 额外的未决问题（§10.4 open_issues）。本函数会先从任务状态派生一批
   * （blocked / failed），再把这里的补充项接在后面。
   */
  readonly extraOpenIssues?: readonly string[];
  /**
   * 期望接收方接下来做什么（§10.4 expectation）。
   * 缺省时按任务状态派生一句——见 deriveExpectation。
   */
  readonly expectation?: string;
  /** recent_lessons 取样条数上限（缺省 DEFAULT_RECENT_LESSONS）。 */
  readonly maxRecentLessons?: number;
}

/**
 * recent_lessons 默认取样条数。
 * 取"最近若干条"而非全部：§10.4 的原则是"字段越多越没人看"，而 lesson 是三类记忆里
 * 增长最快的一类（每个被接受的任务都可能沉淀一条，见 T4.4）。decision 与 rule 不设上限
 * ——它们是接手方**必须遵守**的约束，漏掉一条的代价与漏掉一条经验完全不是一个量级。
 */
export const DEFAULT_RECENT_LESSONS = 5;

/** 只有 active 的记忆进交接包：candidate 尚未经用户确认（§8.1），archived 已被判定过时。 */
function activeOf(
  memory: readonly MemoryEntry[],
  category: MemoryEntry["category"],
): readonly MemoryEntry[] {
  return memory.filter((entry) => entry.status === "active" && entry.category === category);
}

/** 按 updatedAt 降序取前 n 条（同值按 id 升序，保证可快照）。 */
function recentFirst(entries: readonly MemoryEntry[], limit: number): readonly MemoryEntry[] {
  return [...entries]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

/**
 * 从任务状态派生未决问题（§10.4 open_issues"阻塞与未决问题"）。
 *
 * blocked = Worker 提了澄清请求还没被回答（§6.5），failed = 执行失败尚未重试成功；
 * 两者都是"接手方一上来就会撞上"的东西，必须显式列出。done 不算未决——它只差用户验收，
 * 那是用户的动作不是接手方的；cancelled 更不算。
 */
function deriveOpenIssues(tasks: readonly Task[]): readonly string[] {
  const issues: string[] = [];
  for (const task of tasks) {
    if (task.status === "blocked") {
      issues.push(`任务 ${task.id} 阻塞（等待澄清）：${task.goal}`);
    } else if (task.status === "failed") {
      issues.push(`任务 ${task.id} 执行失败，尚未重试成功：${task.goal}`);
    }
  }
  return issues;
}

/**
 * 派生 expectation（§10.4"期望接收方接下来做什么"）。
 *
 * 这一句是交接包里唯一带**指令性**的字段，宁可保守也不要指错方向：
 * 有可动工的 pending 任务就指名第一条；只剩阻塞就先解阻塞；任务都进终态就交回用户决定；
 * 连任务都没有（如计划尚未批准物化）就说明现状，让接手方先与用户对齐，而不是自行开工。
 */
function deriveExpectation(plan: Plan | undefined, tasks: readonly Task[]): string {
  const runnable = tasks.filter((task) => task.status === "pending" || task.status === "running");
  const first = runnable[0];
  if (first !== undefined) {
    const verb = first.status === "running" ? "接手执行中的" : "从";
    return `${verb}任务 ${first.id}「${first.goal}」继续；开工前请先复述你对当前计划与约束的理解，等用户确认。`;
  }
  const stuck = tasks.filter((task) => task.status === "blocked" || task.status === "failed");
  if (stuck.length > 0) {
    return `当前无可直接开工的任务，请先与用户一起处理上述 ${stuck.length} 项阻塞/失败，再谈继续执行。`;
  }
  if (tasks.length > 0) {
    return "计划内任务均已进入终态，请与用户确认下一步做什么，不要自行开新工作。";
  }
  return plan === undefined
    ? "工作台侧尚无计划与任务，请先与用户讨论目标并产出计划草案。"
    : "计划已存在但尚未拆出任务，请与用户确认后再拆分任务。";
}

/**
 * 组装交接包。
 *
 * 刻意**不做**的一件事：不把"当前正在讨论的话题"塞进来。工作台不持久化会话正文
 * （§10.2 规则 3），能拿到的只有流式缓存里那半截文本——把它当事实交接出去，
 * 就是在替接手方臆造上下文。交接包只交接工作台确有登记的东西。
 */
export function buildHandoff(input: HandoffInput): Handoff {
  const tasks = input.tasks ?? [];
  const memory = input.memory ?? [];
  const maxRecentLessons = input.maxRecentLessons ?? DEFAULT_RECENT_LESSONS;

  const progress: readonly HandoffTaskProgress[] = tasks.map((task) => ({
    taskId: task.id,
    goal: task.goal,
    status: task.status,
  }));

  const projectGoal = (input.projectGoal ?? input.plan?.goal ?? "").trim();
  const openIssues = [...deriveOpenIssues(tasks), ...(input.extraOpenIssues ?? [])].filter(
    (issue) => issue.trim().length > 0,
  );
  const expectation = input.expectation?.trim();

  return {
    projectGoal,
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    progress,
    decisions: activeOf(memory, "decision"),
    rules: activeOf(memory, "rule"),
    recentLessons: recentFirst(activeOf(memory, "lesson"), maxRecentLessons),
    openIssues,
    expectation:
      expectation !== undefined && expectation.length > 0
        ? expectation
        : deriveExpectation(input.plan, tasks),
  };
}
