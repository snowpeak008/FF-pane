/**
 * 审查材料组装（T7.2，设计文档 §3.1）：把「任务合同的验收标准 + 本次 Run 的 diff」
 * 渲染成 Reviewer 一轮的第 4 层输入文本。
 *
 * 纯函数：无 IO、无时钟——同一个 (任务, Run) 恒渲染出同一段文本（可快照）。
 *
 * ## 为什么不复用 assemblePrompt 的 `{ kind: "task" }` 分支
 * 那个分支渲染的是**执行指令**（"你只能改这些路径、禁止这些事"），对审查者是错的输入：
 * 它会把审查者往"我该去做点什么"的方向带，而审查者要的是"这些标准满足了没有"。
 * 二者共用一个渲染只能靠加 if 分叉，最后两种读者的措辞混在一个函数里各自将就。
 *
 * ## 只给 Run 的证据，不给 raw.log
 * §10.4 的红线（密钥、原始日志不进跨 Agent 交接）在这里同样成立，且理由更直接：
 * 原始日志是命令流与 stdout 的宿主，体积不可控且极易夹带密钥回显。审查所需的是
 * 结构化证据——改了哪些文件（diff）、跑了哪些命令（退出码）、验证命令过没过。
 */

import type { Run, TaskContract } from "@ff-pane/shared";

/** assembleReviewMaterial 入参。 */
export interface ReviewMaterialInput {
  /** 被审查的任务合同（验收标准的来源，§6.2）。 */
  readonly task: TaskContract;
  /** 被审查的那一次执行（证据的来源，§6.4）。 */
  readonly run: Run;
  /**
   * 全部 diff 合并文本上限（字符）。超出则按文件截断并如实标注截断了几个文件。
   * 缺省 {@link DEFAULT_DIFF_BUDGET}。
   */
  readonly diffBudget?: number;
}

/**
 * diff 文本预算缺省值（字符）。
 *
 * 一次大改动的 diff 能到几十万字符，整段塞进提示词会让审查轮直接撞上下文上限——
 * 那不是"审查得不够细"，而是**整轮起不来**，连 inconclusive 都拿不到。故设预算，
 * 并且截断这件事一定要在文本里写明：一个不知道自己只看到一半 diff 的审查者，
 * 会对没看到的那一半给出"未发现问题"。
 */
export const DEFAULT_DIFF_BUDGET = 60_000;

function renderList(items: readonly string[], emptyText: string): string {
  return items.length === 0 ? emptyText : items.map((item) => `- ${item}`).join("\n");
}

/**
 * 按预算逐文件收纳 diff。整文件收或整文件不收（不切半个 hunk：半个 hunk 比没有更坏，
 * 它看起来像一段完整的改动）。返回收纳的文本块与被略过的文件数。
 */
function renderFileChanges(
  run: Run,
  budget: number,
): { readonly text: string; readonly omitted: number } {
  if (run.fileChanges.length === 0) {
    return { text: "（本次执行没有产生文件修改）", omitted: 0 };
  }
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const change of run.fileChanges) {
    const block = `### ${change.path}\n\`\`\`diff\n${change.diff}\n\`\`\``;
    if (used + block.length > budget && blocks.length > 0) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  return { text: blocks.join("\n\n"), omitted };
}

/** 渲染审查材料（Reviewer 轮的第 4 层输入）。 */
export function assembleReviewMaterial(input: ReviewMaterialInput): string {
  const { task, run } = input;
  const budget = input.diffBudget ?? DEFAULT_DIFF_BUDGET;
  const changes = renderFileChanges(run, budget);

  const sections: string[] = [
    `## 被审查的任务\n${task.goal}`,
    `## 验收标准（逐条核对）\n${renderList(
      task.acceptance,
      "（该任务没有列出验收标准。此时不要凭感觉判断做得好不好——" +
        "把这件事本身作为 findings 写出来，结论给 inconclusive。）",
    )}`,
    `## 约束与禁止事项\n${renderList(task.forbidden, "（无）")}`,
    `## 允许修改的范围\n${renderList(
      task.writeScope,
      "（合同未限定范围）",
    )}\n\n改动落在范围之外同样是不合格，请一并核对。`,
  ];

  // 完成报告是 Worker 的**自述**，不是证据。措辞上明确这一点，免得审查者拿它当已核实的事实。
  const report = run.report?.trim();
  sections.push(
    `## Worker 的完成报告（它自己的说法，非证据）\n${
      report !== undefined && report.length > 0 ? report : "（未给出报告）"
    }`,
  );

  if (task.verifyCmd !== undefined) {
    const verify = run.verifyResult;
    sections.push(
      `## 验证命令\n合同要求：\`${task.verifyCmd}\`\n${
        verify === undefined
          ? "本次执行**没有**验证结果留档。"
          : `本次执行结果：\`${verify.command}\` 退出码 ${verify.exitCode}` +
            `（${verify.exitCode === 0 ? "通过" : "未通过"}）\n\n\`\`\`\n${verify.output}\n\`\`\``
      }\n\n你可以重跑这条验证命令核实；这也是你唯一被允许执行的命令。`,
    );
  }

  sections.push(
    `## 执行过的命令\n${
      run.commands.length === 0
        ? "（无）"
        : run.commands.map((c) => `- \`${c.command}\` → 退出码 ${c.exitCode}`).join("\n")
    }`,
  );

  sections.push(
    `## 文件改动（unified diff）\n${changes.text}${
      changes.omitted > 0
        ? `\n\n> 注意：改动过大，另有 ${changes.omitted} 个文件的 diff 未包含在本材料中。` +
          "对没看到的部分不要给出结论——若这影响判断，结论给 inconclusive 并在 findings 中写明。"
        : ""
    }`,
  );

  return sections.join("\n\n");
}
