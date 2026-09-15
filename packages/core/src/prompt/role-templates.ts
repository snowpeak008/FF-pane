/**
 * 自定义角色预填模板（T9.5）：编译期常量，与 ROLE_DEFINITIONS 同居 prompt/。
 * 选中即拷进草稿；不落 templateId，模板本体不可变、无热更新。
 * 提示词是发给 Agent 的第 1 层原文（非 UI 文案，不进语言包）。
 */

import { createLiteralGuard, type PermissionEnvelope } from "@ff-pane/shared";
import { PROJECT_WIDE_SCOPE, ROLE_DEFAULT_ENVELOPES } from "../permission/envelope.js";

/** 5 套稳定模板 id（钉死，禁止另起别名）。 */
export const ROLE_TEMPLATE_IDS = [
  "planner",
  "worker",
  "reviewer",
  "docs-writer",
  "test-engineer",
] as const;

export type RoleTemplateId = (typeof ROLE_TEMPLATE_IDS)[number];

/** RoleTemplateId 运行时守卫。 */
export const isRoleTemplateId = createLiteralGuard(ROLE_TEMPLATE_IDS);

/** 一套预填模板：id + 去合同化提示词 + 权限快照。 */
export interface RoleTemplate {
  readonly id: RoleTemplateId;
  readonly systemPrompt: string;
  readonly permissionPreset: PermissionEnvelope;
}

/**
 * 文档写手权限快照：项目内可读 / 只写 docs/ / 禁 shell / 禁网 / 危险操作须确认。
 * 与三角色不同——三角色必须复用 ROLE_DEFAULT_ENVELOPES，禁止另写会漂的副本。
 */
const DOCS_WRITER_PRESET: PermissionEnvelope = Object.freeze({
  readPaths: Object.freeze([PROJECT_WIDE_SCOPE]),
  writePaths: Object.freeze(["docs/**"]),
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
});

/**
 * 测试工程师权限快照：项目内可读 / 只写 tests/ / 允许 shell / 禁网 / 危险操作须确认。
 */
const TEST_ENGINEER_PRESET: PermissionEnvelope = Object.freeze({
  readPaths: Object.freeze([PROJECT_WIDE_SCOPE]),
  writePaths: Object.freeze(["tests/**"]),
  shell: "allowed",
  network: false,
  dangerousOpsRequireApproval: true,
});

/**
 * 规划者模板提示词：只读澄清、收敛可核对计划。
 * 去合同化改写——不得复述工作台编排术语，也不得与 ROLE_DEFINITIONS.planner 逐字相同。
 */
const PLANNER_TEMPLATE_PROMPT =
  "你是规划者。职责：与用户把想法收敛成一份可核对的计划，写明目标、范围、非目标、" +
  "约束、已确认决定、任务拆分与验收标准。你只读：不改任何文件，也不运行命令、shell 或工具；" +
  "仅依据对话、项目记忆与已注入的上下文规划。不确定处单独列出请用户澄清，不擅自假设。";

/**
 * 执行者模板提示词：守范围执行、验收达标。
 * 去合同化改写——不得复述工作台编排术语，也不得与 ROLE_DEFINITIONS.worker 逐字相同。
 */
const WORKER_TEMPLATE_PROMPT =
  "你是执行者。职责：严格按收到的任务说明执行，只改允许范围内的文件，遵守禁止项；" +
  "完成后满足全部验收标准。遇到说明未覆盖的不确定问题，把问题、影响、可选做法和建议一并写清，" +
  "等用户拍板后再继续。不擅自扩大范围，也不和其他 Agent 私下商量。";

/**
 * 审查者模板提示词：对照验收给出通过 / 不通过。
 * 去合同化改写——不得复述工作台编排术语，也不得与 ROLE_DEFINITIONS.reviewer 逐字相同。
 */
const REVIEWER_TEMPLATE_PROMPT =
  "你是审查者。职责：把实际改动对照验收标准逐项核对，明确判定通过或不通过，并写清理由。" +
  "保持只读：可以跑验证命令，但不要改任何文件。";

/** 文档写手：只动文档，不碰源码 / 配置 / 测试。 */
const DOCS_WRITER_TEMPLATE_PROMPT =
  "你是文档写手。职责：只撰写和修订项目文档，不改源码、配置或测试。" +
  "表述清楚、结构完整；不确定处标出待确认，不擅自扩写范围外的内容。";

/** 测试工程师：以测试为职责，不改产品源码。 */
const TEST_ENGINEER_TEMPLATE_PROMPT =
  "你是测试工程师。职责：为既有行为补充和维护测试，必要时可运行测试命令验证。" +
  "不改产品源码或文档；失败时给出可复现步骤与期望，不擅自扩大改动范围。";

function freezeTemplate(template: RoleTemplate): RoleTemplate {
  return Object.freeze(template);
}

/** 5 套编译期模板（id → 提示词 + 权限快照）。 */
export const ROLE_TEMPLATES: Readonly<Record<RoleTemplateId, RoleTemplate>> = Object.freeze({
  planner: freezeTemplate({
    id: "planner",
    systemPrompt: PLANNER_TEMPLATE_PROMPT,
    permissionPreset: ROLE_DEFAULT_ENVELOPES.planner,
  }),
  worker: freezeTemplate({
    id: "worker",
    systemPrompt: WORKER_TEMPLATE_PROMPT,
    permissionPreset: ROLE_DEFAULT_ENVELOPES.worker,
  }),
  reviewer: freezeTemplate({
    id: "reviewer",
    systemPrompt: REVIEWER_TEMPLATE_PROMPT,
    permissionPreset: ROLE_DEFAULT_ENVELOPES.reviewer,
  }),
  "docs-writer": freezeTemplate({
    id: "docs-writer",
    systemPrompt: DOCS_WRITER_TEMPLATE_PROMPT,
    permissionPreset: DOCS_WRITER_PRESET,
  }),
  "test-engineer": freezeTemplate({
    id: "test-engineer",
    systemPrompt: TEST_ENGINEER_TEMPLATE_PROMPT,
    permissionPreset: TEST_ENGINEER_PRESET,
  }),
});

/** 按稳定 id 取模板（noUncheckedIndexedAccess 下 Record 取值可能是 undefined）。 */
export function getRoleTemplate(id: RoleTemplateId): RoleTemplate {
  const template = ROLE_TEMPLATES[id];
  if (template === undefined) {
    throw new Error(`getRoleTemplate: unknown template id ${id}`);
  }
  return template;
}
