/**
 * Prompt 第 1 层：角色定义（设计文档 §3.1 / §8.2.2）。
 * 三个内置角色的职责说明是静态文本，直接进系统提示。内容为发给 Agent 的提示词
 * （非 UI 文案，不进语言包）；输出语言由第 4 层的语言指令另行约束。
 * T8.4：自定义角色的第 1 层是其 systemPrompt 原文（resolveRoleDefinition），
 * 内置角色行为逐字不变。
 */

import type { Role, RoleRef } from "@ff-pane/shared";
import { isRole } from "@ff-pane/shared";

/** 内置角色 → 职责说明（Prompt 第 1 层）。 */
export const ROLE_DEFINITIONS: Readonly<Record<Role, string>> = {
  planner:
    "你是规划者（Planner）。职责：与用户讨论需求，把想法收敛成一份可核对的计划（工作合同）——" +
    "包含目标、范围、非目标、约束、已确认决定、任务拆分与验收标准。你是**只读**角色：不修改任何文件，" +
    "也**不要运行任何命令、shell 或工具**（你没有执行权限，尝试执行会被权限层拦截并中断本轮）——" +
    "仅依据对话、项目记忆与已注入的上下文进行规划；把不确定的地方明确列出来与用户澄清，不擅自假设。",
  worker:
    "你是执行者（Worker）。职责：严格按收到的任务合同执行。你只能修改合同 write_scope 内的文件，" +
    "遵守 forbidden 约束；完成后满足全部验收标准。遇到合同未覆盖的不确定问题，提交结构化澄清请求" +
    "（问题/影响/选项/建议），不擅自扩大范围、不和其他 Agent 私下商量。",
  reviewer:
    "你是审查者（Reviewer）。职责：对照任务的验收标准与实际改动审查产出，给出通过或不通过的明确结论及理由。" +
    "你只读项目并可运行验证命令，不修改任何文件。",
};

/**
 * 解析一轮的角色定义文本（Prompt 第 1 层，T8.4）：内置角色查 ROLE_DEFINITIONS
 * （逐字不变），自定义角色用其 systemPrompt 原文（customDefinition，来自
 * CustomRole.systemPrompt）。自定义角色缺定义即抛错——空的第 1 层是一个
 * 静默降级的角色，宁可当场失败（校验器本已保证非空，此处把住装配边界）。
 */
export function resolveRoleDefinition(role: RoleRef, customDefinition?: string): string {
  if (isRole(role)) {
    return ROLE_DEFINITIONS[role];
  }
  const trimmed = customDefinition?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new Error(`resolveRoleDefinition: 自定义角色 ${role} 未提供角色提示词（Prompt 第 1 层）`);
  }
  return trimmed;
}
