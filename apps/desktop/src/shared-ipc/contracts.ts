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
  KnowledgeChunk,
  KnowledgeEntry,
  KnowledgeEntryId,
  KnowledgeFormat,
  KnowledgeQueryRecord,
  LocalSessionId,
  MemoryEntry,
  MemoryEntryId,
  ModelId,
  Plan,
  PlanStatus,
  PlanVersion,
  ProfileId,
  ProjectId,
  ProjectRegistryEntry,
  Provider,
  ProviderId,
  ReviewVerdict,
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
 * 项目级设置视图（T6.6）：project.json 中工作台当前负责读写的字段。
 * 与 storage 的 ProjectSettings 同构，此处独立声明——契约由渲染层与主进程共享，
 * 不能依赖 node-only 的 @ff-pane/storage（与 ProviderDraft 同一处置）。
 */
export interface ProjectSettingsView {
  /** 设计文档 §8.3.5 —— Agent 只读知识库检索工具开关（缺省关闭）。 */
  readonly knowledgeToolEnabled: boolean;
  /** 设计文档 §3.1 —— Reviewer 角色开关（T7.2，缺省关闭）。 */
  readonly reviewerEnabled: boolean;
  /** 设计文档 §3.1 —— Reviewer 绑定的 Profile（T7.2；未绑定时缺省）。 */
  readonly reviewerProfileId?: ProfileId;
}

/** projects:update-settings 请求：只带要改的字段。 */
export interface UpdateProjectSettingsRequest extends ProjectScopedRequest {
  readonly patch: Partial<ProjectSettingsView>;
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
 * handoff:generate 应答（T7.1，§10.4）：预览文本 + 一份计数摘要。
 *
 * 文本是权威产物（用户编辑它、确认后注入的就是它）；摘要只供预览界面在正文之上
 * 交代"这份交接包里有什么、有多少"——交接包动辄上百行，用户不该靠通读来判断它是否完整。
 * 摘要里全是数字与版本号，**不含任何面向用户的文案**：主进程不产出中文（check-i18n 的
 * 约束在渲染层，但事实源在这里），措辞由渲染层按界面语言取语言包。
 */
export interface HandoffPreview {
  /** 渲染后的交接包正文（Markdown；用户可编辑后原样注入）。 */
  readonly text: string;
  /** 当前计划版本；缺省 = 尚无计划（§10.4 plan 字段为空的诚实表达）。 */
  readonly planVersion?: number;
  /** 交接的任务条数。 */
  readonly taskCount: number;
  /** active 的 decision 记忆条数。 */
  readonly decisionCount: number;
  /** active 的 rule 记忆条数。 */
  readonly ruleCount: number;
  /** 本次取样的 lesson 记忆条数（见 core DEFAULT_RECENT_LESSONS）。 */
  readonly lessonCount: number;
  /** 阻塞与未决问题条数。 */
  readonly openIssueCount: number;
}

/**
 * 会话执行输入（§12 十步流程）：Planner 讨论消息 或 Worker 任务派发。
 * role 由输入类别隐含：planner-message → planner；worker-task → worker。
 */
export type SessionInput =
  | {
      readonly kind: "planner-message";
      readonly text: string;
      /**
       * 习惯先行（T5.3，§8.2.3）：本轮请求「直接做」，跳过据 workflow 流程约束的整形。
       * 单次生效，不影响习惯档案。缺省 = 不跳过（有 workflow 习惯时 Planner 先给整形方案）。
       */
      readonly directExecute?: boolean;
    }
  /**
   * 生成/更新结构化计划（T4.6，§12 步骤"出计划"）：Planner 角色，提示词追加结构化输出合同，
   * 轮结束时主进程解析答复中的计划块 → 落 draft 计划。text 为可选补充指令（缺省即"据讨论出计划"）。
   */
  | { readonly kind: "planner-plan"; readonly text?: string }
  | { readonly kind: "worker-task"; readonly taskId: TaskId }
  /**
   * 审查一次执行（T7.2，§3.1）：Reviewer 角色，注入任务合同的验收标准 + 该 Run 的
   * 证据，权限为角色默认的只读 + verify_only。结论写回 `runId` 指向的那条 Run。
   *
   * 带 runId 而不是只带 taskId：一个任务可以有多条 Run（失败重试，§6.3），
   * "审查这个任务"是有歧义的，"审查这一次尝试"才不是。
   */
  | { readonly kind: "reviewer-review"; readonly taskId: TaskId; readonly runId: RunId };

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
  /**
   * 跨 Agent 交接包正文（T7.1，§10.4）。给出即表示本轮是一次**迁移**：
   * 主进程强制开新会话（换了 Agent，旧会话的原生绑定对新 Agent 无意义）、
   * 把这段文本前置到提示词、并把本轮的会话类型标注为 `handoff`。
   *
   * 传的是**文本**而不是 Handoff 结构体：用户在预览框里改过的那一份才是要注入的那一份
   * （§10.4"预览可编辑，确认后注入"）。若传结构体再由主进程渲染，用户的编辑会被静默丢弃。
   */
  readonly handoffText?: string;
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
  /** 打开系统目录选择器，返回选定目录的绝对路径（取消经判别字段区分，不走错误）。 */
  "dialog:pick-directory": { request: undefined; response: PickDirectoryResult };
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
   * 今日 `projects:list` 的消费者**只有 `useActiveProject` 一个**。命令面板将来也会吃这
   * 份列表，但它不自己调 IPC（列表由挂载方经 prop 注入），且迄今未挂进 `App.tsx`——所以
   * 这里不把它算作现有消费者。上面那条取舍与消费者有几个无关：轻通道就该保持轻。
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
  /** 生成跨 Agent 交接包（T7.1，§10.4）：8 字段组装 + 渲染成可编辑的预览文本。 */
  "handoff:generate": { request: ProjectScopedRequest; response: HandoffPreview };
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

/** habits:suggestion 事件载荷（来源三，§8.2.4）：系统据反复纠正生成的 observed 候选。 */
export interface HabitSuggestionEvent {
  /** 已落库的 observed 候选 ID（供渲染层跳转/高亮）。 */
  readonly habitId: HabitEntryId;
  /** 候选正文（提示文案用）。 */
  readonly content: string;
  /** 触发建议时的累计纠正次数。 */
  readonly count: number;
}

/** 事件（main → renderer 推送）通道契约表。 */
export interface IpcEventContracts {
  /** 仅冒烟模式使用：验证订阅链路的回声事件。 */
  "smoke:event": { payload: { readonly seq: number; readonly emittedAt: number } };
  /** 会话执行流式事件（一轮的 started / text / file-change / command / permission / end）。 */
  "session:event": { payload: SessionStreamEvent };
  /** 系统观察建议（来源三，§8.2.4）：据反复纠正生成的 observed 习惯候选，非阻塞提示。 */
  "habits:suggestion": { payload: HabitSuggestionEvent };
  /** 知识库导入 / 重建进度（§8.3.2「导入进度」）。 */
  "knowledge:import-progress": { payload: KnowledgeImportProgressEvent };
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
  "handoff:generate",
  "knowledge:list",
  "knowledge:pick-paths",
  "knowledge:import",
  "knowledge:rebuild",
  "knowledge:cancel-import",
  "knowledge:create-entry",
  "knowledge:search",
  "knowledge:remove-entry",
  "knowledge:export",
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
  "habits:suggestion",
  "knowledge:import-progress",
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
