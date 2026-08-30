/**
 * IPC 通道契约 —— 主进程与渲染进程之间通信的唯一事实来源。
 *
 * 三种通信模式：
 * 1. invoke（请求/响应）：renderer → main 异步一问一答，见 IpcInvokeContracts
 * 2. event（事件订阅）：main → renderer 单向推送，见 IpcEventContracts
 * 3. 冒烟自测通道（smoke:*）仅在 --smoke 模式下由主进程注册
 *
 * 通道命名规则：<域>:<动作>，全小写 kebab-case（CHANNEL_NAME_PATTERN）。
 * 本文件为纯类型与常量，禁止 import 任何 Electron / Node API。
 * 领域类型从 @ff-pane/shared 引入（非 Electron / Node），保持线上形状与领域一致。
 */

import type {
  ConnectionTestResult,
  FetchModelsResult,
  HabitConflict,
  ProbeProviderInput,
} from "@ff-pane/core";
import type {
  AgentProfile,
  ApiKeyRef,
  GlobalConfig,
  HabitCategory,
  HabitEntry,
  HabitEntryId,
  LocalSessionId,
  MemoryEntry,
  MemoryEntryId,
  ModelId,
  Plan,
  PlanVersion,
  ProfileId,
  ProjectId,
  ProjectRegistryEntry,
  Provider,
  ProviderId,
  Role,
  Run,
  RunEndReason,
  RunId,
  SessionRecord,
  SessionResumeKind,
  Task,
  TaskId,
} from "@ff-pane/shared";

/** 项目级请求基：一律携带项目根路径，主进程据此 resolveProjectLayout。 */
export interface ProjectScopedRequest {
  readonly projectRoot: string;
}

/**
 * Provider 创建 / 更新草稿：除 id（由 store 生成）外的全部字段。
 * 与 storage 层 ProviderDraft 同构，此处按 shared 的 Provider 就地派生，
 * 避免契约（renderer + main 共享）依赖 node-only 的 @ff-pane/storage。
 */
export type ProviderDraftWire = Omit<Provider, "id">;

/** 应用元信息（app:get-info 响应）。 */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly runtime: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

/** app:get-locale 响应：主进程 app.getLocale() 检测到的系统语言（BCP 47，如 zh-CN）。 */
export interface LocaleInfo {
  readonly locale: string;
}

/** app:ping 请求。 */
export interface PingRequest {
  readonly message: string;
  readonly sentAt: number;
}

/** app:ping 响应。 */
export interface PingResponse {
  readonly reply: "pong";
  readonly echoed: string;
  readonly repliedAt: number;
}

/** diagnostics:check-sqlite 响应（失败路径经由 IpcResult 错误信封传递）。 */
export interface SqliteCheckReport {
  readonly sqliteVersion: string;
  readonly checkedAt: number;
}

/** 冒烟自测中单个检查项的结果。 */
export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** smoke:report 请求：renderer 汇总的全部检查结果。 */
export interface SmokeReport {
  readonly checks: readonly SmokeCheck[];
}

/** projects:create 请求：登记一个新项目（rootPath 已由 dialog:pick-directory 归一）。 */
export interface CreateProjectRequest {
  /** 项目根路径（绝对路径）。 */
  readonly rootPath: string;
  /** 项目显示名（默认取根目录名，可改）。 */
  readonly name: string;
}

/** projects:remove 请求。 */
export interface RemoveProjectRequest {
  readonly id: ProjectId;
}

/** projects:restore 请求：撤销移除，把先前 projects:remove 返回的条目放回。 */
export interface RestoreProjectRequest {
  readonly entry: ProjectRegistryEntry;
}

/**
 * dialog:pick-directory 响应：用户选定目录返回其绝对路径；取消返回 cancelled。
 * 判别字段 cancelled，供渲染层穷尽分支（取消不是错误，不走错误信封）。
 */
export type PickDirectoryResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly path: string };

