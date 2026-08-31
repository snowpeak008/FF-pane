/**
 * 结构化计划生成（T4.6，设计文档 §6.1 / §12）：把 Planner 一轮的自然语言输出
 * 解析成计划草案变更（PlanDraftChanges），供 createInitialDraft / createNextDraft 落库。
 *
 * 纯函数、零 IO：提取答复中的 ```json 计划块 → 校验清洗 → 产出结构化变更。
 * 单一事实来源：Planner 的结构化输出合同（PLAN_OUTPUT_CONTRACT）与解析在同一文件，
 * schema 只在这里定义一次。
 */

import type { PlanVersion, TaskContract, TaskId } from "@ff-pane/shared";
import { extractLastJsonBlock, nonEmptyString, toStringList } from "../text/json-block.js";
import type { PlanDraftChanges } from "./next-draft.js";

/**
 * 追加到 Planner 提示词末尾的"结构化输出合同"：要求模型基于讨论输出唯一一个 JSON 计划块。
 * 与 parsePlannerPlanDraft 的 schema 严格对应（字段名、层级一致）。
 */
export const PLAN_OUTPUT_CONTRACT = `# 生成计划（结构化输出）
基于以上讨论，产出一份可执行的结构化计划。严格遵守：
1. 只输出一个 \`\`\`json 代码块，块内是合法 JSON，块外不要任何文字。
2. JSON 结构如下（字符串数组逐条列出；tasks 为任务合同数组）：
\`\`\`json
{
  "goal": "一句话总目标",
  "scope": ["做什么（逐条）"],
  "nonGoals": ["明确不做什么"],
  "constraints": ["约束与禁止事项"],
  "decisions": ["已确认的关键决定"],
  "acceptance": ["总体验收标准（可核对）"],
  "tasks": [
    {
      "id": "t1",
      "goal": "任务目标",
      "writeScope": ["允许修改的路径模式，如 src/**"],
      "forbidden": ["禁止事项"],
      "dependsOn": ["前置任务的 id"],
      "acceptance": ["该任务验收标准"],
      "verifyCmd": "验证命令（可选，如 npm test）"
    }
  ]
}
\`\`\`
3. tasks 至少一条；每条 id 唯一、goal 非空；dependsOn 只引用本计划内的任务 id。`;

/** 解析结果：成功给出计划变更，失败给出面向用户的中文原因（不写盘）。 */
export type ParsePlanResult =
  | { readonly ok: true; readonly changes: PlanDraftChanges }
  | { readonly ok: false; readonly error: string };

/** 计划草案的占位版本号：createInitialDraft / createNextDraft 落库时会统一重绑。 */
const PLACEHOLDER_VERSION = 1 as PlanVersion;

interface RawTask {
  readonly id?: unknown;
  readonly goal?: unknown;
  readonly writeScope?: unknown;
  readonly forbidden?: unknown;
  readonly dependsOn?: unknown;
  readonly acceptance?: unknown;
  readonly verifyCmd?: unknown;
}

/**
 * 解析任务数组：两趟——先定稿每条 id（模型 id 安全且唯一则用之，否则 t<序号>），
 * 再把 dependsOn 过滤为仅引用本计划内已存在的 id（丢弃悬空引用，容模型噪声）。
 * 缺 goal 的任务丢弃。planVersion 用占位值（落库重绑）。
 */
function parseTasks(value: unknown): TaskContract[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const raws: RawTask[] = value.filter((t): t is RawTask => typeof t === "object" && t !== null);

  // 第一趟：定稿 id + goal，丢弃无 goal 的任务
  const usedIds = new Set<string>();
  const staged: { readonly id: string; readonly raw: RawTask; readonly goal: string }[] = [];
  raws.forEach((raw, index) => {
    const goal = nonEmptyString(raw.goal);
    if (goal === undefined) {
      return;
    }
    const proposed = nonEmptyString(raw.id);
    let id = proposed !== undefined && !usedIds.has(proposed) ? proposed : `t${index + 1}`;
    // 兜底：生成 id 仍冲突（极端情形）则加序号后缀
    while (usedIds.has(id)) {
      id = `${id}_${index + 1}`;
    }
    usedIds.add(id);
    staged.push({ id, raw, goal });
  });

  // 第二趟：dependsOn 只保留指向本计划内已存在 id 的引用
  return staged.map(({ id, raw, goal }) => {
    const dependsOn = toStringList(raw.dependsOn)
      .filter((dep) => usedIds.has(dep) && dep !== id)
      .map((dep) => dep as TaskId);
    const verifyCmd = nonEmptyString(raw.verifyCmd);
    const contract: TaskContract = {
      id: id as TaskId,
      planVersion: PLACEHOLDER_VERSION,
      goal,
      writeScope: toStringList(raw.writeScope),
      forbidden: toStringList(raw.forbidden),
      dependsOn,
      contextRefs: [],
      acceptance: toStringList(raw.acceptance),
      ...(verifyCmd !== undefined ? { verifyCmd } : {}),
    };
    return contract;
  });
}

/**
 * 从 Planner 答复文本解析计划草案变更。
 * 失败（无计划块 / JSON 非法 / 缺目标 / 无有效任务）返回面向用户的中文原因，调用方据此不写盘。
 */
export function parsePlannerPlanDraft(text: string): ParsePlanResult {
  const block = extractLastJsonBlock(text);
  if (block === undefined) {
    return { ok: false, error: "Planner 输出中未找到 JSON 计划块（```json ... ```）" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, error: `计划块 JSON 解析失败：${message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "计划块顶层必须是 JSON 对象" };
  }
  const obj = parsed as Record<string, unknown>;
  const goal = nonEmptyString(obj["goal"]);
  if (goal === undefined) {
    return { ok: false, error: "计划缺少非空的 goal（总目标）" };
  }
  const tasks = parseTasks(obj["tasks"]);
  if (tasks.length === 0) {
    return { ok: false, error: "计划未包含任何有效任务（每条任务需含非空 goal）" };
  }
  return {
    ok: true,
    changes: {
      goal,
      scope: toStringList(obj["scope"]),
      nonGoals: toStringList(obj["nonGoals"]),
      constraints: toStringList(obj["constraints"]),
      decisions: toStringList(obj["decisions"]),
      acceptance: toStringList(obj["acceptance"]),
      tasks,
    },
  };
}
