/**
 * 领域基础设施：品牌 ID、时间戳约定、字面量联合守卫工厂。
 *
 * ID 策略（W1.1 决策）：本系统生成的实体 ID 一律使用品牌类型（branded type）。
 * 理由：Task/Run/Plan/Memory 等 ID 底层同为 string，会在 storage、core、adapters、
 * UI 之间大量流动，品牌类型让"把 taskId 传给 runId 参数"这类错误在编译期暴露，
 * 且零运行时开销（品牌属性只存在于类型层，运行时不存在）。
 * 外部世界书写的标识符（模型名 ModelId、Runtime 注册键 RuntimeId）保持普通
 * string 别名——它们不由本系统生成，强品牌只会带来无收益的断言噪声。
 * 系统边界（JSON 读入、ID 生成处）用 `as` 断言收窄一次，如 `raw.id as TaskId`；
 * 边界内部全程持有品牌类型。
 */

/** 品牌类型工具：为基础类型附加编译期标签。`__brand` 属性仅存在于类型层。 */
export type Brand<TBase, TBrandName extends string> = TBase & {
  readonly __brand: TBrandName;
};

/** 时间戳全仓统一为 epoch 毫秒（`Date.now()` 的产物）。（W1.1 全局约定） */
export type EpochMillis = number;

/** 设计文档 §3 —— Project 的内部唯一 ID。 */
export type ProjectId = Brand<string, "ProjectId">;

/** 设计文档 §4.1 —— Provider 的内部唯一 ID。 */
export type ProviderId = Brand<string, "ProviderId">;

/**
 * 设计文档 §4.1 / §4.3 —— 密钥引用 ID。
 * 密钥本体存于操作系统密钥库（safeStorage），任何领域类型只允许持有此引用，
 * 密钥明文永不出现在类型系统与持久化数据中。
 */
export type ApiKeyRef = Brand<string, "ApiKeyRef">;

/** 设计文档 §4.4 —— Agent Profile 的内部唯一 ID。 */
export type ProfileId = Brand<string, "ProfileId">;

/** 设计文档 §3.1 / T8.4 —— 自定义角色的内部唯一 ID（`role-` 前缀，见 profile.ts）。 */
export type CustomRoleId = Brand<string, "CustomRoleId">;

/**
 * 设计文档 §6.1 —— 计划版本号，从 1 开始只增不改。
 * 数值形式（1、2、3…）；渲染为 "v1"/"v2" 由展示层与文件命名层负责。
 */
export type PlanVersion = Brand<number, "PlanVersion">;

/** 设计文档 §6.2 —— Task 的内部唯一 ID。 */
export type TaskId = Brand<string, "TaskId">;

/** 设计文档 §6.4 —— Run 的内部唯一 ID。 */
export type RunId = Brand<string, "RunId">;

/** 设计文档 §6.5 —— 澄清请求的内部唯一 ID。 */
export type ClarificationRequestId = Brand<string, "ClarificationRequestId">;

/** 设计文档 §7 —— 权限扩展请求的内部唯一 ID。 */
export type PermissionRequestId = Brand<string, "PermissionRequestId">;

/** 设计文档 §8.1 —— 项目记忆条目的内部唯一 ID。 */
export type MemoryEntryId = Brand<string, "MemoryEntryId">;

/** 设计文档 §8.2 —— 共享记忆（习惯）条目的内部唯一 ID。 */
export type HabitEntryId = Brand<string, "HabitEntryId">;

/** 设计文档 §8.3 —— 知识库条目（文档级）的内部唯一 ID。 */
export type KnowledgeEntryId = Brand<string, "KnowledgeEntryId">;

/** 设计文档 §8.3.3 —— 知识库文本块的内部唯一 ID。 */
export type KnowledgeChunkId = Brand<string, "KnowledgeChunkId">;

/** 设计文档 §10.2 规则 3 / §10.3 —— 工作台自身的会话登记 ID。 */
export type LocalSessionId = Brand<string, "LocalSessionId">;

/**
 * 设计文档 §10.2 规则 3 —— Agent Runtime 原生会话 ID（如 Claude Code 的
 * session_id UUID）。工作台只登记引用，不复制会话内容。
 */
export type NativeSessionId = Brand<string, "NativeSessionId">;

/**
 * 设计文档 §5.3 —— Runtime 注册键（如 "codex"、"claude-code"、"generic-exec"）。
 * 开放集合：适配器注册表（W2.1c）持有权威清单，M2+ 随时增补，故不做闭合联合。
 */
export type RuntimeId = string;

/** 设计文档 §4.1 —— 模型 ID（如 "deepseek-chat"），由 Provider 方定义的外部标识符。 */
export type ModelId = string;

/**
 * 字面量联合守卫工厂：由 as const 数组生成运行时类型守卫。
 * 本包所有 `isXxx` 守卫（如 isTaskStatus）均由此生成，保证守卫与常量数组永不脱节。
 */
export function createLiteralGuard<const TValues extends readonly string[]>(
  values: TValues,
): (value: unknown) => value is TValues[number] {
  const set = new Set<string>(values);
  return (value: unknown): value is TValues[number] => typeof value === "string" && set.has(value);
}