/**
 * providers:create 请求：草稿 + 可选明文密钥。
 * 密钥红线（§4.3）：renderer 只在此一处、这一瞬把明文经 IPC 交给主进程加密落库，
 * 主进程存入系统密钥库后把 apiKeyRef 写进草稿；renderer 拿不到、也不持有引用之外的东西。
 */
export interface CreateProviderRequest {
  readonly draft: ProviderDraftWire;
  /** 明文密钥；主进程加密后置入 apiKeyRef。openai/anthropic 类型必填（否则校验失败）。 */
  readonly apiKey?: string;
}

/** providers:update 请求：整表单替换（id 不变）+ 密钥旋转控制。 */
export interface UpdateProviderRequest {
  readonly id: ProviderId;
  readonly draft: ProviderDraftWire;
  /** 提供则旋转密钥：主进程存新、删旧。 */
  readonly apiKey?: string;
  /** 置真则清除密钥（切到 cli_login 等）：主进程删旧、apiKeyRef 置空。 */
  readonly clearApiKey?: boolean;
}

/** providers:remove 请求。移除同时删除其密钥（若有）。 */
export interface RemoveProviderRequest {
  readonly id: ProviderId;
}

/** providers:test-connection 请求：草稿态即可测（先测后存）。 */
export interface TestProviderConnectionRequest {
  readonly provider: ProbeProviderInput;
  /** 明文密钥（未保存的表单）。 */
  readonly apiKey?: string;
  /** 已保存 Provider 的密钥引用；主进程 revealSecret 取明文构造请求头，用完即弃。 */
  readonly apiKeyRef?: ApiKeyRef;
  /** 显式指定探测模型 ID。 */
  readonly model?: ModelId;
}

/** providers:fetch-models 请求。 */
export interface FetchProviderModelsRequest {
  readonly provider: ProbeProviderInput;
  readonly apiKey?: string;
  readonly apiKeyRef?: ApiKeyRef;
}

/** secrets:masked-tail 请求。 */
export interface MaskedTailRequest {
  readonly ref: ApiKeyRef;
}

/** config:update 请求：部分补丁（浅合并），返回合并后的完整设置。 */
export type UpdateConfigRequest = Partial<GlobalConfig>;

/** Profile 创建 / 更新草稿：除 id（store 生成）外的全部字段。 */
export type ProfileDraftWire = Omit<AgentProfile, "id">;

/** profiles:create 请求。 */
export interface CreateProfileRequest {
  readonly draft: ProfileDraftWire;
}

/** profiles:update 请求：整表单替换（id 不变）。 */
export interface UpdateProfileRequest {
  readonly id: ProfileId;
  readonly draft: ProfileDraftWire;
}

/** profiles:remove 请求。 */
export interface RemoveProfileRequest {
  readonly id: ProfileId;
}

/** 任务操作请求（接受 / 取消）：项目根 + 任务 ID。 */
export interface TaskActionRequest extends ProjectScopedRequest {
  readonly id: TaskId;
}

/** 接受任务的结果（T4.4）：迁移后的任务 + 本次派生的记忆候选条数。 */
export interface AcceptTaskResult {
  readonly task: Task;
  /** 本次从任务沉淀派生的记忆候选数（0 = 无 Run 报告可沉淀）。 */
  readonly candidateCount: number;
}

/** 记忆条目操作请求（通过 / 拒绝）：项目根 + 条目 ID。 */
export interface MemoryActionRequest extends ProjectScopedRequest {
  readonly id: MemoryEntryId;
}

/** 记忆条目整条写回请求（编辑后通过：内容 + 状态一并落盘）。 */
export interface UpdateMemoryRequest extends ProjectScopedRequest {
  readonly entry: MemoryEntry;
}

/** 计划批准请求：项目根 + 版本号（批准只能由用户触发）。 */
export interface ApprovePlanRequest extends ProjectScopedRequest {
  readonly version: PlanVersion;
}

