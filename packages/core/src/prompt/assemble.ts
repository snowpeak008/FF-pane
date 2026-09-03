/**
 * Prompt 组装层 v1（T4.1，设计文档 §8.2.2）：四层固定层序拼装系统提示。
 *
 *   第 1 层  角色定义（roles.ts）
 *   第 2 层  用户习惯档案（M1 留空位；Phase 5 T5.2 接入编译产物）
 *   第 3 层  项目记忆注入（inject.ts，按角色策略 + 条数上限）
 *   第 4 层  当前输入（用户消息 / 任务合同）
 *   末尾     输出语言指令（language.ts，三级级联结果）
 *
 * 纯函数：无 IO、无 Electron、无时钟依赖，组装结果可快照。真实发送到适配器由 T4.2 接线
 * （AdapterTurnContext.prompt）。
 */

import type { AiOutputLanguageSettings, MemoryEntry, RoleRef, TaskContract } from "@ff-pane/shared";
import {
  DEFAULT_INJECTION_LIMIT,
  renderMemoryEntry,
  selectMemoryForRole,
  truncateByPriority,
} from "./inject.js";
import { outputLanguageInstruction, resolveOutputLanguage } from "./language.js";
import { resolveRoleDefinition } from "./roles.js";

/** 第 4 层当前输入：用户消息（Planner 讨论）或任务合同（Worker/Reviewer 执行）。 */
export type PromptInput =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "task"; readonly contract: TaskContract };

/** 组装入参。 */
export interface AssemblePromptParams {
  readonly role: RoleRef;
  /** 自定义角色的提示词原文（Prompt 第 1 层，T8.4）；内置角色缺省。 */
  readonly customRoleDefinition?: string;
  readonly input: PromptInput;
  /** active 项目记忆条目（decision / rule / lesson）。 */
  readonly projectMemory: readonly MemoryEntry[];
  /** memory/state.md 当前状态快照文本（可选，Planner 注入进第 3 层）。 */
  readonly stateSnapshot?: string;
  /** AI 输出语言三级设置（全局→Profile→项目）。 */
  readonly outputLanguage: AiOutputLanguageSettings;
  /** 习惯档案编译文本（M1 留空；缺省即第 2 层为占位）。 */
  readonly habitProfile?: string;
  /** 注入条数上限（缺省 DEFAULT_INJECTION_LIMIT）。 */
  readonly injectionLimit?: number;
}

/** 渲染任务合同为第 4 层文本（Worker/Reviewer）。 */
function renderTaskContract(contract: TaskContract): string {
  const lines: string[] = [`任务目标：${contract.goal}`];
  if (contract.writeScope.length > 0) {
    lines.push(`可写范围（仅这些路径可改）：${contract.writeScope.join("、")}`);
  }
  if (contract.forbidden.length > 0) {
    lines.push(`禁止事项：${contract.forbidden.join("；")}`);
  }
  if (contract.acceptance.length > 0) {
    lines.push(`验收标准：\n${contract.acceptance.map((a) => `- ${a}`).join("\n")}`);
  }
  if (contract.verifyCmd !== undefined) {
    lines.push(`验证命令：${contract.verifyCmd}`);
  }
  return lines.join("\n");
}

function renderInput(input: PromptInput): string {
  return input.kind === "message" ? input.text : renderTaskContract(input.contract);
}

/** 组装 Prompt（四层 + 语言指令），返回可直接作为系统提示的整段文本。 */
export function assemblePrompt(params: AssemblePromptParams): string {
  const task = params.input.kind === "task" ? params.input.contract : undefined;
  const limit = params.injectionLimit ?? DEFAULT_INJECTION_LIMIT;

  const selected = truncateByPriority(
    selectMemoryForRole(params.role, params.projectMemory, task),
    limit,
  );
  const memoryLines = selected.map(renderMemoryEntry);
  // Planner 额外注入 state.md 快照（§8.1：Planner 注入 decision + rule + state）
  if (params.role === "planner" && params.stateSnapshot !== undefined) {
    const snapshot = params.stateSnapshot.trim();
    if (snapshot.length > 0) {
      memoryLines.push(`- [state] 当前状态：${snapshot}`);
    }
  }

  const habit = params.habitProfile?.trim();
  const language = resolveOutputLanguage(params.outputLanguage);

  const sections: string[] = [
    `# 角色\n${resolveRoleDefinition(params.role, params.customRoleDefinition)}`,
    `# 用户习惯\n${habit !== undefined && habit.length > 0 ? habit : "（暂无）"}`,
    `# 项目记忆\n${memoryLines.length > 0 ? memoryLines.join("\n") : "（暂无）"}`,
    `# 当前输入\n${renderInput(params.input)}`,
    outputLanguageInstruction(language),
  ];
  return sections.join("\n\n");
}
