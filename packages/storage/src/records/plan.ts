/**
 * Plan 读写（W1.2b）：plans/plan-v<N>.meta.json + plans/plan-v<N>.md 双文件。
 *
 * 取舍说明（对设计文档 §8.4「Markdown 是真实数据源」的有意让位）：
 * - meta.json 是权威数据：Plan 是可核对的合同（§6.1），scope / tasks / acceptance
 *   等字段是逐条结构化数据，且 tasks 内嵌完整 TaskContract（write_scope、depends_on
 *   等机读字段）。若以 Markdown 为真实源，读取就要解析人手可改的自由文本来还原
 *   结构——解析歧义会直接破坏「合同」的可核对性。结构保真优先，故权威数据落
 *   meta.json，读取一律以它为准。
 * - md 是渲染视图：§8.4 的初衷（任意编辑器可看、git diff 可审、卸载后可用）由
 *   plan-v<N>.md 承担——savePlan 每次由结构化字段确定性渲染出人类可读的
 *   目标 / 范围 / 非目标 / 约束 / 决策 / 任务 / 验收各节，供审阅与提交 Git。
 * - 写入顺序：先 meta（权威）后 md（视图），两者各自原子写。中途崩溃最坏情况是
 *   视图落后于权威数据，不产生权威数据损坏；loadPlan 校验 md 存在性，缺失或
 *   不可读只发警告不阻塞（重新 savePlan 即可补齐视图）。
 */

import { join } from "node:path";
import type { Plan, PlanVersion, TaskContract } from "@ff-pane/shared";
import { isPlanStatus } from "@ff-pane/shared";
import type { ProjectLayout } from "../fs/index.js";
import { readJson, readText, writeJsonAtomic, writeTextAtomic } from "../fs/index.js";
import type { PlanViewWarning, RecordResult } from "./errors.js";
import { StorageInvalidRecordError } from "./errors.js";
import { planMdFileName, planMetaFileName } from "./file-names.js";

/** savePlan 落盘的两个文件路径。 */
export interface SavedPlanFiles {
  /** plan-v<N>.md —— 渲染视图。 */
  readonly mdFile: string;
  /** plan-v<N>.meta.json —— 权威数据。 */
  readonly metaFile: string;
}

/** loadPlan 的成功载荷：权威数据 + 视图健康度警告（可能为空）。 */
export interface LoadedPlan {
  readonly plan: Plan;
  /** 视图（.md）缺失 / 不可读的警告；不影响 plan 数据完整性。 */
  readonly warnings: readonly PlanViewWarning[];
}

/** 计划版本合法性检查：版本必须是 ≥1 的整数（§6.1：v1, v2, v3…）。 */
function planVersionProblem(version: number): string | undefined {
  if (!Number.isSafeInteger(version) || version < 1) {
    return `计划版本必须是 ≥1 的整数，实际为 ${String(version)}`;
  }
  return undefined;
}

function renderItems(items: readonly string[], indent: string): string[] {
  if (items.length === 0) {
    return [`${indent}（无）`];
  }
  return items.map((item) => `${indent}- ${item}`);
}