/**
 * 习惯（共享记忆）草稿（§8.2）：除 id 与时间戳（主进程生成）外的全部字段。
 * 习惯是全局共享记忆（跨项目），故其请求不携带 projectRoot。
 */
export type HabitDraftWire = Omit<HabitEntry, "id" | "createdAt" | "updatedAt">;

/** habits:create 请求：提交一条习惯草稿（来源一手写默认 status=active）。 */
export interface CreateHabitRequest {
  readonly draft: HabitDraftWire;
}

/** habits:update 请求：整条写回（id 不变，时间戳由主进程刷新）。 */
export interface UpdateHabitRequest {
  readonly entry: HabitEntry;
}

/** 习惯条目操作请求（通过 / 拒绝）：条目 ID（全局，无项目根）。 */
export interface HabitActionRequest {
  readonly id: HabitEntryId;
}

/** habits:set-enabled 请求：单条启用 / 停用（§8.2.4「可单条停用」）。 */
export interface SetHabitEnabledRequest {
  readonly id: HabitEntryId;
  readonly enabled: boolean;
}

/** habits:check-conflicts 请求：入库前查相近条目（§8.2.5），编辑时排除自身。 */
export interface CheckHabitConflictsRequest {
  readonly category: HabitCategory;
  readonly content: string;
  readonly excludeId?: HabitEntryId;
}

/**
 * 会话执行输入（§12 十步流程）：Planner 讨论消息 或 Worker 任务派发。
 * role 由输入类别隐含：planner-message → planner；worker-task → worker。
 */
export type SessionInput =
  | { readonly kind: "planner-message"; readonly text: string }
  /**
   * 生成/更新结构化计划（T4.6，§12 步骤"出计划"）：Planner 角色，提示词追加结构化输出合同，
   * 轮结束时主进程解析答复中的计划块 → 落 draft 计划。text 为可选补充指令（缺省即"据讨论出计划"）。
   */
  | { readonly kind: "planner-plan"; readonly text?: string }
  | { readonly kind: "worker-task"; readonly taskId: TaskId };

/**
 * session:start 请求：启动一轮会话执行。结果与增量内容不走应答，
 * 一律经 session:event 事件流推送（turnId 关联）。
 */
export interface StartSessionRequest extends ProjectScopedRequest {
  /** 渲染层生成的关联 ID，贯穿本轮全部 session:event。 */
  readonly turnId: string;
  /** 用哪个 Agent Profile 执行（决定 runtime / provider / 模型 / 权限预设）。 */
  readonly profileId: ProfileId;
  readonly input: SessionInput;
  /**
   * 续接的本地会话 ID（T4.3 会话恢复）。缺省 = 开新会话（主进程生成新 ID）；
   * 提供且该会话已登记 = 续接（据登记的原生绑定与适配器能力判定 native / context_rebuild）。
   */
  readonly sessionId?: LocalSessionId;
}

/** session:start 应答：仅表示已受理（true）或拒绝受理（false + reason）。 */
export type StartSessionAck =
  | {
      readonly accepted: true;
      readonly turnId: string;
      /** 本轮所属的本地会话 ID（新建时为主进程生成值，供渲染层登记为当前会话）。 */
      readonly sessionId: LocalSessionId;
    }
  | { readonly accepted: false; readonly reason: string };

/** session:respond-permission 请求：回执一条上浮的权限请求（§7 用户二选一）。 */
export interface RespondPermissionRequest {
  readonly turnId: string;
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}

/** session:cancel 请求：取消在飞的一轮。 */
export interface CancelSessionRequest {
  readonly turnId: string;
}

/** 会话动作应答（回执权限 / 取消）：ok=false 表示未找到该在飞轮次。 */
export interface SessionActionAck {
  readonly ok: boolean;
}

/**
 * 会话流式事件（main → renderer，§11.2 会话页 + §7 权限交互）。
 * 扁平判别联合：渲染层直接按 kind 分支，无需理解适配器 AgentEvent 内部形态。
 */
