/**
 * 角色与 Agent Profile（设计文档 §3.1、§4.4）。
 * Profile 公式：Runtime + Provider + 模型 + 默认角色 + 权限预设 + 输出语言。
 * T8.4 起增加自定义角色（§3.1「一段角色提示词 + 一套默认权限」，M3 条目）。
 */

import type {
  CustomRoleId,
  EpochMillis,
  ModelId,
  ProfileId,
  ProviderId,
  RuntimeId,
} from "./common.js";
import { createLiteralGuard } from "./common.js";
import type { AiOutputLanguage } from "./language.js";
import type { PermissionEnvelope } from "./permission.js";

/**
 * 设计文档 §3.1 —— 内置角色（三个，不再多）：
 * planner 必须；worker 必须；reviewer 可选，默认关闭。
 * 内置角色保持闭合联合——计划生成 / 任务派发 / 审查三条结构化管线只认它们；
 * 自定义角色（T8.4）经 RoleRef 联合扩展，不动本联合。
 */
export const ROLES = ["planner", "worker", "reviewer"] as const;

/** 设计文档 §3.1 —— 内置角色。 */
export type Role = (typeof ROLES)[number];

/** Role 运行时守卫。 */
export const isRole = createLiteralGuard(ROLES);

/** 自定义角色 ID 的可读前缀（生成与运行时判别共用，见 isCustomRoleId）。 */
export const CUSTOM_ROLE_ID_PREFIX = "role-";

/**
 * CustomRoleId 运行时守卫：`role-` 前缀即自定义角色 ID。
 * 与内置角色字面量（planner/worker/reviewer）无前缀冲突，因此 RoleRef 在
 * JSON 边界只需这一个判别；ID 由存储层生成（前缀 + 随机段），用户不可自造。
 */
export function isCustomRoleId(value: unknown): value is CustomRoleId {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOM_ROLE_ID_PREFIX) &&
    value.length > CUSTOM_ROLE_ID_PREFIX.length
  );
}

/**
 * 角色引用（T8.4）：内置角色字面量或自定义角色 ID 的联合。
 * 跨层 role 字段（SessionRecord / TranscriptEntry / InflightTurnMarker /
 * ActiveTurnRecord / session 事件）一律用本类型——旧序列化数据只含内置三字面量，
 * isRoleRef 原样放行，向后兼容无需迁移。
 */
export type RoleRef = Role | CustomRoleId;

/** RoleRef 运行时守卫（JSON / IPC 边界用）。 */
export function isRoleRef(value: unknown): value is RoleRef {
  return isRole(value) || isCustomRoleId(value);
}

/**
 * 设计文档 §3.1 / T8.4 —— 自定义角色：名称 + 角色提示词 + 权限预设。
 * 全局存储（roles.json），与 Profile 经 defaultRole 绑定。权限预设充当该角色的
 * 「角色默认」层，参与信封交集（§7 公式不变，危险操作固定清单物理不可绕过——
 * 预设经 core 校验器把关，信封第 5 项类型恒 true）。
 */
export interface CustomRole {
  /** 内部唯一 ID（`role-` 前缀 + 随机段，存储层生成）。 */
  readonly id: CustomRoleId;
  /** 显示名（用户自由起名，允许重复，与 Provider/Profile name 同规）。 */
  readonly name: string;
  /** 角色提示词（Prompt 第 1 层原文，发给 Agent；非 UI 文案，不进语言包）。 */
  readonly systemPrompt: string;
  /** 该角色的默认权限信封（§7 五项；充当信封交集的「角色默认」层）。 */
  readonly permissionPreset: PermissionEnvelope;
  /** 创建时间（epoch 毫秒）。 */
  readonly createdAt: EpochMillis;
  /** 最近修改时间（epoch 毫秒）。 */
  readonly updatedAt: EpochMillis;
}

/**
 * 设计文档 §4.4 —— Agent Profile：用户实际选用的完整运行配置。
 * 项目里的角色绑定即 Role → ProfileId（见 project.ts），换 AI = 换绑定。
 */
export interface AgentProfile {
  /** 内部唯一 ID。 */
  readonly id: ProfileId;
  /** 设计文档 §4.4 —— Profile 显示名（如 "Claude 执行者"）。 */
  readonly name: string;
  /** 设计文档 §4.4 —— Runtime（适配器注册键，如 "claude-code"）。 */
  readonly runtime: RuntimeId;
  /** 设计文档 §4.4 —— 使用的 Provider。 */
  readonly providerId: ProviderId;
  /**
   * 设计文档 §4.4 —— 模型。缺省表示"默认"（示例中 `Model: 默认`），
   * 即使用 Provider 的 default_model。
   */
  readonly model?: ModelId;
  /**
   * 设计文档 §4.4 —— 默认角色。T8.4 起可为自定义角色 ID（Profile 与自定义
   * 角色的绑定就落在本字段——项目角色绑定仍是 内置 Role → ProfileId，见 project.ts）。
   */
  readonly defaultRole: RoleRef;
  /** 设计文档 §4.4 / §7 —— 权限预设（5 项权限信封）。 */
  readonly permissionPreset: PermissionEnvelope;
  /**
   * 设计文档 §4.4 / §9.2 —— 输出语言。缺省表示"跟随全局"
   * （三级设置的 Profile 层不覆盖，见 language.ts）。
   */
  readonly outputLanguage?: AiOutputLanguage;
}
