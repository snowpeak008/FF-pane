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
  ConfigToolCallRecord,
  CustomRole,
  CustomRoleId,
  GlobalConfig,
  HabitCategory,
  HabitEntry,
  HabitEntryId,
  KnowledgeChunk,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeFormat,
  KnowledgeQueryRecord,
  LocalSessionId,
  MemoryCategory,
  MemoryEntry,
  MemoryEntryId,
  MemoryStatus,
  ModelId,
  PlanStatus,
  PlanVersion,
  ProfileId,
  ProjectConfig,
  ProjectConfigDraft,
  ProjectConfigId,
  ProjectId,
  ProjectRegistryEntry,
  ProjectWorkbenchLayout,
  Provider,
  ProviderId,
  ReviewVerdict,
  RoleRef,
  RunEndReason,
  RunId,
  SessionResumeKind,
  WorkbenchPermissionLevel,
  WorkbenchRole,
  WorkbenchRoleManualId,
  WorkbenchWindow,
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

/**
 * T9.1 —— Agent 起草的 Provider 草案（工作台自配置工具）：**类型层面就没有 apiKeyRef**。
 * 与 mcp/config-tool.ts 的 ConfigProviderDraft 同构（结构化类型互通）；契约再派生一份
 * 是因为渲染层（确认对话框）也要消费这个形状，而它不该 import sidecar 模块。
 */
export type ConfigProviderDraftWire = Omit<Provider, "id" | "apiKeyRef">;

/** T9.1 —— Agent 起草的 Profile 草案（Profile 本就无密钥字段）。 */
export type ConfigProfileDraftWire = Omit<AgentProfile, "id">;

/**
 * T9.1 —— 推给渲染层确认对话框的一份配置草案（已过领域校验；校验失败的草案
 * 根本不会到达这里，而是原样回给 Agent）。**物理不含任何密钥字段**（铁律 1）。
 */
export type ConfigDraftPayload =
  | {
      readonly kind: "provider";
      /** 更新目标（带 = 更新既有条目；缺省 = 新建）。 */
      readonly targetId?: ProviderId;
      readonly draft: ConfigProviderDraftWire;
      /** 更新时的脱敏现状。不含 apiKeyRef。 */
      readonly current?: {
        readonly id: string;
        readonly name: string;
        readonly templateId: string;
        readonly baseUrl?: string;
        readonly models: readonly {
          readonly id: string;
          readonly label?: string;
          readonly kind?: string;
        }[];
        readonly defaultModelId?: string;
        readonly embeddingModel?: string;
        readonly proxy?: string;
        readonly timeoutS?: number;
        readonly enabled: boolean;
        readonly apiKeyConfigured: boolean;
      };
    }
  | {
      readonly kind: "profile";
      readonly targetId?: ProfileId;
      readonly draft: ConfigProfileDraftWire;
    }
  | {
      readonly kind: "config";
      readonly targetId?: ProjectConfigId;
      readonly draft: ProjectConfigDraft;
      /** 更新时的现状。新建时缺省。 */
      readonly current?: ProjectConfig;
    };

/**
 * session:respond-config-draft 请求：用户对一份配置草案的裁决（T9.1 铁律 2 的回程）。
 *
 * apiKey 是**用户亲手在安全输入框里敲的明文**（铁律 1 的补填通道）：与 providers:create
 * 同款语义——只在此一瞬经 IPC 交主进程加密落库，模型从头到尾不知道它存在。
 * 仅 Provider 草案且类型需要密钥时对话框才展示该输入框。
 */
export interface RespondConfigDraftRequest {
  readonly turnId: string;
  /** 草案 ID（config-draft 事件带来的那个）。 */
  readonly draftId: string;
  readonly decision: "confirm" | "reject";
  /** 确认时随手补填的明文密钥（主进程 storeSecret 后把引用并进草稿）。 */
  readonly apiKey?: string;
  /** 拒绝原因（原样回给 Agent，供其调整草案）。 */
  readonly reason?: string;
}

/** 工作台确认框回执。windowId 对应草案中枢的 turnId。 */
export interface RespondWorkbenchConfigDraftRequest {
  readonly windowId: string;
  readonly draftId: string;
  readonly decision: "confirm" | "reject";
  readonly apiKey?: string;
  readonly reason?: string;
}

/** 推给工作台确认框的一份草案。 */
export interface WorkbenchConfigDraftEvent {
  readonly windowId: string;
  readonly draftId: string;
  readonly summary: string;
  readonly needsApiKey: boolean;
  readonly payload: ConfigDraftPayload;
}

/** 草案已了结（确认、取消、超时），确认框应关掉。 */
export interface WorkbenchConfigDraftResolvedEvent {
  readonly windowId: string;
  readonly draftId: string;
}

/** session:respond-config-draft 应答：ok=false 时给出人可读的失败原因（如落盘校验失败）。 */
export interface ConfigDraftAck {
  readonly ok: boolean;
  readonly message?: string;
}

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

/** diagnostics:check-pty 响应（T10.1；失败路径经由 IpcResult 错误信封传递）。 */
export interface PtyCheckReport {
  readonly shell: string;
  readonly marker: string;
  readonly checkedAt: number;
}

/** terminal:create 请求（T10.1）。cwd 缺省时主进程回退用户主目录；shell 仅允许白名单裸名。
 * args / env **不在契约内**：renderer 不得传入；T10.4 起由主进程内部组装。 */