export type SessionStreamEvent =
  | {
      readonly turnId: string;
      readonly kind: "started";
      readonly role: Role;
      readonly model?: ModelId;
      /** 本轮所属会话（T4.3）。 */
      readonly sessionId: LocalSessionId;
      /**
       * 恢复方式（T4.3，§10.3）。缺省 = 全新会话首轮；否则为本次续接的方式
       *（native 原生恢复 / context_rebuild 上下文重建），供状态条标注会话类型。
       */
      readonly resumeKind?: SessionResumeKind;
    }
  | {
      readonly turnId: string;
      readonly kind: "text";
      readonly channel: "answer" | "reasoning";
      readonly delta: string;
      readonly final: boolean;
    }
  | {
      readonly turnId: string;
      readonly kind: "file-change";
      readonly path: string;
      readonly changeKind: "add" | "update" | "delete";
      readonly status: "started" | "completed" | "failed" | "denied";
    }
  | {
      readonly turnId: string;
      readonly kind: "command";
      readonly command: string;
      readonly status: "started" | "completed" | "failed" | "denied";
      readonly exitCode?: number;
    }
  | {
      readonly turnId: string;
      readonly kind: "permission-request";
      readonly requestId: string;
      readonly summary: string;
      readonly detail?: string;
      readonly diff?: string;
    }
  | {
      readonly turnId: string;
      readonly kind: "end";
      readonly reason: RunEndReason;
      readonly message?: string;
      readonly runId?: RunId;
      /**
       * 本轮（planner-plan）生成的计划版本号（T4.6）。仅计划生成轮且成功落盘时出现，
       * 供渲染层 toast「已生成计划 vN」并刷新/跳转计划页。
       */
      readonly planVersion?: PlanVersion;
    };

