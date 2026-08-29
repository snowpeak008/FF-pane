/**
 * 角色与 Agent Profile（设计文档 §3.1、§4.4）。
 * Profile 公式：Runtime + Provider + 模型 + 默认角色 + 权限预设 + 输出语言。
 */

import type { ModelId, ProfileId, ProviderId, RuntimeId } from "./common.js";
import { createLiteralGuard } from "./common.js";
import type { AiOutputLanguage } from "./language.js";
import type { PermissionEnvelope } from "./permission.js";

/**
 * 设计文档 §3.1 —— 角色（三个，不再多）：
 * planner 必须；worker 必须；reviewer 可选，默认关闭。
 * 自定义角色不进第一阶段（§3.1），故为闭合联合。
 */
export const ROLES = ["planner", "worker", "reviewer"] as const;

/** 设计文档 §3.1 —— 角色。 */
export type Role = (typeof ROLES)[number];

/** Role 运行时守卫。 */
export const isRole = createLiteralGuard(ROLES);

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
  /** 设计文档 §4.4 —— 默认角色。 */
  readonly defaultRole: Role;
  /** 设计文档 §4.4 / §7 —— 权限预设（5 项权限信封）。 */
  readonly permissionPreset: PermissionEnvelope;
  /**
   * 设计文档 §4.4 / §9.2 —— 输出语言。缺省表示"跟随全局"
   * （三级设置的 Profile 层不覆盖，见 language.ts）。
   */
  readonly outputLanguage?: AiOutputLanguage;
}