export interface CreateTerminalRequest {
  readonly id?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly cols: number;
  readonly rows: number;
  /** 扩展点：角色 / CLI / 令牌等元数据，本单主进程原样保存不解释。 */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 终端快照（create / list 响应）。 */
export interface TerminalInfo {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly createdAt: number;
  readonly lastOutputAt: number;
  readonly lastInputAt: number;
  readonly exited: boolean;
  readonly exitCode: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

export interface TerminalIdRequest {
  readonly id: string;
}

export interface TerminalWriteRequest {
  readonly id: string;
  readonly data: string;
}

export interface TerminalResizeRequest {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalReplayResponse {
  readonly id: string;
  readonly data: string;
}

/** workbench:save-layout 请求（T10.2）：单项目布局整表覆盖。 */
export interface SaveWorkbenchLayoutRequest {
  readonly layout: ProjectWorkbenchLayout;
}

/** workbench:flush-request 事件：主进程请渲染端立刻落盘防抖中的布局。 */
export interface WorkbenchFlushRequestEvent {
  readonly requestId: string;
}

/** workbench:flush-ack 请求：渲染端确认 flush 完成。 */
export interface WorkbenchFlushAckRequest {
  readonly requestId: string;
}

/**
 * workbench:launch-cli 请求（T10.4）。
 * 仅高层参数；禁止 args/env/shell/executable 等（主进程组装）。
 */
export interface LaunchCliWindowRequest {
  readonly windowId: string;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  /** claude、codex、grok 或 deepseek。主进程按项目配置选路，不读档案。 */
  readonly kind: "claude" | "codex" | "grok" | "deepseek";
  /** 已忽略。旧客户端若仍传入，主进程不使用。 */
  readonly profileId?: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly initialPrompt?: string;
  /** true = 续接上次会话。 */
  readonly resume?: boolean;
  /** 续接用原生会话 id（Claude 必填才算精确续接；Codex 可缺省打开选择器）。 */
  readonly nativeSessionId?: string;
  /** T10.5：窗口权限等级。 */
  readonly permission?: WorkbenchPermissionLevel;
  /** T10.6：新建窗口时的角色。登记表已有角色时以登记表为准。 */
  readonly role?: WorkbenchRole;
}

/** workbench:launch-cli 响应（不含密钥）。 */
export interface LaunchCliWindowResponse {
  readonly terminal: TerminalInfo;
  readonly kind: "claude" | "codex" | "grok" | "deepseek";
  readonly nativeSessionId?: string;
  /** Codex 新开：后台认领 session id 中。 */
  readonly claimingSession?: boolean;
  /** Codex 续接且无 id：已打开 CLI resume 选择器。 */
  readonly resumePicker?: boolean;
  readonly configName: string;
  readonly connectionMode: "local_cli" | "relay";
  readonly providerName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** T10.5'：实际生效权限（可能被祖先封顶）。 */
  readonly effectivePermission: WorkbenchPermissionLevel;
  /** T10.5'：请求权限被祖先上限压低时为 true。 */
  readonly permissionCapped: boolean;
  /** auto = 已装 node 直启的回合信号；manual = 没有 node.exe，投递一直要确认。 */
  readonly turnSignal: "auto" | "manual";
}

/** workbench:session-claimed 事件（Codex 认领到原生会话 id）。 */
export interface WorkbenchSessionClaimedEvent {
  readonly windowId: string;
  readonly nativeSessionId: string;
}

/** 记号没对上。界面标编号未识别，续接走选择器。 */
export interface WorkbenchSessionUnidentifiedEvent {
  readonly windowId: string;
}

/** 本窗口当前对话有活动，刷新最后活动时间。 */
export interface WorkbenchConversationTouchEvent {
  readonly windowId: string;
  readonly at: number;
}

/** workbench:set-role 请求（T10.6）。调用方固定为界面用户。 */
export interface SetWorkbenchRoleRequest {
  readonly windowId: string;
  readonly role: WorkbenchRole;
}

/** 界面用户显式修改窗口权限。清洗锁只在这条路径上解开。 */
export interface SetWorkbenchPermissionRequest {
  readonly windowId: string;
  readonly permission: WorkbenchPermissionLevel;
}

export interface SetWorkbenchPermissionResponse {
  readonly ok: true;
  readonly permission: WorkbenchPermissionLevel;
}

/** workbench:set-role 响应。manual/held 的按钮走 workbench:deliver-pending。 */
export interface SetWorkbenchRoleResponse {
  readonly ok: true;
  readonly role: WorkbenchRole;
  readonly delivery: "skipped" | "queued" | "manual" | "held" | "delivered" | "dropped";
}

export interface WorkbenchRoleManualView {
  readonly id: WorkbenchRoleManualId;
  readonly content: string;
  readonly defaultContent: string;
  readonly source: "override" | "default";
  readonly path: string;
}

export interface ListWorkbenchRoleManualsResponse {
  readonly manuals: readonly WorkbenchRoleManualView[];
}

export interface SaveWorkbenchRoleManualRequest {
  readonly id: WorkbenchRoleManualId;
  readonly content: string;
}

export interface ResetWorkbenchRoleManualRequest {
  readonly id: WorkbenchRoleManualId;
}

/** 角色说明因窗口退出没写进去（T10.6'）。取消待投递不走这条。 */
export interface WorkbenchRoleNoticeEvent {
  readonly windowId: string;
  readonly delivery: "dropped";
  readonly reason?: string;
}

export interface DeliverWorkbenchPendingRequest {
  readonly windowId: string;
}

export type DeliverWorkbenchPendingResponse =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      readonly reason: "blocked" | "busy" | "empty" | "unknown-window";
    };

/** 管理者开出的子窗口已经在主进程启动，渲染端把它放进当前布局。 */
export interface WorkbenchChildWindowEvent {
  readonly projectId: ProjectId;
  readonly window: WorkbenchWindow;
  readonly managerWindowId: string;
}

/** 未读数与最近汇报状态。只带发生变化的字段。 */
export interface WorkbenchInboxNoticeEvent {
  readonly windowId: string;
  readonly unread?: number;
  readonly lastReportStatus?: "done" | "blocked" | "failed" | "progress";
}

/** 冷启动后从线程索引尾部重算的标题栏徽章。 */
export interface WorkbenchInboxBadgesResponse {
  readonly badges: Readonly<
    Record<
      string,
      {
        readonly unread: number;
        readonly lastReportStatus?: "done" | "blocked" | "failed" | "progress";
      }
    >
  >;
}

export type WorkbenchPanelId = "plan" | "tasks" | "runs";

/** ffpane_open_panel：打开工作台隐藏抽屉的对应页签并 toast。 */
export interface WorkbenchOpenPanelEvent {
  readonly panel: WorkbenchPanelId;
  readonly openerTitle: string;
  readonly projectId: ProjectId;
}

export interface WorkbenchBriefListItem {
  readonly name: string;
  readonly relativePath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface WorkbenchReadBriefResponse {
  readonly relativePath: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface WorkbenchThreadView {
  readonly id: string;
  readonly ts: string;
  readonly from: { readonly windowId: string; readonly title: string; readonly role: string };
  readonly to: { readonly windowId: string; readonly title: string; readonly role: string };
  readonly kind: "message" | "report" | "system";
  readonly status?: "done" | "blocked" | "failed" | "progress";
  readonly text: string;
  readonly briefPath?: string;
  readonly threadFile: string;
}

export interface WorkbenchReadThreadsResponse {
  readonly records: readonly WorkbenchThreadView[];
  readonly hasMore: boolean;
  readonly capped: boolean;
}

export interface WorkbenchPanelReport {
  readonly status: "done" | "blocked" | "failed" | "progress";
  readonly summary: string;
  readonly ts: string;
  readonly briefPath?: string;
}

export interface WorkbenchPanelActivityResponse {
  readonly runningWindowIds: readonly string[];
  readonly reports: Readonly<Record<string, WorkbenchPanelReport>>;
}

/** ffpane_close_window：渲染端从布局拿掉该窗口。 */
export interface WorkbenchWindowClosedEvent {
  readonly projectId: ProjectId;
  readonly windowId: string;
}

/** 管理权显示位。true 表示标题栏「管理权待恢复」，不授予开窗口能力。 */
export interface WorkbenchManagerGrantEvent {
  readonly projectId: ProjectId;
  readonly windowId: string;
  readonly managerGrantPending: boolean;
}

/** 某窗口待投递条数。manual 才显示立即发送；blocked 绝不发送。 */
export interface WorkbenchDeliverPendingEvent {
  readonly windowId: string;
  readonly count: number;
  readonly mode: "manual" | "blocked" | "busy" | "clear";
}

export interface ModelEffortSettledRequest {
  readonly windowId: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface WorkbenchModelEffortEvent {
  readonly windowId: string;
  readonly action: "resume" | "confirm" | "pending" | "clear";
  readonly reason: "busy" | "confirm" | "not-running" | "no-session" | "failed";
  readonly error?: string;
  readonly modelOverride?: string;
  readonly effortOverride?: string;
}

export interface TerminalOutputEvent {
  readonly id: string;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly id: string;
  readonly exitCode: number;
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
  /** 可选。只接受对所有项目开放的配置；空 = 跟着默认配置。 */
  readonly configId?: string;
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
 * 项目级设置视图（T6.6）：project.json 中工作台当前负责读写的字段。
 * 与 storage 的 ProjectSettings 同构，此处独立声明——契约由渲染层与主进程共享，
 * 不能依赖 node-only 的 @ff-pane/storage（与 ProviderDraft 同一处置）。
 */
export interface ProjectSettingsView {
  /** 设计文档 §8.3.5 —— Agent 只读知识库检索工具开关（缺省关闭）。 */
  readonly knowledgeToolEnabled: boolean;
  /** T9.1 —— 工作台自配置工具开关（缺省关闭，照 T6.6 纪律）。 */
  readonly configToolEnabled: boolean;
  /** 设计文档 §3.1 —— Reviewer 角色开关（T7.2，缺省关闭）。 */
  readonly reviewerEnabled: boolean;
  /** 设计文档 §3.1 —— Reviewer 绑定的 Profile（T7.2；未绑定时缺省）。程序不读。 */
  readonly reviewerProfileId?: ProfileId;
  /** 绑定的项目配置。缺省 = 跟着默认配置。 */
  readonly configId?: string;
}

/** projects:update-settings 的补丁。configId 为 null 时清除绑定。 */
export type ProjectSettingsPatch = Partial<Omit<ProjectSettingsView, "configId">> & {
  readonly configId?: string | null;
};

/** projects:update-settings 请求：只带要改的字段。 */
export interface UpdateProjectSettingsRequest extends ProjectScopedRequest {
  readonly patch: ProjectSettingsPatch;
}

/**
 * 「最后活动时间」的出处（T7.4，§11.1）。
 *
 * 只有三个取值而不是四个：**任务记录不带时间戳**——`Task = TaskContract + status`，
 * 合同里没有创建/更新时刻（见 `shared/domain/task.ts`）。任务的时间信息全在它的 Run 上，
 * 故任务经由 `run` 这一路参与。这是领域事实，不是这里漏读了一处。
 */
export const PROJECT_ACTIVITY_SOURCES = ["plan", "run", "session"] as const;

export type ProjectActivitySource = (typeof PROJECT_ACTIVITY_SOURCES)[number];

/**
 * 项目摘要的四个数据源（读失败时按源逐个降级，见 `ProjectSummary.unavailable`）。
 * 这里保留 `task` —— 任务虽不贡献时间点，却贡献「进行中任务数」，它读不到时也要如实说。
 */
export const PROJECT_SUMMARY_PARTS = ["plan", "task", "run", "session"] as const;

export type ProjectSummaryPart = (typeof PROJECT_SUMMARY_PARTS)[number];

/**
 * 项目卡片的派生信息（T7.4，§11.1「当前计划版本与状态 / 进行中任务数 / 最后活动时间」）。
 *
 * **不持久化**：这三项由查询层从计划 · 任务 · Run · 会话登记当场汇总。持久化它们等于
 * 要求每一处写计划/任务/Run/会话的代码都记得回头更新一份摘要，漏一处就是一张长期撒谎的
 * 卡片。派生则永远与磁盘上的事实一致（同 T7.2 的任务审查结论派生）。
 *
 * 全是数字、版本号与枚举，**不含任何面向用户的文案**——措辞由渲染层按语言包取。
 */
export interface ProjectSummary {
  /**
   * `.workbench/` 是否存在。为假时后四项一律是零值，界面须如实标注「数据目录缺失」，
   * 而不是把它显示成一个干干净净的新项目——项目被移除目录或盘坏了，与刚建好，是两回事。
   */
  readonly workbenchPresent: boolean;
  /** 当前（版本号最大的）计划版本；缺省 = 尚无计划。 */
  readonly planVersion?: number;
  /** 当前计划的状态；与 planVersion 同进同出。 */
  readonly planStatus?: PlanStatus;
  /** 进行中（未收尾）的任务数：全部任务减去 accepted 与 cancelled 两个终态。 */
  readonly activeTaskCount: number;
  /** 任务总数（含终态），供界面表达「3 / 12」这类分母。 */
  readonly taskCount: number;
  /** 最后活动时刻（epoch 毫秒）；缺省 = 四个来源都没有可用时间点。 */
  readonly lastActivityAt?: number;
  /** 最后活动的出处；与 lastActivityAt 同进同出。 */
  readonly lastActivitySource?: ProjectActivitySource;
  /**
   * 本次汇总中读失败的数据源（如 sessions.json 损坏）。非空 = 卡片信息不完整，
   * 界面如实标注。单个源失败不影响其余源，更不影响别的项目（§单文件失败不中断批量）。
   */
  readonly unavailable: readonly ProjectSummaryPart[];
}

/**
 * 项目列表页的一行：注册表条目 + 派生摘要。
 *
 * 与 `KnowledgeEntryView` 同款分层——实体归实体、派生归派生，界面一眼看得出哪些是
 * 落盘事实、哪些是算出来的。
 */
export interface ProjectSummaryView {
  readonly entry: ProjectRegistryEntry;
  readonly summary: ProjectSummary;
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

/**
 * providers:test-connection 请求：草稿态即可测（先测后存）。
 *
 * proxy 与 provider 分列两个字段而不是并进 ProbeProviderInput：core 的探测层不消费
 * 代理（它不认识 undici），代理是主进程侧的网络出口。若把 proxy 塞进 ProbeProviderInput，
 * 任何直接调用 core 的人都会以为传了就生效——那是一个静默失效的陷阱。
 */
export interface TestProviderConnectionRequest {
  readonly provider: ProbeProviderInput;
  /** 明文密钥（未保存的表单）。 */
  readonly apiKey?: string;
  /** 已保存 Provider 的密钥引用；主进程 revealSecret 取明文构造请求头，用完即弃。 */
  readonly apiKeyRef?: ApiKeyRef;
  /** 显式指定探测模型 ID。 */
  readonly model?: ModelId;
  /** Provider.proxy（§4.1）：探测请求的代理出口，主进程消费；缺省 / 空串即直连。 */
  readonly proxy?: string;
}

/** providers:fetch-models 请求。 */
export interface FetchProviderModelsRequest {
  readonly provider: ProbeProviderInput;
  readonly apiKey?: string;
  readonly apiKeyRef?: ApiKeyRef;
  /** 同 TestProviderConnectionRequest.proxy。 */
  readonly proxy?: string;
}

/**
 * cli_login 登录态探测（T9.2 ②）与本地模型枚举（T9.2 ③）的线上形状。
 *
 * 字面量镜像自 @ff-pane/adapters（CLI_LOGIN_RUNTIMES / CLI_LOGIN_STATUSES /
 * LOCAL_MODEL_ERRORS）：契约由 renderer 与 main 共享，而 adapters 包不是渲染层
 * 依赖（同 renderer 侧 RUNTIME_OPTIONS / CAPABILITY_LEVELS 的既有镜像惯例），
 * 一致性由 session-registry.test.ts 的对照断言钉住。
 */
export const CLI_LOGIN_RUNTIME_WIRES = [
  "codex",
  "claude-code",
  "gemini-cli",
  "opencode",
  "grok-build",
] as const;

/** 支持登录态探测的 Runtime（线上形状）。 */
export type CliLoginRuntimeWire = (typeof CLI_LOGIN_RUNTIME_WIRES)[number];

/** CliLoginRuntimeWire 运行时守卫（编辑器按 Runtime 决定是否展示登录态区）。 */
export function isCliLoginRuntimeWire(value: unknown): value is CliLoginRuntimeWire {
  return (
    typeof value === "string" && (CLI_LOGIN_RUNTIME_WIRES as readonly string[]).includes(value)
  );
}

/**
 * 支持本地模型枚举的 Runtime（T9.2 ③ 真机调研结论：codex `debug models` /
 * opencode `models` / grok `models`；claude-code 与 gemini-cli 无枚举途径）。
 * 镜像自 adapters LOCAL_MODEL_RUNTIMES，一致性由 session-registry.test.ts 钉住。
 * UI 据此决定「读取本地模型」按钮显隐——不支持的 Runtime 不给按钮（点了必失败
 * 的按钮不该存在），文案说明留空走 CLI 默认。
 */
export const LOCAL_MODEL_RUNTIME_WIRES = ["codex", "opencode", "grok-build"] as const;

/** 该 Runtime 是否支持本地模型枚举。 */
export function supportsLocalModelsWire(runtime: CliLoginRuntimeWire): boolean {
  return (LOCAL_MODEL_RUNTIME_WIRES as readonly string[]).includes(runtime);
}

/** providers:probe-cli-login 请求。 */
export interface ProbeCliLoginRequest {
  readonly runtime: CliLoginRuntimeWire;
}

/** providers:probe-cli-login 应答（同 adapters CliLoginProbeResult 的可序列化形状）。 */
export interface CliLoginProbeView {
  /** 探测结论（logged_in / logged_out / cli_missing / unknown）。 */
  readonly status: "logged_in" | "logged_out" | "cli_missing" | "unknown";
  /** 人类可读的判定依据（已脱敏截断，可直接展示）。 */
  readonly detail: string;
  /** 实际执行的探测命令行。 */
  readonly probedWith: string;
}

/** providers:list-local-models 请求。 */
export interface ListLocalModelsRequest {
  readonly runtime: CliLoginRuntimeWire;
}

/** 本地模型条目（同 adapters LocalModelEntry 的可序列化形状）。 */
export interface LocalModelEntryWire {
  /** 模型 ID（该 CLI 的 -m 类参数可直接消费的形态）。 */
  readonly id: string;
  readonly displayName: string;
  /** 该 CLI 的默认模型标记（仅 grok 清单携带）。 */
  readonly isDefault: boolean;
}

/** providers:list-local-models 应答（判别联合；失败分类供 UI 给可理解提示）。 */
export type ListLocalModelsResponse =
  | { readonly ok: true; readonly models: readonly LocalModelEntryWire[]; readonly detail: string }
  | {
      readonly ok: false;
      readonly error: "unsupported" | "cli_missing" | "timeout" | "parse_error" | "cli_error";
      readonly detail: string;
    };

/** T9.4b —— 按 Runtime + 模型解析可见的推理强度档。 */
export interface ReasoningEffortLevelsRequest {
  readonly runtime: string;
  readonly model?: string;
}

/** T9.4b —— `levels` 为空数组 = UI 隐藏下拉。 */
export interface ReasoningEffortLevelsResponse {
  readonly levels: readonly string[];
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

/**
 * 自定义角色创建 / 更新草稿（T8.4）：名称 + 角色提示词 + 权限预设
 * （id 与时间戳由 store 维护）。与 storage 层 CustomRoleDraft 同构，
 * 此处按 shared 的 CustomRole 就地派生（契约不依赖 node-only 的 storage）。
 */
export type CustomRoleDraftWire = Omit<CustomRole, "id" | "createdAt" | "updatedAt">;

/** roles:create 请求。 */
export interface CreateRoleRequest {
  readonly draft: CustomRoleDraftWire;
}

/** roles:update 请求：整表单替换（id / createdAt 不变）。 */
export interface UpdateRoleRequest {
  readonly id: CustomRoleId;
  readonly draft: CustomRoleDraftWire;
}

/** roles:remove 请求。被 Profile 引用（defaultRole 指向它）时拒删（RoleInUseError）。 */
export interface RemoveRoleRequest {
  readonly id: CustomRoleId;
}

/** 记忆条目操作请求（通过 / 拒绝）：项目根 + 条目 ID。 */
export interface MemoryActionRequest extends ProjectScopedRequest {
  readonly id: MemoryEntryId;
}

/** 记忆条目整条写回请求（编辑后通过：内容 + 状态一并落盘）。 */
export interface UpdateMemoryRequest extends ProjectScopedRequest {
  readonly entry: MemoryEntry;
}

/** memory:search 请求（T8.7 混合检索）：项目根 + 查询 + 可选过滤。 */
export interface MemorySearchRequest extends ProjectScopedRequest {
  /** 用户原始输入（首尾空白由主进程去除；空白查询返回空结果）。 */
  readonly query: string;
  /** 类别过滤（OR 语义）；省略或空数组不过滤。 */
  readonly categories?: readonly MemoryCategory[];
  /** 状态过滤：同上。 */
  readonly statuses?: readonly MemoryStatus[];
  /** 返回条数上限；缺省由存储层决定（DEFAULT_SEARCH_LIMIT）。 */
  readonly limit?: number;
}

/** memory:search 的一条命中（索引列；完整条目由渲染层凭 id 从 memory:list 数据取）。 */
export interface MemorySearchHitView {
  readonly id: MemoryEntryId;
  readonly category: MemoryCategory;
  readonly status: MemoryStatus;
  readonly title: string;
  /** RRF 融合分（越大越靠前）。 */
  readonly score: number;
  /** 命中它的召回路径（"fts" | "like-fallback" | "vector"）。两路都有通常最可信。 */
  readonly sources: readonly string[];
}

/**
 * memory:search 响应：命中 + 本次实际走了哪几路（同 knowledge:search 的口径，
 * 界面据此说明「当前为纯关键词检索」而不是静默少一路召回）。
 */
export interface MemorySearchResponse {
  readonly hits: readonly MemorySearchHitView[];
  /** 关键词路是否走了 FTS（false = 查询过短、回退 LIKE 子串扫描）。 */
  readonly usedFts: boolean;
  /** 向量路是否参与。 */
  readonly usedVector: boolean;
  /** 向量路缺席的原因码；usedVector 为真时缺席（复用知识库的原因码集合）。 */
  readonly embeddingBlocker?: KnowledgeEmbeddingBlocker;
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

// ── 知识库（§8.3，T6.5）：全局作用域，不带 projectRoot ──────────────────────

/**
 * 条目视图（§8.3.6 来源管理「文档数 / 块数 / 索引状态」）：
 * 条目 + 两个派生计数。计数由索引算出，不进领域实体——它们随索引重建而变，
 * 不是条目自身的属性。
 */
export interface KnowledgeEntryView {
  readonly entry: KnowledgeEntry;
  /** 该条目的块数。 */
  readonly chunkCount: number;
  /** 该条目已有向量的块数（未建向量索引时恒为 0）。 */
  readonly embeddedCount: number;
}

/** 向量索引现状；未建索引时整体缺席（纯 FTS 模式，§8.3.3）。 */
export interface KnowledgeVectorStatus {
  /** 'vec0' | 'fallback'。 */
  readonly backend: string;
  readonly dimensions: number;
  /** 建索引所用的嵌入模型。 */
  readonly model: string;
  /** 全库已存向量条数。 */
  readonly vectors: number;
}

/**
 * 嵌入不可用的原因码。**用码不用文案**：渲染层据码取语言包，
 * 主进程不产出面向用户的中文（renderer 禁硬编码 CJK，check-i18n 把关）。
 */
export const KNOWLEDGE_EMBEDDING_BLOCKERS = ["no-provider", "spec-mismatch"] as const;

/**
 * no-provider —— 没有「已启用 + openai_compatible + 配了 embeddingModel + 有 baseUrl」的 Provider；
 * spec-mismatch —— 已建索引的维度/模型/后端与当前嵌入器不符，须重建向量索引。
 */
export type KnowledgeEmbeddingBlocker = (typeof KNOWLEDGE_EMBEDDING_BLOCKERS)[number];

/**
 * 嵌入能力状态。不可用**不是错误**（§8.3.3「向量检索是增强，不是前提」），
 * 故做成判别联合让界面必须显式呈现「当前为纯全文检索」，而不是静默少一路召回。
 */
export type KnowledgeEmbeddingStatus =
  | {
      readonly available: true;
      /** 提供嵌入能力的 Provider 显示名。 */
      readonly providerName: string;
      readonly model: string;
    }
  | {
      readonly available: false;
      readonly blocker: KnowledgeEmbeddingBlocker;
      /** 补充说明（如维度不符的具体数字）；面向用户的措辞由渲染层按 blocker 取。 */
      readonly detail?: string;
    };

/** knowledge:list 响应：来源管理页一次取齐的全部事实。 */
export interface KnowledgeOverview {
  /** 全部条目（按导入时间倒序）。 */
  readonly entries: readonly KnowledgeEntryView[];
  /** 全库块数。 */
  readonly totalChunks: number;
  /** 向量索引现状；未建索引时缺席。 */
  readonly vector?: KnowledgeVectorStatus;
  /** 当前嵌入能力。 */
  readonly embedding: KnowledgeEmbeddingStatus;
}

/** 导入路径选择的类别：多选文件，或选一个目录（递归展开）。 */
export type KnowledgePickKind = "files" | "directory";

/** knowledge:pick-paths 请求。 */
export interface KnowledgePickPathsRequest {
  readonly kind: KnowledgePickKind;
}

/** knowledge:pick-paths 响应；取消不是错误，经判别字段区分（同 dialog:pick-directory）。 */
export type KnowledgePickPathsResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly paths: readonly string[] };

/** knowledge:import 请求：导入文件或整个目录（§8.3.2）。 */
export interface KnowledgeImportRequest {
  /** 渲染层生成的关联 ID，贯穿本次导入的全部进度事件。 */
  readonly importId: string;
  /** 文件或目录路径；目录递归展开并按支持的扩展名筛选。 */
  readonly paths: readonly string[];
  /** 给本批条目打的标签（§8.3.4 过滤维度之一）。 */
  readonly tags?: readonly string[];
  /** 忽略内容哈希、强制重新解析与索引（§8.3.2 增量索引的显式旁路）。 */
  readonly force?: boolean;
}

/** knowledge:rebuild 请求：重建索引（重读原文件 → 重新解析分块嵌入）。 */
export interface KnowledgeRebuildRequest {
  readonly importId: string;
  /** 限定重建这些条目；省略 = 全部重建（§8.3.6「一键重建索引」）。 */
  readonly entryIds?: readonly KnowledgeEntryId[];
  /**
   * 连带重建向量索引（先 drop 再按当前嵌入模型重建）。
   * 换了嵌入模型时必须置真——维度/模型不同的向量混在一张表里检索结果毫无意义。
   */
  readonly resetVectors?: boolean;
}

/** 单个文件的失败记录（§单文件失败不中断批量）。 */
export interface KnowledgeImportFailure {
  readonly filePath: string;
  /** 失败原文（开发者可读；界面原样展示，不翻译）。 */
  readonly message: string;
}

/** 导入 / 重建的最终报告。 */
export interface KnowledgeImportReport {
  readonly importId: string;
  /** 扫描到的候选文件数。 */
  readonly scanned: number;
  /** 实际建立 / 更新索引的条目数。 */
  readonly indexed: number;
  /** 因内容哈希未变而跳过的条目数（增量索引的收益）。 */
  readonly skipped: number;
  /** 本次写入的块数。 */
  readonly chunks: number;
  /** 本次成功嵌入的块数。 */
  readonly embedded: number;
  /** 因已有向量而跳过的块数（断点续传的收益）。 */
  readonly embedSkipped: number;
  /** 嵌入失败的块数。 */
  readonly embedFailed: number;
  /** 嵌入致命错误原文（鉴权失败 / 维度不符 / 配置错）；出现即中止取新批次。 */
  readonly embedFatal?: string;
  /** 解析 / 索引阶段的单文件失败明细。 */
  readonly failures: readonly KnowledgeImportFailure[];
  /** 是否被用户取消。 */
  readonly cancelled: boolean;
}

/** 导入阶段（进度条的分段依据）。 */
export const KNOWLEDGE_IMPORT_PHASES = ["scanning", "indexing", "embedding", "done"] as const;

export type KnowledgeImportPhase = (typeof KNOWLEDGE_IMPORT_PHASES)[number];

/** knowledge:import-progress 事件载荷。 */
export interface KnowledgeImportProgressEvent {
  readonly importId: string;
  readonly phase: KnowledgeImportPhase;
  /** 已完成数；scanning 阶段为已扫描文件数。 */
  readonly done: number;
  /** 总数；scanning 阶段总数未知时为 0。 */
  readonly total: number;
  /** 当前处理的文件路径（indexing 阶段）。 */
  readonly currentPath?: string;
}

/** knowledge:cancel-import 请求。 */
export interface KnowledgeCancelImportRequest {
  readonly importId: string;
}

/** 检索过滤条件（§8.3.4 四个过滤维度）。与 storage 的 KnowledgeFilters 同构。 */
export interface KnowledgeSearchFilters {
  /** 格式（OR 语义）。 */
  readonly formats?: readonly KnowledgeFormat[];
  /** 标签（OR 语义）。 */
  readonly tags?: readonly string[];
  /** 来源目录前缀。 */
  readonly sourcePathPrefix?: string;
  /** 导入时间下界（含，epoch 毫秒）。 */
  readonly importedAfter?: number;
  /** 导入时间上界（含，epoch 毫秒）。 */
  readonly importedBefore?: number;
  /** 限定在若干条目内检索。 */
  readonly entryIds?: readonly KnowledgeEntryId[];
}

/** knowledge:search 请求。查询向量由主进程用当前嵌入模型编码，渲染层不碰嵌入。 */
export interface KnowledgeSearchRequest {
  readonly query: string;
  readonly filters?: KnowledgeSearchFilters;
  readonly limit?: number;
}

/** 一条命中（块 + 出处 + 上下文扩展 + 它所属条目的展示信息）。 */
export interface KnowledgeHitView {
  readonly chunk: KnowledgeChunk;
  /** RRF 融合分（越大越靠前）。 */
  readonly score: number;
  /** 命中它的召回路径（"fts" | "like-fallback" | "vector"）。 */
  readonly sources: readonly string[];
  /** 上下文扩展：前后相邻块。 */
  readonly before: readonly KnowledgeChunk[];
  readonly after: readonly KnowledgeChunk[];
  /** 所属条目标题（块本身不带，界面与引用文案都要用）。 */
  readonly entryTitle: string;
  /** 所属条目格式。 */
  readonly entryFormat: KnowledgeFormat;
}

/** knowledge:search 响应：命中 + 本次实际走了哪几路（界面据此说明降级情形）。 */
export interface KnowledgeSearchResponse {
  readonly hits: readonly KnowledgeHitView[];
  /** 关键词路是否走了 FTS（false = 查询过短、回退 LIKE 子串扫描）。 */
  readonly usedFts: boolean;
  /** 向量路是否参与。 */
  readonly usedVector: boolean;
  /** 向量路的过滤是否为精确前置（false = 候选集过大、结果为近似）。 */
  readonly vectorPrefilterExact: boolean;
  /** 向量路缺席的原因；usedVector 为真时缺席。 */
  readonly embeddingBlocker?: KnowledgeEmbeddingBlocker;
}

/**
 * knowledge:create-entry 请求：手动新建条目 / 从会话收录（§8.3.2 导入方式二与三）。
 *
 * 正文经主进程落到 `knowledge/notes/<entryId>.md` 后再建索引——**渲染层不选路径**：
 * 笔记的存储位置是 §10.1 定死的，让界面参与只会多出一处能填错的地方。
 */
export interface KnowledgeCreateEntryRequest {
  /** 渲染层生成的关联 ID，贯穿本次索引的进度事件（同 import）。 */
  readonly importId: string;
  /** 条目标题（来源管理页与检索结果里显示的那个）。 */
  readonly title: string;
  /** Markdown 正文。 */
  readonly content: string;
  /** 标签（§8.3.4 过滤维度之一）。 */
  readonly tags?: readonly string[];
  /** 来源：手动新建，或收录自某个会话的某条消息。 */
  readonly source:
    | { readonly kind: "manual" }
    | { readonly kind: "session_capture"; readonly sessionId: LocalSessionId };
}

/** knowledge:create-entry 响应：新条目 ID + 与导入同形的报告。 */
export interface KnowledgeCreateEntryResult {
  readonly entryId: KnowledgeEntryId;
  /** 落盘路径（§8.4：文件是真实数据源，用户可直接编辑这一份）。 */
  readonly path: string;
  readonly report: KnowledgeImportReport;
}

/** knowledge:remove-entry 请求：移除来源（连带删除其索引与向量，§8.3.6）。 */
export interface KnowledgeRemoveEntryRequest {
  readonly id: KnowledgeEntryId;
}

/** knowledge:export 请求：选中条目 → 单个 Markdown 文件（含出处元数据，§8.3.6）。 */
export interface KnowledgeExportRequest {
  /** 空数组 = 导出全部。 */
  readonly entryIds: readonly KnowledgeEntryId[];
}

/** knowledge:export 响应；取消不是错误。 */
export type KnowledgeExportResult =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      /** 落盘路径。 */
      readonly path: string;
      /** 实际导出的条目数。 */
      readonly entries: number;
    };

/**
 * 旧会话的流式事件形状。自配置工具草案中枢用其中的 config-draft 变体发布草案。
 */
export type SessionStreamEvent =
  | {
      readonly turnId: string;
      readonly kind: "started";
      /** 本轮角色（T8.4 起可为自定义角色 ID）。 */
      readonly role: RoleRef;
      readonly model?: ModelId;
      /**
       * 本轮所属会话（T4.3）。与 turnId 一起构成回放本条目的对齐键（T8.2b）：
       * `TranscriptEntry.turnId` 与这里的 turnId 同源，渲染层据此把实时流与落盘记录接上。
       */
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
      /**
       * Agent 提交了一份配置草案，等用户裁决（T9.1 铁律 2）。**实时推送**而非轮末：
       * sidecar 正拿着这份草案阻塞等待，用户不裁决 Agent 就停在那里——与权限请求
       * 同一交互时效。payload 已过领域校验（校验失败的草案不进用户视野）。
       */
      readonly turnId: string;
      readonly kind: "config-draft";
      /** 草案 ID（回执 session:respond-config-draft 时带回）。 */
      readonly draftId: string;
      /** 人可读摘要（对话框标题行，如 `create provider "DeepSeek"`）。 */
      readonly summary: string;
      readonly payload: ConfigDraftPayload;
      /**
       * 确认后是否需要引导补填密钥（Provider 草案且类型需要 key）。
       * 由主进程按类型判定——渲染层不该自带一份「哪些类型要 key」的知识。
       */
      readonly needsApiKey: boolean;
    }
  | {
      /**
       * 一份配置草案已了结（T9.1）：用户裁决之外的收场（超时 / 轮次结束自动拒绝）
       * 也要让对话框关掉，否则用户面对的是一个回执必然失败的僵尸对话框。
       * 用户自己点了确认/拒绝时渲染层已就地清除，本事件幂等无害。
       */
      readonly turnId: string;
      readonly kind: "config-draft-resolved";
      readonly draftId: string;
    }
  | {
      /**
       * Agent 对工作台自配置工具的全部调用（T9.1，轮次收尾时一次性推出，
       * 照 knowledge-query 款式）：Planner 轮没有 Run，本事件是其唯一可见途径。
       */
      readonly turnId: string;
      readonly kind: "config-tool-calls";
      readonly calls: readonly ConfigToolCallRecord[];
    }
  | {
      /**
       * Agent 调用了只读知识库检索工具（T6.6，§8.3.5 路径二）。
       *
       * **在轮次收尾时一次性推出全部调用，而不是逐次实时推**：调用记录由 sidecar
       * 进程逐行追加到审计文件，主进程与它之间没有连接（那正是 stdio 方案不占端口、
       * 不碰网络的代价），故只能在轮末回读。为此去实时监视文件（fs.watch 在 Windows
       * 上并不可靠、轮询要挂定时器）不值得——用户要的是"看得见 Agent 查了什么"，
       * 晚几秒与实时在这件事上没有区别。
       *
       * Worker 轮的同一批记录还会落进 Run（执行记录页）；Planner 轮没有 Run，
       * 本事件是它唯一的可见途径。
       */
      readonly turnId: string;
      readonly kind: "knowledge-query";
      readonly queries: readonly KnowledgeQueryRecord[];
    }
  | {
      /**
       * 本轮结束时的上下文用量（T9.8 ②，阈值提醒的分子/分母数据源）。
       * 只在适配器折算出 contextTokens 时推送（codex / qwen 的 result usage、
       * grok 的 end usage 与 ACP usage_update），紧挨在 end 事件之前——渲染层
       * 归并时该轮仍在飞、可查到所属会话。windowTokens 仅 grok ACP 自报
       * （usage_update 的 size），缺席时渲染层按模型注册表取窗口。
       */
      readonly turnId: string;
      readonly kind: "context-usage";
      readonly usedTokens: number;
      readonly windowTokens?: number;
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
      /**
       * 本轮（reviewer-review）的审查结论（T7.2）。仅审查轮且结论已写回 Run 时出现。
       *
       * 只带结论字面量而不带整条 ReviewRecord：理由与逐条问题在执行记录页有完整呈现，
       * 事件流这里要回答的只是"刚才那次审查得出了什么"——一个 toast 的信息量。
       */
      readonly reviewVerdict?: ReviewVerdict;
    };

/** invoke（请求/响应）通道契约表。 */
export interface IpcInvokeContracts {
  "app:get-info": { request: undefined; response: AppInfo };
  /** 系统语言检测（Electron 下 navigator.language 不可靠，统一走主进程）。 */
  "app:get-locale": { request: undefined; response: LocaleInfo };
  "app:ping": { request: PingRequest; response: PingResponse };
  "diagnostics:check-sqlite": { request: undefined; response: SqliteCheckReport };
  /** PTY 自检（T10.1；启动期 / smoke 用，渲染层一般不调）。 */
  "diagnostics:check-pty": { request: undefined; response: PtyCheckReport };
  /** 打开系统目录选择器，返回选定目录的绝对路径（取消经判别字段区分，不走错误）。 */
  "dialog:pick-directory": { request: undefined; response: PickDirectoryResult };
  /** 创建内嵌终端（T10.1）；shell 白名单 pwsh/powershell/cmd，cwd 必须是已存在目录。 */
  "terminal:create": { request: CreateTerminalRequest; response: TerminalInfo };
  "terminal:write": { request: TerminalWriteRequest; response: { readonly ok: true } };
  "terminal:resize": { request: TerminalResizeRequest; response: { readonly ok: true } };
  "terminal:kill": { request: TerminalIdRequest; response: { readonly ok: true } };
  "terminal:list": { request: undefined; response: readonly TerminalInfo[] };
  "terminal:get-replay": { request: TerminalIdRequest; response: TerminalReplayResponse };
  /** 读取全部项目工作台布局（T10.2；损坏条目已跳过）。 */
  "workbench:get-layouts": {
    request: undefined;
    response: Readonly<Record<string, ProjectWorkbenchLayout>>;
  };
  /** 原子写入单项目布局（剥离 terminalId）。 */
  "workbench:save-layout": {
    request: SaveWorkbenchLayoutRequest;
    response: { readonly ok: true };
  };
  /** 渲染端确认布局 flush 完成（T10.2' 退出协调）。 */
  "workbench:flush-ack": {
    request: WorkbenchFlushAckRequest;
    response: { readonly ok: true };
  };
  /** 在工作台窗口内启动 Claude Code / Codex（T10.4）。 */
  "workbench:launch-cli": {
    request: LaunchCliWindowRequest;
    response: LaunchCliWindowResponse;
  };
  /** 界面把窗口设为某个角色（T10.6）。 */
  "workbench:set-role": {
    request: SetWorkbenchRoleRequest;
    response: SetWorkbenchRoleResponse;
  };
  /** 界面用户显式修改窗口权限（解开清洗锁）。 */
  "workbench:set-permission": {
    request: SetWorkbenchPermissionRequest;
    response: SetWorkbenchPermissionResponse;
  };
  /** 未知 hook 状态下，用户确认立即投递队列（T10.6'）。 */
  "workbench:deliver-now": {
    request: DeliverWorkbenchPendingRequest;
    response: DeliverWorkbenchPendingResponse;
  };
  /** 丢掉该窗口待投递队列（T10.6'）。 */
  "workbench:deliver-cancel": {
    request: DeliverWorkbenchPendingRequest;
    response: { readonly ok: true };
  };
  /** 模型 / 强度自动续接的结果。失败不自动重试。 */
  "workbench:model-effort-settled": {
    request: ModelEffortSettledRequest;
    response: { readonly ok: true };
  };
  /** 设置页：角色说明书（覆盖副本优先）。 */
  "workbench:list-role-manuals": {
    request: undefined;
    response: ListWorkbenchRoleManualsResponse;
  };
  "workbench:save-role-manual": {
    request: SaveWorkbenchRoleManualRequest;
    response: { readonly ok: true };
  };
  "workbench:reset-role-manual": {
    request: ResetWorkbenchRoleManualRequest;
    response: { readonly ok: true; readonly content: string };
  };
  /** 冷启动后重算标题栏未读与最近汇报（T10.7b）。 */
  "workbench:inbox-badges": {
    request: undefined;
    response: WorkbenchInboxBadgesResponse;
  };
  /** 列出当前项目 `.ffpane/briefs/*.md`（只读，按修改时间倒序）。 */
  "workbench:list-briefs": {
    request: { readonly projectId: ProjectId };
    response: { readonly briefs: readonly WorkbenchBriefListItem[] };
  };
  /** 读取 briefs 内的一份 Markdown。超过上限时截断。 */
  "workbench:read-brief": {
    request: { readonly projectId: ProjectId; readonly relativePath: string };
    response: WorkbenchReadBriefResponse;
  };
  /** 倒序分页读取 `.ffpane/threads/index.jsonl` 尾部。 */
  "workbench:read-threads": {
    request: { readonly projectId: ProjectId; readonly offset: number; readonly limit: number };
    response: WorkbenchReadThreadsResponse;
  };
  /** 用系统默认程序打开 `.ffpane` 内的文件。 */
  "workbench:open-ffpane": {
    request: { readonly projectId: ProjectId; readonly relativePath: string };
    response: { readonly ok: true };
  };
  /** 看板用：各窗口最近汇报与仍在运行的窗口。 */
  "workbench:panel-activity": {
    request: { readonly projectId: ProjectId };
    response: WorkbenchPanelActivityResponse;
  };
  /** 用户确认或取消一份自配置草案。未确认不落盘。 */
  "workbench:respond-config-draft": {
    request: RespondWorkbenchConfigDraftRequest;
    response: ConfigDraftAck;
  };
  /** 列出工作台已登记的全部项目（注册表原样，只读 projects.json，不碰任何项目目录）。 */
  "projects:list": { request: undefined; response: readonly ProjectRegistryEntry[] };
  /**
   * 项目列表页数据源（§11.1，T7.4）：注册表条目 + 当场汇总的派生信息。
   *
   * 与 `projects:list` 分开而不是就地扩展返回值：这一路要为每个项目扫 plans/tasks/runs/
   * sessions 四处磁盘，而 `projects:list` 只要名字和路径。把磁盘扫描塞进它的必经之路，
   * 是让「切个项目」为一屏它根本不显示的信息买单。
   * `projects:create/remove/restore` 也仍返回 `ProjectRegistryEntry`，列表页不必在两种
   * 形状之间转译。
   *
   * 今日 `projects:list` 的消费者有两个：`useActiveProject`，以及命令面板的项目模式
   * （Ctrl+P）——面板自己不调 IPC，列表由挂载方 `App.tsx` 查好经 prop 注入（T8.1 挂载）。
   * 两者都只要名字和路径，故上面那条取舍在消费者变成两个之后照样成立：轻通道就该保持轻。
   */
  "projects:summary": { request: undefined; response: readonly ProjectSummaryView[] };
  /** 登记新项目：生成 .workbench/ 目录结构并写入注册表，返回登记后的条目。 */
  "projects:create": { request: CreateProjectRequest; response: ProjectRegistryEntry };
  /** 从工作台移除项目登记（不删除磁盘文件），返回被移除条目供撤销。 */
  "projects:remove": { request: RemoveProjectRequest; response: ProjectRegistryEntry };
  /** 撤销移除：把被移除的条目原样放回注册表。 */
  "projects:restore": { request: RestoreProjectRequest; response: ProjectRegistryEntry };
  /** 读取项目级设置（project.json 中工作台负责的字段，T6.6）。 */
  "projects:get-settings": { request: ProjectScopedRequest; response: ProjectSettingsView };
  /** 更新项目级设置（非破坏性合并，保留其他工单写入的字段）。 */
  "projects:update-settings": {
    request: UpdateProjectSettingsRequest;
    response: ProjectSettingsView;
  };
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
  /**
   * cli_login 登录态探测（T9.2 ②，接线既有 adapters probeCliLogin）。
   * 只跑非交互状态查询命令，绝不触发登录；超时/异常落 unknown 不挂界面。
   */
  "providers:probe-cli-login": { request: ProbeCliLoginRequest; response: CliLoginProbeView };
  /**
   * cli_login 本地模型枚举（T9.2 ③，接线 adapters listLocalModels）。
   * 支持面按真机调研：codex / opencode / grok-build；claude-code / gemini-cli
   * 如实回 unsupported（无枚举途径，试探未知子命令会起真轮次）。
   */
  "providers:list-local-models": {
    request: ListLocalModelsRequest;
    response: ListLocalModelsResponse;
  };
  /**
   * T9.4b —— 推理强度可见档。非白名单返回空；opencode 读不到该模型 effort values 也返回空。
   */
  "runtimes:reasoning-effort-levels": {
    request: ReasoningEffortLevelsRequest;
    response: ReasoningEffortLevelsResponse;
  };
  /** 取密钥明文尾 4 位（§4.3 规则 3，UI 展示用；不足 4 位返回空串）。 */
  "secrets:masked-tail": { request: MaskedTailRequest; response: { readonly tail: string } };
  /** 读取全局设置（缺字段补出厂默认，§10.1）。 */
  "config:get": { request: undefined; response: GlobalConfig };
  /** 部分更新全局设置（浅合并），返回合并后的完整设置。 */
  "config:update": { request: UpdateConfigRequest; response: GlobalConfig };
  /** 列出全部 Agent Profile（§4.4）。工作台开窗口不再读取。 */
  "profiles:list": { request: undefined; response: readonly AgentProfile[] };
  /** 列出项目配置。文件为空时先写入默认配置。 */
  "configs:list": { request: undefined; response: readonly ProjectConfig[] };
  "configs:create": { request: { readonly draft: ProjectConfigDraft }; response: ProjectConfig };
  "configs:update": {
    request: { readonly id: ProjectConfigId; readonly draft: ProjectConfigDraft };
    response: ProjectConfig;
  };
  "configs:set-default": { request: { readonly id: ProjectConfigId }; response: ProjectConfig };
  "configs:delete": {
    request: { readonly id: ProjectConfigId; readonly newDefaultId?: ProjectConfigId };
    response: { readonly removed: true };
  };
  /** 新建 Profile（经 core 校验 provider/model/角色/权限）。 */
  "profiles:create": { request: CreateProfileRequest; response: AgentProfile };
  /** 整表单更新 Profile。 */
  "profiles:update": { request: UpdateProfileRequest; response: AgentProfile };
  /** 删除 Profile。 */
  "profiles:remove": { request: RemoveProfileRequest; response: { readonly removed: true } };
  /** 列出全部自定义角色（T8.4，§3.1 自定义角色）。 */
  "roles:list": { request: undefined; response: readonly CustomRole[] };
  /** 新建自定义角色（经 core 校验：名称/提示词非空、预设不出项目根、§7 清单不可关）。 */
  "roles:create": { request: CreateRoleRequest; response: CustomRole };
  /** 整表单更新自定义角色。 */
  "roles:update": { request: UpdateRoleRequest; response: CustomRole };
  /** 删除自定义角色（被 Profile 引用时拒删——先解绑再删）。 */
  "roles:remove": { request: RemoveRoleRequest; response: { readonly removed: true } };
  /** 列出当前项目的全部记忆条目（§11.6；含 active / candidate / archived）。 */
  "memory:list": { request: ProjectScopedRequest; response: readonly MemoryEntry[] };
  /** 通过候选（candidate → active，走 updateEntryStatus 迁移文件）。 */
  "memory:approve": { request: MemoryActionRequest; response: MemoryEntry };
  /** 拒绝候选（直接删除，§8.1）。 */
  "memory:reject": { request: MemoryActionRequest; response: { readonly removed: boolean } };
  /** 整条写回（编辑后通过：内容 + 状态一并保存）。 */
  "memory:update": { request: UpdateMemoryRequest; response: MemoryEntry };
  /**
   * 记忆混合检索（T8.7）：FTS/LIKE 关键词路 + 向量语义路 → RRF 融合。
   * 未配嵌入来源时向量路整条缺席、退化为纯关键词检索（§8.3.3 同款一等状态）。
   */
  "memory:search": { request: MemorySearchRequest; response: MemorySearchResponse };
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
  /** 知识库总览（§8.3.6 来源管理：条目 + 文档数/块数 + 索引状态 + 嵌入能力）。 */
  "knowledge:list": { request: undefined; response: KnowledgeOverview };
  /** 打开文件 / 目录选择器（按支持的扩展名过滤），返回选定路径。 */
  "knowledge:pick-paths": {
    request: KnowledgePickPathsRequest;
    response: KnowledgePickPathsResult;
  };
  /** 导入文件 / 文件夹（解析 → 分块 → 索引 → 嵌入）；进度经 knowledge:import-progress 推送。 */
  "knowledge:import": { request: KnowledgeImportRequest; response: KnowledgeImportReport };
  /** 重建索引（重读原文件重跑整条管道）；进度与报告同导入。 */
  "knowledge:rebuild": { request: KnowledgeRebuildRequest; response: KnowledgeImportReport };
  /** 取消在飞的导入 / 重建；ok=false 表示没有该 importId 的在飞任务。 */
  "knowledge:cancel-import": {
    request: KnowledgeCancelImportRequest;
    response: { readonly ok: boolean };
  };
  /** 混合检索（§8.3.4 双路召回 RRF 融合 + 上下文扩展 + 四维过滤）。 */
  /** 手动新建条目 / 从会话收录：正文落 notes/ → 解析分块索引嵌入（§8.3.2）。 */
  "knowledge:create-entry": {
    request: KnowledgeCreateEntryRequest;
    response: KnowledgeCreateEntryResult;
  };
  "knowledge:search": { request: KnowledgeSearchRequest; response: KnowledgeSearchResponse };
  /** 移除来源（连带删除其块、FTS 与向量）。 */
  "knowledge:remove-entry": {
    request: KnowledgeRemoveEntryRequest;
    response: { readonly removed: boolean };
  };
  /** 导出选中条目为单个 Markdown 文件（含出处元数据）。 */
  "knowledge:export": { request: KnowledgeExportRequest; response: KnowledgeExportResult };
  /** 回执一份配置草案的用户裁决（T9.1 铁律 2：确认才落盘；可随手补填密钥）。 */
  "session:respond-config-draft": { request: RespondConfigDraftRequest; response: ConfigDraftAck };
  /** 仅冒烟模式注册：请求主进程向本窗口推送一条 smoke:event。 */
  "smoke:emit-event": { request: { readonly seq: number }; response: { readonly emitted: true } };
  /** 仅冒烟模式注册：上报渲染层检查结果，主进程据此决定退出码。 */
  "smoke:report": { request: SmokeReport; response: { readonly acknowledged: true } };
}

/**
 * 任务落定状态（T9.7 B 栏落定高亮）：done / failed / blocked 三态。
 * 事实源自 T9.10 起移到 @ff-pane/shared（storage 队列与 core 摘要拼装也要消费，
 * 而 packages 不依赖 apps 的契约层）。此处**只做类型再导出**：本文件在 preload 的
 * 依赖图上（preload → client.ts → contracts.ts），运行时再导出会给 sandbox preload
 * 产物引入 require("@ff-pane/shared")（externalizeDepsPlugin 外置后沙箱解析不了，
 * window.ffpane 桥整个失效）——运行时消费方（守卫 / 常量）直接 import @ff-pane/shared。
 */
export type { TaskSettledStatus } from "@ff-pane/shared";

/** 事件（main → renderer 推送）通道契约表。 */
export interface IpcEventContracts {
  /** 仅冒烟模式使用：验证订阅链路的回声事件。 */
  "smoke:event": { payload: { readonly seq: number; readonly emittedAt: number } };
  /** 自配置工具草案事件（config-draft / config-draft-resolved 等）。 */
  "session:event": { payload: SessionStreamEvent };
  /** 知识库导入 / 重建进度（T6.5 / §8.3.2「导入进度」）。 */
  "knowledge:import-progress": { payload: KnowledgeImportProgressEvent };
  /** 终端批量输出（T10.1，约 8–16ms 合并一批）。 */
  "terminal:output": { payload: TerminalOutputEvent };
  /** 终端进程退出（T10.1）。 */
  "terminal:exit": { payload: TerminalExitEvent };
  /** 请渲染端立刻 flush 工作台布局防抖（T10.2' 退出前）。 */
  "workbench:flush-request": { payload: WorkbenchFlushRequestEvent };
  /** Codex 窗口认领到原生会话 id（T10.4'）。 */
  "workbench:session-claimed": { payload: WorkbenchSessionClaimedEvent };
  /** Codex 记号没对上（T10.15b）。 */
  "workbench:session-unidentified": { payload: WorkbenchSessionUnidentifiedEvent };
  /** 刷新本窗口当前对话的最后活动时间（T10.15b）。 */
  "workbench:conversation-touch": { payload: WorkbenchConversationTouchEvent };
  /** 待投递条数变化（T10.6'）。 */
  "workbench:role-notice": { payload: WorkbenchRoleNoticeEvent };
  "workbench:deliver-pending": { payload: WorkbenchDeliverPendingEvent };
  "workbench:model-effort": { payload: WorkbenchModelEffortEvent };
  "workbench:child-window": { payload: WorkbenchChildWindowEvent };
  "workbench:inbox-notice": { payload: WorkbenchInboxNoticeEvent };
  "workbench:open-panel": { payload: WorkbenchOpenPanelEvent };
  "workbench:window-closed": { payload: WorkbenchWindowClosedEvent };
  "workbench:manager-grant": { payload: WorkbenchManagerGrantEvent };
  "workbench:config-draft": { payload: WorkbenchConfigDraftEvent };
  "workbench:config-draft-resolved": { payload: WorkbenchConfigDraftResolvedEvent };
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
  "diagnostics:check-pty",
  "dialog:pick-directory",
  "terminal:create",
  "terminal:write",
  "terminal:resize",
  "terminal:kill",
  "terminal:list",
  "terminal:get-replay",
  "workbench:get-layouts",
  "workbench:save-layout",
  "workbench:flush-ack",
  "workbench:launch-cli",
  "workbench:set-role",
  "workbench:set-permission",
  "workbench:deliver-now",
  "workbench:deliver-cancel",
  "workbench:model-effort-settled",
  "workbench:list-role-manuals",
  "workbench:save-role-manual",
  "workbench:reset-role-manual",
  "workbench:inbox-badges",
  "workbench:list-briefs",
  "workbench:read-brief",
  "workbench:read-threads",
  "workbench:open-ffpane",
  "workbench:panel-activity",
  "workbench:respond-config-draft",
  "projects:list",
  "projects:summary",
  "projects:create",
  "projects:remove",
  "projects:restore",
  "projects:get-settings",
  "projects:update-settings",
  "providers:list",
  "providers:create",
  "providers:update",
  "providers:remove",
  "providers:test-connection",
  "providers:fetch-models",
  "providers:probe-cli-login",
  "providers:list-local-models",
  "runtimes:reasoning-effort-levels",
  "secrets:masked-tail",
  "config:get",
  "config:update",
  "profiles:list",
  "configs:list",
  "configs:create",
  "configs:update",
  "configs:set-default",
  "configs:delete",
  "profiles:create",
  "profiles:update",
  "profiles:remove",
  "roles:list",
  "roles:create",
  "roles:update",
  "roles:remove",
  "memory:list",
  "memory:approve",
  "memory:reject",
  "memory:update",
  "memory:search",
  "habits:list",
  "habits:create",
  "habits:update",
  "habits:approve",
  "habits:reject",
  "habits:set-enabled",
  "habits:check-conflicts",
  "knowledge:list",
  "knowledge:pick-paths",
  "knowledge:import",
  "knowledge:rebuild",
  "knowledge:cancel-import",
  "knowledge:create-entry",
  "knowledge:search",
  "knowledge:remove-entry",
  "knowledge:export",
  "session:respond-config-draft",
  "smoke:emit-event",
  "smoke:report",
] as const satisfies readonly InvokeChannel[];

/** 事件通道运行时允许清单。 */
export const EVENT_CHANNELS = [
  "smoke:event",
  "session:event",
  "knowledge:import-progress",
  "terminal:output",
  "terminal:exit",
  "workbench:flush-request",
  "workbench:session-claimed",
  "workbench:session-unidentified",
  "workbench:conversation-touch",
  "workbench:role-notice",
  "workbench:deliver-pending",
  "workbench:model-effort",
  "workbench:child-window",
  "workbench:inbox-notice",
  "workbench:open-panel",
  "workbench:window-closed",
  "workbench:manager-grant",
  "workbench:config-draft",
  "workbench:config-draft-resolved",
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