/** invoke（请求/响应）通道契约表。 */
export interface IpcInvokeContracts {
  "app:get-info": { request: undefined; response: AppInfo };
  /** 系统语言检测（Electron 下 navigator.language 不可靠，统一走主进程）。 */
  "app:get-locale": { request: undefined; response: LocaleInfo };
  "app:ping": { request: PingRequest; response: PingResponse };
  "diagnostics:check-sqlite": { request: undefined; response: SqliteCheckReport };
  /** 打开系统目录选择器，返回选定目录的绝对路径（取消经判别字段区分，不走错误）。 */
  "dialog:pick-directory": { request: undefined; response: PickDirectoryResult };
  /** 列出工作台已登记的全部项目（§11.1 项目列表页数据源）。 */
  "projects:list": { request: undefined; response: readonly ProjectRegistryEntry[] };
  /** 登记新项目：生成 .workbench/ 目录结构并写入注册表，返回登记后的条目。 */
  "projects:create": { request: CreateProjectRequest; response: ProjectRegistryEntry };
  /** 从工作台移除项目登记（不删除磁盘文件），返回被移除条目供撤销。 */
  "projects:remove": { request: RemoveProjectRequest; response: ProjectRegistryEntry };
  /** 撤销移除：把被移除的条目原样放回注册表。 */
  "projects:restore": { request: RestoreProjectRequest; response: ProjectRegistryEntry };
  /** 列出全部 Provider（设置页 §4）。 */
  "providers:list": { request: undefined; response: readonly Provider[] };
  /** 新建 Provider（明文密钥加密落库后返回落盘条目）。 */
  "providers:create": { request: CreateProviderRequest; response: Provider };
  /** 整表单更新 Provider（含密钥旋转 / 清除）。 */
  "providers:update": { request: UpdateProviderRequest; response: Provider };
  /** 删除 Provider（连带删除其密钥）。 */
  "providers:remove": { request: RemoveProviderRequest; response: { readonly removed: true } };
  /** 连接测试（§4.2：成功给耗时+方式，失败给阶段+原文）。 */
  "providers:test-connection": {
    request: TestProviderConnectionRequest;
    response: ConnectionTestResult;
  };
  /** 拉取模型列表（失败上层回退手动输入）。 */
  "providers:fetch-models": { request: FetchProviderModelsRequest; response: FetchModelsResult };
  /** 取密钥明文尾 4 位（§4.3 规则 3，UI 展示用；不足 4 位返回空串）。 */
  "secrets:masked-tail": { request: MaskedTailRequest; response: { readonly tail: string } };
  /** 读取全局设置（缺字段补出厂默认，§10.1）。 */
  "config:get": { request: undefined; response: GlobalConfig };
  /** 部分更新全局设置（浅合并），返回合并后的完整设置。 */
  "config:update": { request: UpdateConfigRequest; response: GlobalConfig };
  /** 列出全部 Agent Profile（§4.4）。 */
  "profiles:list": { request: undefined; response: readonly AgentProfile[] };
  /** 新建 Profile（经 core 校验 provider/model/角色/权限）。 */
  "profiles:create": { request: CreateProfileRequest; response: AgentProfile };
  /** 整表单更新 Profile。 */
  "profiles:update": { request: UpdateProfileRequest; response: AgentProfile };
  /** 删除 Profile。 */
  "profiles:remove": { request: RemoveProfileRequest; response: { readonly removed: true } };
  /** 列出当前项目的全部任务（§11.4 任务看板）。 */
  "tasks:list": { request: ProjectScopedRequest; response: readonly Task[] };
  /**
   * 接受任务（done → accepted，走 core 任务状态机）。
   * T4.4：验收即从任务沉淀派生记忆候选，返回本次生成的候选条数（供"去审核"提示）。
   */
  "tasks:accept": { request: TaskActionRequest; response: AcceptTaskResult };
  /** 取消任务（→ cancelled 终态）。 */
  "tasks:cancel": { request: TaskActionRequest; response: Task };
  /** 列出当前项目的全部执行记录（§11.5，含 file_changes/commands/verify_result）。 */
  "runs:list": { request: ProjectScopedRequest; response: readonly Run[] };
  /** 列出当前项目的全部记忆条目（§11.6；含 active / candidate / archived）。 */
  "memory:list": { request: ProjectScopedRequest; response: readonly MemoryEntry[] };
  /** 通过候选（candidate → active，走 updateEntryStatus 迁移文件）。 */
  "memory:approve": { request: MemoryActionRequest; response: MemoryEntry };
  /** 拒绝候选（直接删除，§8.1）。 */
  "memory:reject": { request: MemoryActionRequest; response: { readonly removed: boolean } };
  /** 整条写回（编辑后通过：内容 + 状态一并保存）。 */
  "memory:update": { request: UpdateMemoryRequest; response: MemoryEntry };
  /** 列出全部习惯条目（§8.2 共享记忆，全局；含 active / candidate / archived）。 */
  "habits:list": { request: undefined; response: readonly HabitEntry[] };
  /** 新建习惯（草稿校验后落盘；手写来源默认 active）。 */
  "habits:create": { request: CreateHabitRequest; response: HabitEntry };
  /** 整条更新习惯（编辑内容 / 重要度 / 分类）。 */
  "habits:update": { request: UpdateHabitRequest; response: HabitEntry };
  /** 通过习惯候选（candidate → active，来源二/三须经用户确认，§8.2.4）。 */
  "habits:approve": { request: HabitActionRequest; response: HabitEntry };
  /** 拒绝 / 删除习惯（直接删除）。 */
  "habits:reject": { request: HabitActionRequest; response: { readonly removed: boolean } };
  /** 单条启用 / 停用（保留条目但不参与 Prompt 组装，§8.2.4）。 */
  "habits:set-enabled": { request: SetHabitEnabledRequest; response: HabitEntry };
  /** 入库前查相近条目（§8.2.5 并排展示，用户选合并/替代/都保留）。 */
  "habits:check-conflicts": {
    request: CheckHabitConflictsRequest;
    response: readonly HabitConflict[];
  };
  /** 列出当前项目的全部计划版本（§11.3，按版本升序）。 */
  "plans:list": { request: ProjectScopedRequest; response: readonly Plan[] };
  /** 批准计划（draft → approved，只能由用户触发，走 core 计划状态机）。 */
  "plans:approve": { request: ApprovePlanRequest; response: Plan };
  /** 列出当前项目已登记的会话（T4.3 会话恢复；按最近活跃降序，供恢复选择）。 */
  "sessions:list": { request: ProjectScopedRequest; response: readonly SessionRecord[] };
  /** 启动一轮会话执行（Planner 讨论 / Worker 派发）；增量经 session:event 推送。 */
  "session:start": { request: StartSessionRequest; response: StartSessionAck };
  /** 回执一条上浮的权限请求（§7）。 */
  "session:respond-permission": { request: RespondPermissionRequest; response: SessionActionAck };
  /** 取消在飞的一轮。 */
  "session:cancel": { request: CancelSessionRequest; response: SessionActionAck };
  /** 仅冒烟模式注册：请求主进程向本窗口推送一条 smoke:event。 */
  "smoke:emit-event": { request: { readonly seq: number }; response: { readonly emitted: true } };
  /** 仅冒烟模式注册：上报渲染层检查结果，主进程据此决定退出码。 */
  "smoke:report": { request: SmokeReport; response: { readonly acknowledged: true } };
}