function renderTaskContract(contract: TaskContract): string[] {
  const lines: string[] = [`### ${contract.id}：${contract.goal}`, ""];
  lines.push(`- 所属计划版本：v${contract.planVersion}`);
  lines.push(
    `- 依赖任务：${contract.dependsOn.length === 0 ? "无" : contract.dependsOn.join("、")}`,
  );
  lines.push(
    `- 注入记忆条目：${contract.contextRefs.length === 0 ? "无" : contract.contextRefs.join("、")}`,
  );
  lines.push(
    `- 验证命令：${contract.verifyCmd === undefined ? "无" : `\`${contract.verifyCmd}\``}`,
  );
  lines.push("- 允许写入路径：");
  lines.push(...renderItems(contract.writeScope, "  "));
  lines.push("- 禁止事项：");
  lines.push(...renderItems(contract.forbidden, "  "));
  lines.push("- 验收标准：");
  lines.push(...renderItems(contract.acceptance, "  "));
  return lines;
}

/**
 * 由结构化 Plan 确定性渲染人类可读 Markdown（plan-v<N>.md 的全部内容）。
 * 各节与设计文档 §6.1 字段一一对应；时间戳按 UTC ISO 8601 渲染以保证确定性。
 */
export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [
    `# 计划 v${plan.version}`,
    "",
    `> 本文件由 ${planMetaFileName(plan.version)} 渲染生成，仅供阅读与 git diff 审阅。`,
    "> 权威数据以 meta.json 为准，请勿手工编辑本文件。",
    "",
    `- 状态：${plan.status}`,
  ];
  if (plan.approvedBy !== undefined) {
    lines.push(`- 批准：${plan.approvedBy.by}（${new Date(plan.approvedBy.at).toISOString()}）`);
  }
  lines.push("", "## 目标", "", plan.goal, "");
  lines.push("## 范围", "", ...renderItems(plan.scope, ""), "");
  lines.push("## 非目标", "", ...renderItems(plan.nonGoals, ""), "");
  lines.push("## 约束", "", ...renderItems(plan.constraints, ""), "");
  lines.push("## 决策", "", ...renderItems(plan.decisions, ""), "");
  lines.push("## 任务", "");
  if (plan.tasks.length === 0) {
    lines.push("（无）", "");
  } else {
    for (const contract of plan.tasks) {
      lines.push(...renderTaskContract(contract), "");
    }
  }
  lines.push("## 验收", "", ...renderItems(plan.acceptance, ""), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 保存计划：一次更新两个文件（先权威 meta.json 后视图 md，顺序理由见模块注释）。
 * 版本非法（非 ≥1 整数）抛 StorageInvalidRecordError；写入失败抛 StorageFsError 子类。
 */
export async function savePlan(layout: ProjectLayout, plan: Plan): Promise<SavedPlanFiles> {
  const versionProblem = planVersionProblem(plan.version);
  if (versionProblem !== undefined) {
    throw new StorageInvalidRecordError(layout.plansDir, "version", versionProblem);
  }
  const metaFile = join(layout.plansDir, planMetaFileName(plan.version));
  const mdFile = join(layout.plansDir, planMdFileName(plan.version));
  await writeJsonAtomic(metaFile, plan);
  await writeTextAtomic(mdFile, renderPlanMarkdown(plan));
  return { mdFile, metaFile };
}

/**
 * 读取计划：以 meta.json 为权威数据源；校验 status 字面量与版本一致性；
 * 校验 md 视图存在性——缺失 / 不可读仅附加警告，不阻塞读取。
 */
export async function loadPlan(
  layout: ProjectLayout,
  version: PlanVersion,
): Promise<RecordResult<LoadedPlan>> {
  const versionProblem = planVersionProblem(version);
  if (versionProblem !== undefined) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(layout.plansDir, "version", versionProblem),
    };
  }
  const metaFile = join(layout.plansDir, planMetaFileName(version));
  const metaResult = await readJson<Plan>(metaFile);
  if (!metaResult.ok) {
    return metaResult;
  }
  const plan = metaResult.value;
  if (!isPlanStatus(plan.status)) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        metaFile,
        "status",
        `计划状态非法: ${JSON.stringify(plan.status)}`,
      ),
    };
  }
  if (plan.version !== version) {
    return {
      ok: false,
      error: new StorageInvalidRecordError(
        metaFile,
        "version",
        `文件内版本 ${JSON.stringify(plan.version)} 与文件名版本 v${version} 不一致`,
      ),
    };
  }

  const warnings: PlanViewWarning[] = [];
  const mdFile = join(layout.plansDir, planMdFileName(version));
  const mdResult = await readText(mdFile);
  if (!mdResult.ok) {
    warnings.push(
      mdResult.error.code === "not-found"
        ? {
            code: "plan-md-missing",
            path: mdFile,
            message: `计划视图缺失（重新保存计划即可补齐）: ${mdFile}`,
          }
        : {
            code: "plan-md-unreadable",
            path: mdFile,
            message: `计划视图读取失败（${mdResult.error.message}）`,
          },
    );
  }
  return { ok: true, value: { plan, warnings } };
}
