/**
 * 计划版本 diff（W3.5b）：把结构化 Plan 渲染成稳定文本，再做行级 LCS diff，
 * 产出带 +/- 前缀的统一 diff 文本，交 DiffView 着色渲染。纯逻辑，可单测。
 */

import type { Plan } from "@ff-pane/shared";

/** 一个条目列表小节渲染为「标题:」+ 每项一行「- item」。 */
function section(title: string, items: readonly string[]): readonly string[] {
  return [`${title}:`, ...items.map((item) => `- ${item}`), ""];
}

/**
 * 计划 → 稳定多行文本（用于版本 diff；与展示层无关，字段顺序固定）。
 * 不含 version/status（diff 关注内容变化，元信息在标题栏另行展示）。
 */
export function planToText(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Goal: ${plan.goal}`, "");
  lines.push(...section("Scope", plan.scope));
  lines.push(...section("Non-goals", plan.nonGoals));
  lines.push(...section("Constraints", plan.constraints));
  lines.push(...section("Decisions", plan.decisions));
  lines.push(
    ...section(
      "Tasks",
      plan.tasks.map((task) =>
        task.writeScope.length > 0 ? `${task.goal} [${task.writeScope.join(", ")}]` : task.goal,
      ),
    ),
  );
  lines.push(...section("Acceptance", plan.acceptance));
  return lines.join("\n").trimEnd();
}

/**
 * 行级 LCS diff：返回带前缀（" " 未变 / "-" 删除 / "+" 新增）的统一 diff 文本。
 * O(m·n) 动态规划，计划文本行数有限，足够。
 */
export function diffLines(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const w = n + 1;

  // dp[i*w+j] = a[i..] 与 b[j..] 的最长公共子序列长度（扁平数组，避免可选链噪声）
  const dp = new Int32Array((m + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0;
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < m) {
    out.push(`-${a[i]}`);
    i += 1;
  }
  while (j < n) {
    out.push(`+${b[j]}`);
    j += 1;
  }
  return out.join("\n");
}

/** 便捷：两版计划的内容 diff 文本。 */
export function planVersionDiff(oldPlan: Plan, newPlan: Plan): string {
  return diffLines(planToText(oldPlan), planToText(newPlan));
}