/** 事件（main → renderer 推送）通道契约表。 */
export interface IpcEventContracts {
  /** 仅冒烟模式使用：验证订阅链路的回声事件。 */
  "smoke:event": { payload: { readonly seq: number; readonly emittedAt: number } };
  /** 会话执行流式事件（一轮的 started / text / file-change / command / permission / end）。 */
  "session:event": { payload: SessionStreamEvent };
}

export type InvokeChannel = keyof IpcInvokeContracts;
export type InvokeRequest<K extends InvokeChannel> = IpcInvokeContracts[K]["request"];
export type InvokeResponse<K extends InvokeChannel> = IpcInvokeContracts[K]["response"];

export type EventChannel = keyof IpcEventContracts;
export type EventPayload<K extends EventChannel> = IpcEventContracts[K]["payload"];

/** 通道命名规则：<域>:<动作>，全小写 kebab-case。 */
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_PATTERN.test(name);
}

/** invoke 通道运行时允许清单（preload 据此拦截契约之外的通道调用）。 */
export const INVOKE_CHANNELS = [
  "app:get-info",
  "app:get-locale",
  "app:ping",
  "diagnostics:check-sqlite",
  "dialog:pick-directory",
  "projects:list",
  "projects:create",
  "projects:remove",
  "projects:restore",
  "providers:list",
  "providers:create",
  "providers:update",
  "providers:remove",
  "providers:test-connection",
  "providers:fetch-models",
  "secrets:masked-tail",
  "config:get",
  "config:update",
  "profiles:list",
  "profiles:create",
  "profiles:update",
  "profiles:remove",
  "tasks:list",
  "tasks:accept",
  "tasks:cancel",
  "runs:list",
  "memory:list",
  "memory:approve",
  "memory:reject",
  "memory:update",
  "habits:list",
  "habits:create",
  "habits:update",
  "habits:approve",
  "habits:reject",
  "habits:set-enabled",
  "habits:check-conflicts",
  "plans:list",
  "plans:approve",
  "sessions:list",
  "session:start",
  "session:respond-permission",
  "session:cancel",
  "smoke:emit-event",
  "smoke:report",
] as const satisfies readonly InvokeChannel[];

/** 事件通道运行时允许清单。 */
export const EVENT_CHANNELS = [
  "smoke:event",
  "session:event",
] as const satisfies readonly EventChannel[];

type AssertNever<T extends never> = T;

/** 编译期完整性断言：契约表新增通道而未登记到运行时清单时，此处实例化失败报错。 */
export type _AssertInvokeChannelsComplete = AssertNever<
  Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
>;
/** 编译期完整性断言：事件契约与运行时清单保持一致。 */
export type _AssertEventChannelsComplete = AssertNever<
  Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>
>;
