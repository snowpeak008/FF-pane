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
 * generic-exec 的任务文本投递方式（T8.4b）。镜像 @ff-pane/adapters 的
 * GENERIC_EXEC_TASK_DELIVERIES——shared 不依赖 adapters（依赖方向相反），
 * 而 Profile 领域形状要在 renderer / core / storage 三处流动，故此处自持一份；
 * 两处字面量的一致性由 desktop 装配层单测钉住（session-registry.test.ts）。
 */
export const GENERIC_EXEC_DELIVERIES = ["argv", "stdin"] as const;

/** generic-exec 任务投递方式。 */
export type GenericExecDelivery = (typeof GENERIC_EXEC_DELIVERIES)[number];

/** GenericExecDelivery 运行时守卫（JSON / IPC 边界用）。 */
export const isGenericExecDelivery = createLiteralGuard(GENERIC_EXEC_DELIVERIES);

/**
 * 任务文本占位符（镜像 adapters 的 TASK_PLACEHOLDER，一致性同上由装配层单测钉住）。
 * 只在 args 数组的元素内部做值替换，不参与 command——校验器（core）与适配器
 * （adapters renderGenericExecArgs）对此各自把关。
 */
export const GENERIC_EXEC_TASK_PLACEHOLDER = "{task}";

/**
 * generic-exec Profile 的命令配置（T8.4b，多实例装配）：按适配器构造期选项
 * （GenericExecConfig）反推的最小必填集——command / args / taskDelivery 三项是
 * createGenericExecAdapter 的必填项，其余（cwd / env / timeoutMs / outputFormat 等）
 * 全部保留适配器缺省，需要时再随后续工单扩展。纯 JSON 可序列化（随 Profile 落
 * profiles.json）。校验权威在 core validateProfileDraft（占位符与投递方式的配套等），
 * 装配层再以 adapters 的 validateGenericExecConfig 兜底。
 */
export interface GenericExecProfileConfig {
  /** 命令名或绝对路径（不做 {task} 替换——防止任务文本换掉可执行文件）。 */
  readonly command: string;
  /** 参数模板数组。argv 模式下元素内的 {task} 被任务文本整体值替换。 */
  readonly args: readonly string[];
  /** 任务文本投递方式（argv 替换占位符 / stdin 写入并 EOF）。 */
  readonly taskDelivery: GenericExecDelivery;
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
  /**
   * generic-exec 的命令配置（T8.4b）。仅 runtime === "generic-exec" 时有意义且必填
   * （core 校验器把关：该 runtime 缺配置 / 其他 runtime 带配置均拒绝）；
   * 旧序列化数据不含本字段——它们也不可能是 generic-exec Profile
   * （此前该 runtime 派发必收「Runtime 未注册」，无可用存量），零迁移。
   */
  readonly genericExec?: GenericExecProfileConfig;
  /**
   * T9.4b —— 模型推理强度档。缺省 / 空 = 不传，跟随 CLI 或用户本机配置。
   * 只对白名单 Runtime（{@link REASONING_EFFORT_RUNTIMES}）有意义；
   * 取值须为规范档 {@link REASONING_EFFORT_LEVELS}。旧档缺字段 = 未设置。
   */
  readonly reasoningEffort?: string;
}

/**
 * T9.4b —— 规范档（grok 文档 ∪ claude help ∪ codex 目录主体）。
 * UI 只暴露这些；能读到模型目录再与之求交收窄。`ultra` / grok menu id 第一期不进下拉。
 */
export const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 规范档字面量。 */
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/** ReasoningEffortLevel 运行时守卫。 */
export const isReasoningEffortLevel = createLiteralGuard(REASONING_EFFORT_LEVELS);

/**
 * T9.4b —— 允许非空 `reasoningEffort` 的 Runtime 白名单。
 * 不在名单的 Runtime 带了该字段 → 校验拒存；下发层也不会把它塞进 argv / HTTP。
 */
export const REASONING_EFFORT_RUNTIMES = [
  "codex",
  "claude-code",
  "grok-build",
  "opencode",
] as const;

/** 白名单 Runtime。 */
export type ReasoningEffortRuntime = (typeof REASONING_EFFORT_RUNTIMES)[number];

/** ReasoningEffortRuntime 运行时守卫。 */
export const isReasoningEffortRuntime = createLiteralGuard(REASONING_EFFORT_RUNTIMES);

/**
 * opencode 读不到该模型 effort values 时 UI 隐藏且不下发。
 * 其余白名单 Runtime 无目录时仍显示完整规范档。
 */
export const REASONING_EFFORT_CATALOG_REQUIRED_RUNTIMES = ["opencode"] as const;

/** Run 落档：本轮未下发 effort 时的哨兵（可追溯，不要事后猜）。 */
export const REASONING_EFFORT_UNSET = "unset";

/** 去掉空白；空串与缺省一律视为未设置。 */
export function normalizeReasoningEffort(
  value: string | undefined,
): ReasoningEffortLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return isReasoningEffortLevel(trimmed) ? trimmed : undefined;
}

/**
 * 规范档 ∩ 模型目录（若有）。目录里的非规范值（如 codex `ultra`）第一期丢弃。
 * `catalogLevels === undefined` 表示没读到目录，返回完整规范档。
 */
export function narrowReasoningEffortLevels(
  catalogLevels?: readonly string[],
): readonly ReasoningEffortLevel[] {
  if (catalogLevels === undefined) {
    return REASONING_EFFORT_LEVELS;
  }
  const allowed = new Set(catalogLevels);
  return REASONING_EFFORT_LEVELS.filter((level) => allowed.has(level));
}

/**
 * Profile 编辑器 / 下发共用的可见档位。
 * - 非白名单：不显示（返回空数组）
 * - opencode：必须读到该模型 effort values，否则空（隐藏）
 * - 其余白名单：无目录用完整规范档，有目录则求交
 */
export function resolveReasoningEffortOptions(
  runtime: string,
  catalogLevels?: readonly string[],
): readonly ReasoningEffortLevel[] {
  if (!isReasoningEffortRuntime(runtime)) {
    return [];
  }
  if (
    (REASONING_EFFORT_CATALOG_REQUIRED_RUNTIMES as readonly string[]).includes(runtime) &&
    catalogLevels === undefined
  ) {
    return [];
  }
  return narrowReasoningEffortLevels(catalogLevels);
}

/**
 * 本轮实际下发的档位：白名单 + 非空规范档（再按模型目录收窄）才返回值。
 * opencode 读不到目录 → 不下发。脏数据（非白名单却带了字段）在此被吞掉。
 */
export function resolveDispatchedReasoningEffort(input: {
  readonly runtime: string;
  readonly reasoningEffort?: string | undefined;
  readonly catalogLevels?: readonly string[];
}): ReasoningEffortLevel | undefined {
  const normalized = normalizeReasoningEffort(input.reasoningEffort);
  if (normalized === undefined) {
    return undefined;
  }
  const options = resolveReasoningEffortOptions(input.runtime, input.catalogLevels);
  return options.includes(normalized) ? normalized : undefined;
}
