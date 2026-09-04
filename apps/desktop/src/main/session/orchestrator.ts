/**
 * 会话执行编排器（T4.2，设计文档 §12 十步流程的执行脊柱）。
 *
 * 职责：把「Profile → 适配器 + Prompt + 权限信封 + 密钥」装配成一轮 guardTurn，
 * 消费其事件流，折算为 SessionStreamEvent 推给渲染层；Worker 轮结束时把证据落成
 * Run 记录并推进任务状态机（dispatch → running → done/failed）。
 *
 * 依赖全部经构造参数注入（注册表、存取、密钥、时钟、ID），故编排逻辑可用假适配器
 * 与假依赖完整单测，不需要真机 CLI。
 *
 * 会话恢复（T4.3，设计文档 §10.3）：每个本地会话登记一条 SessionRecord（Local↔Native
 * ID 映射 + 元数据，不含会话正文）。首轮开新会话；续接轮据登记的原生绑定与适配器
 * 能力判定 native（传 resume 绑定给适配器）或 context_rebuild（重建计划/任务/state/Run
 * 上下文前置到提示词）。session_start 报出的原生会话 ID 回写登记，供后续续接。
 *
 * 跨 Agent 迁移（T7.1，§10.4）：带 handoffText 的一轮强制开新会话，把用户确认过的交接包
 * 正文前置到提示词，会话类型标 handoff。
 *
 * 任务并行（T8.3b，§14 M3）：`active` Map 本就按 turnId 隔离、天然支持多轮并发消费
 * （start 对不同 turnId 从不互斥——T8.3b 前的"单轮"只是渲染层假设，编排器无闸门）。
 * 本单接入的是**互斥裁决**：start 受理时以 checkTurnParallelism 对同项目在飞轮做
 * writePaths 互斥核查，相交即拒绝（ack.conflicts 带明细）；裁决与登记同一同步段完成
 * （admitParallelTurn），Worker 的 dispatchTask 推迟到裁决通过之后。Run 证据隔离无需
 * 额外动作：evidence / answerText / partialChain 全部住在 per-turn 的 ActiveTurn 与
 * GuardedTurn 闭包里，落盘路径按 runId / turnId 派生，多轮交错不共享任何可变缓冲。
 *
 * 审查轮（T7.2，§3.1）：Reviewer 角色的一轮，第 4 层是「任务合同的验收标准 + 被审 Run 的
 * 证据」，权限为角色默认的只读 + verify_only；结论解析后写回**被审的那条 Run**，不铸新
 * Run、不改任务状态（done ≠ accepted 由 acceptTask 在状态机层锁死，§6.3）。
 *
 * 对话回放本与中断收尾（T8.2b，§10.2 规则 3 修订版）：每轮开始写在飞标记 + 追加
 * `user_message`；流式中 assistant 文本节流覆盖写 partial；收尾追加 `assistant_message` +
 * `turn_end` 并删标记。工作台退出时 `prepareForQuit()` 对仍在飞的轮就地收尾
 * （`assistant_message{partial}` + `turn_end{interrupted}`，Worker 轮补 Run(interrupted) 并把
 * 任务拉回 failed），再取消子进程；没赶上的由启动修正（repair.ts）据残留标记补齐。
 * 续接轮 context_rebuild 把该会话最近几条回放本喂给 assembleRebuildContext 作对话摘录。
 *
 * 边界（各归其工单，本编排器不越界）：
 * - Planner 讨论只产出对话，不解析结构化计划（计划生成是后续细化）；
 * - 记忆候选闭环见 T4.4。
 */

import {
  type AdapterTurnContext,
  type GuardedTurn,
  type GuardTurnContext,
  guardTurn,
  type McpStdioServerSpec,
  toStoredRunEvidence,
} from "@ff-pane/adapters";
import {
  type ActiveTurnRecord,
  type ActiveTurnTable,
  assemblePrompt,
  assembleRebuildContext,
  assembleReviewMaterial,
  assembleRunEnvelope,
  checkTurnParallelism,
  compileHabitProfile,
  createInitialDraft,
  createNextDraft,
  decideResumeKind,
  dispatchTask,
  EMPTY_ACTIVE_TURN_TABLE,
  endRun,
  failTask,
  HABIT_FIRST_INSTRUCTION,
  hasActiveWorkflowHabit,
  intersectEnvelopes,
  isDirectExecuteRequest,
  listActiveTurns as listActiveTurnRecords,
  PLAN_OUTPUT_CONTRACT,
  PLANNER_DEFAULT_ENVELOPE,
  parsePlannerPlanDraft,
  parseReviewConclusion,
  REVIEW_OUTPUT_CONTRACT,
  REVIEWER_DEFAULT_ENVELOPE,
  registerActiveTurn,
  settleTaskAfterRun,
  startRun,
  supersedePlan,
  toRunEnvelope,
  unregisterActiveTurn,
  type WritePathsConflict,
} from "@ff-pane/core";
import type {
  AgentProfile,
  AiOutputLanguageSettings,
  ApiKeyRef,
  CommandRecord,
  CustomRole,
  CustomRoleId,
  FileChange,
  GlobalConfig,
  HabitEntry,
  InflightTurnMarker,
  KnowledgeQueryRecord,
  LocalSessionId,
  MemoryEntry,
  ModelId,
  NativeSessionBinding,
  Plan,
  PlanVersion,
  Provider,
  ReviewRecord,
  RoleRef,
  Run,
  RunEndReason,
  RunId,
  SessionRecord,
  SessionResumeKind,
  Task,
  TaskId,
  TranscriptEntry,
  VerifyResult,
} from "@ff-pane/shared";
import { isCustomRoleId } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import type {
  CancelSessionRequest,
  RespondPermissionRequest,
  SessionActionAck,
  SessionStreamEvent,
  StartSessionAck,
  StartSessionRequest,
} from "../../shared-ipc/contracts";
import { resolveRuntimeConfigOverrides, resolveRuntimeEnv } from "./env";
import { mapAgentEvent } from "./event-map";
import { buildInterruptedRun } from "./interrupted";
import type { ProfileAdapterResolver } from "./registry";

/**
 * partial 文本的节流参数（T8.2b）：距上次落盘 ≥ 2 s **或** 新增 ≥ 2 KB 就覆盖写一次。
 * 两个阈值取"或"：慢速流靠时间兜底（每 2 s 至少落一次，中断最多丢 2 s 的字），
 * 快速流靠字节兜底（不让一次 2 s 内涌出的几十 KB 只在内存里）。覆盖写而非追加，
 * 故落盘代价与累计文本长度线性相关、与事件条数无关。
 */
export const PARTIAL_FLUSH_INTERVAL_MS = 2_000;
export const PARTIAL_FLUSH_BYTES = 2_048;

/** 退出时给取消在飞子进程留的等待上限；超时不再等（Job Object 兜底杀进程，T8.2）。 */
export const QUIT_CANCEL_WAIT_MS = 1_500;

/**
 * cancel 后等待 drain 自行注销并行事实的宽限（T8.3b 僵尸注销根治，T8.3a 验收 §2-2）。
 * 适配器 cancel 等树杀确认才返回，返回即子进程已消亡；健康的事件流会在此后立刻以
 * end 收尾、由 drain 的 finally 注销登记。若适配器缺陷导致 cancel 后事件流悬挂，
 * 宽限期到就强制注销并行事实——否则残留记录会在 start 受理的互斥裁决里挡住后续
 * 相交任务的派发（拒绝原因指向一个实际已死的轮）。
 */
export const CANCEL_UNREGISTER_GRACE_MS = 200;

/**
 * 续接轮为对话摘录读回放本的尾部条数。摘录只取 6 条消息（core 缺省），但回放本里每轮
 * 还有一条 turn_end 元数据，故多读一些以保证足够多的消息条目进入取样窗口。
 */
export const REBUILD_TRANSCRIPT_TAIL = 24;

/** prepareForQuit 的回报（供日志 / 单测）。 */
export interface PrepareForQuitReport {
  /** 本次由退出钩子就地收尾的在飞轮数。 */
  readonly interrupted: number;
  /** 取消子进程是否在 QUIT_CANCEL_WAIT_MS 内全部返回。 */
  readonly cancelledInTime: boolean;
}

/** 编排器对外接口。 */
export interface SessionOrchestrator {
  /** 启动一轮；返回是否受理（内容与结果经事件流推送）。 */
  start(request: StartSessionRequest): Promise<StartSessionAck>;
  /** 回执一条上浮的权限请求。 */
  respondPermission(request: RespondPermissionRequest): Promise<SessionActionAck>;
  /** 取消在飞的一轮。 */
  cancel(request: CancelSessionRequest): Promise<SessionActionAck>;
  /** 在飞轮次数（诊断 / 测试）。 */
  activeCount(): number;
  /** 某轮是否仍在本进程在飞（启动修正据此跳过"活着的"标记）。 */
  hasActiveTurn(turnId: string): boolean;
  /**
   * 某项目在飞轮次的并行事实快照（T8.3a，`sessions:active-turns` 的数据源）：
   * 按 startedAt 升序的 ActiveTurnRecord 列表（含装配后信封的 writePaths）。
   * 只读内存态、不触碰磁盘。同一份表也是 start 受理时互斥裁决的输入（T8.3b）：
   * 候选轮与同项目在飞轮的可写范围相交即拒绝受理（ack 带 conflicts 明细）。
   */
  listActiveTurns(projectRoot: string): readonly ActiveTurnRecord[];
  /**
   * 工作台即将退出（T8.2b）：对每个仍在飞的轮就地收尾——transcript 补
   * `assistant_message{partial}` + `turn_end{interrupted}`，Worker 轮补 Run(interrupted) 并把
   * 任务拉回 failed，删在飞标记；随后取消全部子进程并最多等 QUIT_CANCEL_WAIT_MS。
   * 幂等：已由本方法或正常收尾处理过的轮不会被处理第二次。
   */
  prepareForQuit(): Promise<PrepareForQuitReport>;
}

/** 编排器依赖（全部注入，便于测试替身）。 */
export interface SessionOrchestratorDeps {
  /**
   * 按 Profile 解析适配器（T8.4b 多实例装配）：复合键 `<runtime>@<profileId>` 专属
   * 实例优先（generic-exec / aider 这类构造期带配置的 runtime），零配置 runtime
   * 退回裸键单例。拒绝分支的 reason 人可读，编排器原样进 ack.reason。
   */
  readonly registry: ProfileAdapterResolver;
  /** 推送一条会话事件到渲染层（窗口不存在时静默丢弃）。 */
  readonly publish: (event: SessionStreamEvent) => void;
  readonly loadProfile: (id: AgentProfile["id"]) => Promise<AgentProfile | undefined>;
  readonly loadProvider: (id: Provider["id"]) => Promise<Provider | undefined>;
  /**
   * 按 id 读取自定义角色（T8.4；Profile.defaultRole 为 CustomRoleId 的轮次解析用）。
   * 缺省 = 宿主未接自定义角色（一切 CustomRoleId 视为不存在，受理被拒并给出原因）。
   */
  readonly loadCustomRole?: (id: CustomRoleId) => Promise<CustomRole | undefined>;
  readonly revealSecret: (ref: ApiKeyRef) => Promise<string | undefined>;
  readonly resolveLayout: (projectRoot: string) => ProjectLayout;
  /** 项目 active 记忆条目（供 Prompt 注入）。 */
  readonly loadActiveMemory: (layout: ProjectLayout) => Promise<readonly MemoryEntry[]>;
  /**
   * 全部习惯条目（共享记忆，全局，§8.2）。编译器只取 active + enabled 进 Prompt 第 2 层。
   * 习惯跨项目生效，故不接受 layout。
   */
  readonly loadHabits: () => Promise<readonly HabitEntry[]>;
  /**
   * 观察一条用户讨论消息（来源三，§8.2.4）：跨会话累计同类纠正，达阈值生成 observed
   * 候选并提示。可选、fire-and-forget（不阻塞本轮、失败不影响会话）；仅 planner-message 轮调用。
   */
  readonly observeMessage?: (message: string) => void;
  /** memory/state.md 快照文本（Planner 注入；缺省 undefined）。 */
  readonly loadStateSnapshot: (layout: ProjectLayout) => Promise<string | undefined>;
  readonly loadGlobalConfig: () => Promise<GlobalConfig>;
  readonly loadTask: (layout: ProjectLayout, id: Task["id"]) => Promise<Task | undefined>;
  readonly saveTask: (layout: ProjectLayout, task: Task) => Promise<void>;
  readonly listRuns: (layout: ProjectLayout) => Promise<readonly Run[]>;
  /** 读取一条 Run（T7.2 审查轮的取材；不存在返回 undefined）。 */
  readonly loadRun: (layout: ProjectLayout, id: RunId) => Promise<Run | undefined>;
  /**
   * 写回一条已存在 Run 的结构化记录（T7.2 审查结论回写）。
   *
   * 与 persistRun 分开：那个是**铸一条新 Run**（连带 raw.log 与 changes.diff 三件套），
   * 这个只改 run.json 的一个字段。用 persistRun 回写会把原始日志与 diff 用审查轮的
   * 内容覆盖掉——那正是被审查的证据本身。
   */
  readonly updateRun: (layout: ProjectLayout, run: Run) => Promise<void>;
  /** 项目全部任务（上下文重建用）。 */
  readonly listTasks: (layout: ProjectLayout) => Promise<readonly Task[]>;
  /** 最新计划版本（上下文重建用；无计划返回 undefined）。 */
  readonly loadLatestPlan: (layout: ProjectLayout) => Promise<Plan | undefined>;
  /** 读取一条会话登记（续接判定用；不存在返回 undefined）。 */
  readonly loadSession: (
    layout: ProjectLayout,
    id: LocalSessionId,
  ) => Promise<SessionRecord | undefined>;
  /** 落位一条会话登记（按 id upsert）。 */
  readonly saveSession: (layout: ProjectLayout, record: SessionRecord) => Promise<void>;
  /** 落库一份计划（T4.6 计划生成轮：创世 draft / 续版 draft / 旧版 supersede 均经此）。 */
  readonly savePlan: (layout: ProjectLayout, plan: Plan) => Promise<void>;
  /** 落库一条已结束 Run（run.json + raw.log + changes.diff）。 */
  readonly persistRun: (
    layout: ProjectLayout,
    run: Run,
    rawLog: string,
    changesDiff: string,
  ) => Promise<void>;
  /**
   * 对话回放本（T8.2b）：追加一条条目到 `sessions/<sessionId>/transcript.jsonl`。
   * 写失败由编排器记日志、不影响本轮——回放本是记录，不是轮次的前提。
   */
  readonly appendTranscript: (
    layout: ProjectLayout,
    sessionId: LocalSessionId,
    entry: TranscriptEntry,
  ) => Promise<void>;
  /** 读某会话回放本的尾部若干条（续接轮的对话摘录取材；读失败视为空）。 */
  readonly readRecentTranscript: (
    layout: ProjectLayout,
    sessionId: LocalSessionId,
    tail: number,
  ) => Promise<readonly TranscriptEntry[]>;
  /** 落位 / 删除在飞轮次标记（T8.2b；删除对不存在的标记幂等）。 */
  readonly writeInflightMarker: (
    layout: ProjectLayout,
    marker: InflightTurnMarker,
  ) => Promise<void>;
  readonly deleteInflightMarker: (layout: ProjectLayout, turnId: string) => Promise<void>;
  /** 覆盖写在飞轮次的部分 assistant 文本（节流由编排器负责）。 */
  readonly writeInflightPartial: (
    layout: ProjectLayout,
    turnId: string,
    text: string,
  ) => Promise<void>;
  readonly now: () => number;
  readonly newRunId: () => RunId;
  /** 生成一个新的本地会话 ID（开新会话时）。 */
  readonly newLocalSessionId: () => LocalSessionId;
  /**
   * 装配本轮的 Agent 只读知识库检索工具（T6.6，§8.3.5 路径二）。
   *
   * 缺省（未注入）或返回 undefined = 本轮不挂该工具，这也是项目开关默认关闭时的路径。
   * 返回值里的 readAudit 由收尾阶段调用，把 sidecar 写下的调用记录读回 Run。
   */
  readonly prepareKnowledgeTool?: (
    layout: ProjectLayout,
  ) => Promise<KnowledgeToolBinding | undefined>;
}

/** 本轮知识库工具的绑定：注入用的服务端规格 + 收尾用的审计回读。 */
export interface KnowledgeToolBinding {
  /** MCP 服务器注册名。 */
  readonly serverName: string;
  /** 服务端规格（交给适配器按 Runtime 注入）。 */
  readonly spec: McpStdioServerSpec;
  /** 是否允许 Agent 同时保留它自己配置的 MCP 服务端（缺省 false，见 §7 论证）。 */
  readonly inheritUserMcpServers?: boolean;
  /** 读回本轮全部调用记录（一次没调用返回空数组）。 */
  readAudit(): Promise<readonly KnowledgeQueryRecord[]>;
}

/**
 * 一轮的收尾阶段：streaming（事件流消费中）→ finalizing（正常收尾或退出钩子接手）→
 * settled。只有 streaming 的轮能被退出钩子接手；正常收尾与退出钩子谁先把阶段推到
 * finalizing，谁负责落盘，另一方看到非 streaming 即放手——两边不会各写一条 Run。
 */
type TurnPhase = "streaming" | "finalizing" | "settled";

/** 在飞轮次的内部状态。 */
interface ActiveTurn {
  readonly guarded: GuardedTurn;
  /** 收尾所需的上下文（退出钩子接手时要用）。 */
  readonly ctx: TurnContexts;
  phase: TurnPhase;
  /** 已累积的 assistant answer 文本（partial 落盘与收尾 assistant_message 的来源）。 */
  answerText: string;
  /** 上次 partial 落盘时刻 / 自那以后新增的字节数（节流依据）。 */
  partialFlushedAt: number;
  partialPendingBytes: number;
  /** partial 写入串行链：收尾删 partial 前先等它结算，避免迟到的写把文件又造出来。 */
  partialChain: Promise<void>;
  /** drain 的完成承诺：退出钩子等待正在正常收尾的轮用。 */
  done: Promise<void>;
}

/** 一轮开始时记进回放本的用户输入（text-only，见 TranscriptUserMessage 注释）。 */
interface TranscriptUserInput {
  readonly text: string;
  readonly taskId?: TaskId;
  readonly runId?: RunId;
}

/** 一轮收尾后进 turn_end 的摘要（各收尾分支各自给出）。 */
interface TurnEndSummary {
  readonly endReason: RunEndReason;
  readonly runId?: RunId;
  readonly taskId?: TaskId;
}

/** 会话登记上下文（每轮都有；session_start 报出原生 ID 时据此回写登记）。 */
interface SessionContext {
  readonly layout: ProjectLayout;
  readonly sessionId: LocalSessionId;
  readonly role: RoleRef;
  readonly profileId: AgentProfile["id"];
  /** 会话首次创建时间（续接时沿用原值）。 */
  readonly createdAt: number;
  /** 本轮的恢复方式（首轮 undefined）。 */
  readonly resumeKind?: SessionResumeKind;
  /** 已知的原生会话绑定（续接时从登记沿用；session_start 报出新值则覆盖）。 */
  readonly native?: NativeSessionBinding;
}

/** Worker 轮落库所需的上下文（Planner 轮为 undefined）。 */
interface WorkerContext {
  readonly layout: ProjectLayout;
  readonly runningTask: Task;
  readonly profileId: AgentProfile["id"];
  readonly startedAt: number;
}

/** 本轮挂上的知识库工具（未挂时为 undefined）；收尾时据它回读审计。 */
type KnowledgeContext = KnowledgeToolBinding;

/** 计划生成轮（planner-plan）落库所需的上下文（普通 Planner 讨论轮为 undefined）。 */
interface PlanTurnContext {
  readonly layout: ProjectLayout;
}

/** 审查轮（reviewer-review）收尾所需的上下文（T7.2；非审查轮为 undefined）。 */
interface ReviewTurnContext {
  readonly layout: ProjectLayout;
  /** 被审查的那条 Run（结论写回它）。 */
  readonly reviewedRun: Run;
  /** 执行审查的 Profile（与执行者通常不同，故必须随结论留档）。 */
  readonly profileId: AgentProfile["id"];
}

/**
 * 一轮的收尾上下文。四种轮次（Planner 讨论 / 计划生成 / Worker 执行 / 审查）各带各的，
 * 至多一个在场——收成一个对象是为了让新增轮次不必再给 drain/finalize 加一个位置参数
 * （T7.2 前已是六个参数，其中三个可为 undefined，调用点全靠数逗号对齐）。
 */
interface TurnContexts {
  readonly workerCtx?: WorkerContext;
  readonly planCtx?: PlanTurnContext;
  readonly reviewCtx?: ReviewTurnContext;
  readonly sessionCtx: SessionContext;
  readonly knowledgeCtx?: KnowledgeContext;
}

/**
 * 项目根的比较键（在飞轮次按项目过滤用）：分隔符归一 + 小写（Windows 路径大小写
 * 不敏感）+ 去尾斜杠。只服务于"同一个项目根的两种写法应视为同一项目"，
 * 不做 `..` 解析——projectRoot 来自项目注册表，是已归一的绝对路径。
 */
export function normalizeProjectRootKey(projectRoot: string): string {
  const unified = projectRoot.replaceAll("\\", "/").toLowerCase();
  return unified.endsWith("/") && unified.length > 1 ? unified.slice(0, -1) : unified;
}

/**
 * 互斥拒绝的一句话概括（T8.3b）：reason 面向既有消费方（toast 描述），
 * 结构化明细另走 ack.conflicts。首条 conflict 的 reason 已含四要素
 * （哪两个任务、哪两条路径、何种关系），多处相交时补一个总数。
 */
function conflictRejectionReason(conflicts: readonly WritePathsConflict[]): string {
  const first = conflicts[0];
  if (first === undefined) {
    // checkWritePathsExclusive 拒绝时 conflicts 恒非空；此兜底只为类型完整
    return "可写范围与在飞任务相交，已拒绝并行";
  }
  return conflicts.length > 1 ? `${first.reason}（共 ${conflicts.length} 处相交）` : first.reason;
}

export function createSessionOrchestrator(deps: SessionOrchestratorDeps): SessionOrchestrator {
  const active = new Map<string, ActiveTurn>();
  // 在飞轮次的并行事实（T8.3a）：与 active 同生命周期的第二份登记——active 装进程
  // 句柄与收尾上下文，这份装并行裁决要的 writePaths 快照（core 的不可变表 + 纯函数）。
  // 登记 / 注销与 active.set / delete 同点发生，两表不会漂移。
  let parallelTable: ActiveTurnTable = EMPTY_ACTIVE_TURN_TABLE;
  const turnProjects = new Map<string, string>();

  function outputLanguageSettings(
    config: GlobalConfig,
    profile: AgentProfile,
  ): AiOutputLanguageSettings {
    return {
      global: config.aiOutputLanguage,
      ...(profile.outputLanguage !== undefined ? { profile: profile.outputLanguage } : {}),
    };
  }

  /**
   * 从登记事实（计划/任务/state/最近 Run）+ 该会话回放本尾部重建上下文文本（context_rebuild 用）。
   * 回放本读失败视为"无摘录"：重建的其余材料仍成立，不该因一份记录读不出来就拒绝续接。
   */
  async function buildRebuildContext(
    layout: ProjectLayout,
    sessionId: LocalSessionId,
  ): Promise<string> {
    const [plan, tasks, stateSnapshot, runs, recentTranscript] = await Promise.all([
      deps.loadLatestPlan(layout),
      deps.listTasks(layout),
      deps.loadStateSnapshot(layout),
      deps.listRuns(layout),
      deps.readRecentTranscript(layout, sessionId, REBUILD_TRANSCRIPT_TAIL).catch((thrown) => {
        console.warn(`[session] transcript unavailable for rebuild: ${String(thrown)}`);
        return [] as readonly TranscriptEntry[];
      }),
    ]);
    return assembleRebuildContext({
      ...(plan !== undefined ? { plan } : {}),
      tasks,
      ...(stateSnapshot !== undefined ? { stateSnapshot } : {}),
      recentRuns: runs,
      recentTranscript,
    });
  }

  /** 回放本 / 标记写入的统一容错：记日志、不抛——记录不是轮次的前提。 */
  async function recordSafely(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (thrown) {
      console.warn(`[session] ${what} failed: ${String(thrown)}`);
    }
  }

  /**
   * 并行互斥裁决 + 事实登记（T8.3b，同一同步段完成）。
   *
   * 裁决与登记之间**不允许有 await**——两轮并发受理时后到者必须看见先到者的登记，
   * 否则两个相交任务会同时通过裁决（先检查后登记的竞态）。故受理路径在信封定形后
   * 立即「裁决即登记」，此后任何一步失败由 start 的 catch 回滚登记。由此登记点
   * 先于 active.set 若干个 await，start 入口的同 turnId 去重须两表都查。
   *
   * 只与**同项目**的在飞轮互斥（writePaths 是相对项目根的模式，跨项目同名路径
   * 不是同一批文件）。项目归属缺失（登记在表但 turnProjects 没有）的记录按
   * 宁拒勿并参与一切项目的裁决：正常路径两份登记同点增删不会漂移，该分支只在
   * 注销点被部分破坏时可观察（T8.3a 验收 §3-④「单删 parallelTable 未红」的用例锚点）。
   */
  function admitParallelTurn(params: {
    readonly turnId: string;
    readonly projectRoot: string;
    readonly sessionId: LocalSessionId;
    readonly role: RoleRef;
    readonly taskId?: TaskId;
    readonly writePaths: readonly string[];
  }):
    | { readonly admitted: true; readonly startedAt: number }
    | { readonly admitted: false; readonly ack: StartSessionAck } {
    const rootKey = normalizeProjectRootKey(params.projectRoot);
    const sameProject = new Map(
      [...parallelTable].filter(([turnId]) => {
        const project = turnProjects.get(turnId);
        return project === rootKey || project === undefined;
      }),
    );
    const decision = checkTurnParallelism(sameProject, {
      turnId: params.turnId,
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      writePaths: params.writePaths,
    });
    if (!decision.canRunInParallel) {
      return {
        admitted: false,
        ack: {
          accepted: false,
          reason: conflictRejectionReason(decision.conflicts),
          conflicts: decision.conflicts,
        },
      };
    }
    const startedAt = deps.now();
    parallelTable = registerActiveTurn(parallelTable, {
      turnId: params.turnId,
      sessionId: params.sessionId,
      role: params.role,
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      writePaths: params.writePaths,
      startedAt,
    });
    turnProjects.set(params.turnId, rootKey);
    return { admitted: true, startedAt };
  }

  /**
   * 释放一轮的并行事实（幂等）。**必须先于该轮 end 事件的 publish 调用**：渲染层收到
   * end 即重取 `sessions:active-turns`，若此时登记未删，重取拿到的是含死轮的快照、
   * 且此后再无触发器纠正（一次可复现的 E2E 竞态）。进入 finalize / settleInterrupted
   * 即释放在语义上成立——end 已到手，子进程不会再写任何文件。
   * active 句柄表不在此清（收尾仍要经 turn 推进），归 drain 的 finally。
   */
  function releaseParallelFacts(turnId: string): void {
    parallelTable = unregisterActiveTurn(parallelTable, turnId);
    turnProjects.delete(turnId);
  }

  /**
   * 僵尸注销根治（T8.3b，T8.3a 验收 §2-2 主管理员裁定）：cancel 返回即子进程已消亡，
   * 健康的事件流会紧接着以 end 收尾、由 drain 的 finally 注销登记；若适配器缺陷让
   * 流悬挂，宽限期到就强制注销并行事实——互斥裁决接入后，残留记录会拿一个实际
   * 已死的轮去挡后续相交任务的派发。只清并行事实（裁决与呈现的数据源），
   * active 句柄表留给 drain：流若日后终结，finally 的注销幂等。
   */
  async function unregisterAfterCancelGrace(turnId: string, turn: ActiveTurn): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => {
      timer = setTimeout(() => resolve("grace"), CANCEL_UNREGISTER_GRACE_MS);
    });
    const outcome = await Promise.race([
      turn.done.then(
        () => "drained" as const,
        () => "drained" as const,
      ),
      grace,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (outcome === "grace" && parallelTable.has(turnId)) {
      console.warn(`[session] turn ${turnId} stream hung after cancel; parallel facts released`);
      parallelTable = unregisterActiveTurn(parallelTable, turnId);
      turnProjects.delete(turnId);
    }
  }

  /** 落位会话登记（upsert）。binding 覆盖 ctx.native（session_start 报出新原生 ID 时）。 */
  async function registerSession(
    ctx: SessionContext,
    binding?: NativeSessionBinding,
  ): Promise<void> {
    const native = binding ?? ctx.native;
    const record: SessionRecord = {
      id: ctx.sessionId,
      profileId: ctx.profileId,
      role: ctx.role,
      createdAt: ctx.createdAt,
      lastActiveAt: deps.now(),
      ...(native !== undefined ? { native } : {}),
      ...(ctx.resumeKind !== undefined ? { resumeKind: ctx.resumeKind } : {}),
    };
    await deps.saveSession(ctx.layout, record);
  }

  async function start(request: StartSessionRequest): Promise<StartSessionAck> {
    // 同 turnId 去重：active 之外还要查并行事实表——受理路径里登记先于 active.set
    // 若干个 await（见下方「先裁决即登记」），只查 active 会留一个重复受理窗口。
    if (active.has(request.turnId) || parallelTable.has(request.turnId)) {
      return { accepted: false, reason: "该轮次已在执行中" };
    }
    // 本轮是否已写入并行事实表（受理失败时 catch 里据此回滚，不误删他轮登记）。
    let parallelRegistered = false;
    try {
      const profile = await deps.loadProfile(request.profileId);
      if (profile === undefined) {
        return { accepted: false, reason: "Profile 不存在" };
      }
      // 按 Profile 解析适配器（T8.4b）：复合键专属实例或裸键单例；拒绝原因人可读
      // （「Runtime 未注册」或 generic-exec 配置缺失/非法的指引）。
      const resolution = deps.registry.resolveForProfile(profile);
      if (!resolution.ok) {
        return { accepted: false, reason: resolution.reason };
      }
      const adapter = resolution.adapter;
      const provider = await deps.loadProvider(profile.providerId);
      if (provider === undefined) {
        return { accepted: false, reason: "Provider 不存在" };
      }

      // 角色解析（T8.4）：Worker / 审查轮由派发管线决定角色；讨论轮（planner-message）
      // 在 Profile 绑定自定义角色（defaultRole 为 CustomRoleId）时以该角色行事——
      // Prompt 第 1 层用其 systemPrompt，信封 = 角色预设 ∩ Profile 预设（同款交集公式）。
      // 计划生成轮（planner-plan）是结构化管线（PLAN_OUTPUT_CONTRACT 解析落盘），恒按
      // planner 执行——自定义角色没有计划解析的输出合同，放进去只会产出解析不了的文本。
      let role: RoleRef;
      let customRole: CustomRole | undefined;
      if (request.input.kind === "worker-task") {
        role = "worker";
      } else if (request.input.kind === "reviewer-review") {
        role = "reviewer";
      } else if (request.input.kind === "planner-message" && isCustomRoleId(profile.defaultRole)) {
        customRole =
          deps.loadCustomRole !== undefined
            ? await deps.loadCustomRole(profile.defaultRole)
            : undefined;
        if (customRole === undefined) {
          return { accepted: false, reason: `自定义角色不存在：${profile.defaultRole}` };
        }
        role = profile.defaultRole;
      } else {
        role = "planner";
      }
      const layout = deps.resolveLayout(request.projectRoot);
      const [memory, config, habits] = await Promise.all([
        deps.loadActiveMemory(layout),
        deps.loadGlobalConfig(),
        deps.loadHabits(),
      ]);
      const outputLanguage = outputLanguageSettings(config, profile);
      // 习惯档案（§8.2.2）：编译 active + enabled 习惯为 Prompt 第 2 层文本（跨项目、跨角色生效）。
      const habitProfile = compileHabitProfile(habits);

      // 跨 Agent 迁移（T7.1，§10.3 第三分支 / §10.4）：带交接包正文的一轮。
      // 换了 Agent，旧会话的原生绑定对新 Agent 毫无意义（那是另一个 CLI 的会话文件），
      // 上下文重建同样不该走——重建假装"你续上了自己的历史"，而这里恰恰不是。故一律开新会话，
      // 注入用户确认过的交接包正文，会话类型如实标 handoff（§2「不伪装成会话恢复」）。
      const trimmedHandoff = request.handoffText?.trim();
      // 空白正文按"没给"处理：一个只剩空格的交接包既不该改变会话类型，也不该在提示词里
      // 占一个空段落让 Agent 以为交接内容被吞了。
      const handoffText =
        trimmedHandoff !== undefined && trimmedHandoff.length > 0 ? trimmedHandoff : undefined;
      const migrating = handoffText !== undefined;

      // 会话恢复（T4.3）：判定本轮所属会话与恢复方式。
      // 首轮（无 sessionId 或该会话未登记）= 全新会话；续接轮据登记的原生绑定 + cwd +
      // 适配器能力判定 native / context_rebuild。
      const sessionId = migrating
        ? deps.newLocalSessionId()
        : (request.sessionId ?? deps.newLocalSessionId());
      const existing =
        !migrating && request.sessionId !== undefined
          ? await deps.loadSession(layout, request.sessionId)
          : undefined;
      const priorBinding = existing?.native;
      let resumeKind: SessionResumeKind | undefined;
      let resumeBinding: NativeSessionBinding | undefined;
      let resumeContext: string | undefined;
      if (migrating) {
        resumeKind = "handoff";
      } else if (existing !== undefined) {
        resumeKind = decideResumeKind({
          hasNativeBinding: priorBinding !== undefined,
          bindingCwdMatches: priorBinding?.cwd === request.projectRoot,
          supportsNativeResume: adapter.capabilities().nativeResume === "yes",
        });
        if (resumeKind === "native" && priorBinding !== undefined) {
          resumeBinding = priorBinding;
        } else {
          resumeContext = await buildRebuildContext(layout, sessionId);
        }
      }

      // 密钥解密 → Run 级注入环境变量（唯一密钥通道，§4.3）
      const apiKeyPlaintext =
        provider.apiKeyRef !== undefined ? await deps.revealSecret(provider.apiKeyRef) : undefined;
      const env = resolveRuntimeEnv({
        runtime: profile.runtime,
        provider,
        ...(apiKeyPlaintext !== undefined ? { apiKeyPlaintext } : {}),
      });
      // 运行时配置覆盖（如 openai_compatible → codex model_provider 路由，§T4.5 方案 A）
      const configOverrides = resolveRuntimeConfigOverrides({ runtime: profile.runtime, provider });
      const model: ModelId | undefined = profile.model ?? provider.defaultModel;

      // 组装 Prompt + 权限信封（Worker 从任务合同派生，Planner 用只读角色默认）
      let prompt: string;
      let guardCtx: GuardTurnContext;
      let workerCtx: WorkerContext | undefined;
      let planCtx: PlanTurnContext | undefined;
      let reviewCtx: ReviewTurnContext | undefined;
      // Worker 轮待派发的任务合同（T8.3b：dispatchTask 推迟到互斥裁决通过后）。
      let workerTaskToDispatch: Task | undefined;
      // 进回放本的用户输入（T8.2b）：只记用户可见的原始输入，见 TranscriptUserMessage 注释
      let transcriptUser: TranscriptUserInput;

      if (request.input.kind === "reviewer-review") {
        // 审查轮（T7.2，§3.1）：注入任务合同的验收标准 + 本次 Run 的证据，权限走
        // Reviewer 角色默认（只读 + verify_only）。
        const task = await deps.loadTask(layout, request.input.taskId);
        if (task === undefined) {
          return { accepted: false, reason: "任务不存在" };
        }
        const reviewedRun = await deps.loadRun(layout, request.input.runId);
        if (reviewedRun === undefined) {
          return { accepted: false, reason: "执行记录不存在" };
        }
        if (reviewedRun.taskId !== task.id) {
          // 该 Run 不属于这个任务：拿 A 任务的验收标准去审 B 任务的改动，结论必然是垃圾。
          return { accepted: false, reason: "该执行记录不属于这个任务" };
        }
        prompt = `${assemblePrompt({
          role: "reviewer",
          // 第 4 层给审查材料而非任务合同：合同渲染的是执行指令（"你只能改这些路径"），
          // 那会把审查者往"我该做点什么"的方向带（见 core assembleReviewMaterial 注释）。
          input: { kind: "message", text: assembleReviewMaterial({ task, run: reviewedRun }) },
          projectMemory: memory,
          outputLanguage,
          ...(habitProfile !== undefined ? { habitProfile } : {}),
        })}\n\n${REVIEW_OUTPUT_CONTRACT}`;
        reviewCtx = { layout, reviewedRun, profileId: profile.id };
        transcriptUser = { text: task.goal, taskId: task.id, runId: reviewedRun.id };
        // 审查者的信封：角色默认 ∩ Profile 预设。**不走 assembleRunEnvelope**——那条
        // 路径会把任务合同的 writeScope 并进来，而任务信封的 shell 是 "allowed"、
        // writePaths 是任务允许写的那些路径。虽然与 Reviewer 角色默认相交后 shell 仍会
        // 收窄回 verify_only、writePaths 与空集相交仍为空，结果是对的，但那是"靠交集
        // 恰好救回来"，读代码的人得自己在脑子里算一遍才敢确信审查者不能写文件。
        // 直接用角色默认相交 Profile 预设，"审查者不可写"是当场可见的事实。
        // verifyCommands 照给：verify_only 的白名单正是任务合同的验证命令（§7）。
        const reviewerEnvelope = toRunEnvelope(
          intersectEnvelopes(REVIEWER_DEFAULT_ENVELOPE, profile.permissionPreset),
        );
        guardCtx = {
          cwd: request.projectRoot,
          envelope: reviewerEnvelope,
          ...(task.verifyCmd !== undefined ? { verifyCommands: [task.verifyCmd] } : {}),
          ...(Object.keys(env).length > 0 ? { secrets: env } : {}),
        };
      } else if (request.input.kind === "worker-task") {
        const task = await deps.loadTask(layout, request.input.taskId);
        if (task === undefined) {
          return { accepted: false, reason: "任务不存在" };
        }
        const assembled = assembleRunEnvelope({
          role: "worker",
          taskContract: task,
          profilePreset: profile.permissionPreset,
        });
        prompt = assemblePrompt({
          role: "worker",
          input: { kind: "task", contract: task },
          projectMemory: memory,
          outputLanguage,
          ...(habitProfile !== undefined ? { habitProfile } : {}),
        });
        // 派发（pending|failed → running）推迟到互斥裁决通过之后（T8.3b）：
        // 被拒并行的派发不该把任务推进 running 再拉回来。此处只记要派发的合同。
        workerTaskToDispatch = task;
        transcriptUser = { text: task.goal, taskId: task.id };
        guardCtx = {
          cwd: request.projectRoot,
          envelope: assembled.envelope,
          forbiddenPaths: assembled.forbiddenPaths,
          verifyCommands: assembled.verifyCommands,
          ...(Object.keys(env).length > 0 ? { secrets: env } : {}),
        };
      } else {
        const stateSnapshot = await deps.loadStateSnapshot(layout);
        // planner-plan（计划生成轮）：text 可选，缺省给一句默认指令；否则用讨论消息原文
        const messageText =
          request.input.kind === "planner-plan"
            ? (request.input.text ?? "请基于以上讨论产出结构化计划。")
            : request.input.text;
        // 计划生成轮无补充指令时记的是那句缺省指令——它就是 Agent 实际收到的用户层输入
        transcriptUser = { text: messageText };
        // 第 1 层（T8.4）：自定义角色轮用其 systemPrompt 原文（resolveRoleDefinition），
        // 内置 planner 轮走 ROLE_DEFINITIONS 静态文本，逐字不变。
        prompt = assemblePrompt({
          role,
          ...(customRole !== undefined ? { customRoleDefinition: customRole.systemPrompt } : {}),
          input: { kind: "message", text: messageText },
          projectMemory: memory,
          outputLanguage,
          ...(stateSnapshot !== undefined ? { stateSnapshot } : {}),
          ...(habitProfile !== undefined ? { habitProfile } : {}),
        });
        // 计划生成轮：追加结构化输出合同（放最末 = 最新指令），并登记 planCtx 供收尾解析落盘
        if (request.input.kind === "planner-plan") {
          prompt = `${prompt}\n\n${PLAN_OUTPUT_CONTRACT}`;
          planCtx = { layout };
        } else if (
          // 习惯先行（T5.3，§8.2.3）：讨论轮存在 workflow 流程约束且本轮未请求「直接做」→
          // 追加整形指令，让 Planner 先给分步方案再执行。planner-plan 已是"先提方案"，不叠加。
          request.input.directExecute !== true &&
          !isDirectExecuteRequest(request.input.text) &&
          hasActiveWorkflowHabit(habits)
        ) {
          prompt = `${prompt}\n\n${HABIT_FIRST_INSTRUCTION}`;
        }
        // 来源三（§8.2.4）：观察本条讨论消息（跨会话累计纠正 → 达阈值生成 observed 候选）。
        // fire-and-forget，不阻塞本轮、失败不影响会话。仅普通讨论轮（非计划生成轮）。
        if (request.input.kind === "planner-message") {
          deps.observeMessage?.(request.input.text);
        }
        // 信封：角色默认 ∩ Profile 预设。自定义角色（T8.4）的「角色默认」层是其
        // permissionPreset（照 T7.2 Reviewer 款式直接相交，不走 assembleRunEnvelope——
        // 讨论轮没有任务合同）；交集公式不变，§7 危险清单由类型 + 校验器 + 裁决层三重锁死。
        const roleDefault =
          customRole !== undefined ? customRole.permissionPreset : PLANNER_DEFAULT_ENVELOPE;
        const turnEnvelope = toRunEnvelope(
          intersectEnvelopes(roleDefault, profile.permissionPreset),
        );
        guardCtx = {
          cwd: request.projectRoot,
          envelope: turnEnvelope,
          ...(Object.keys(env).length > 0 ? { secrets: env } : {}),
        };
      }

      // 并行互斥裁决（T8.3b，§14 M3「文件范围不重叠的任务同时派发」）：信封定形即
      // 裁决，通过即在同一同步段登记并行事实（防两轮并发受理互不相见的竞态，见
      // admitParallelTurn 注释）；拒绝走 ack.conflicts 预留分支，reason 人可读。
      const parallelTaskId: TaskId | undefined =
        workerTaskToDispatch?.id ?? reviewCtx?.reviewedRun.taskId;
      const admission = admitParallelTurn({
        turnId: request.turnId,
        projectRoot: request.projectRoot,
        sessionId,
        role,
        ...(parallelTaskId !== undefined ? { taskId: parallelTaskId } : {}),
        writePaths: guardCtx.envelope.writePaths,
      });
      if (!admission.admitted) {
        return admission.ack;
      }
      parallelRegistered = true;
      const startedAt = admission.startedAt;

      // 派发（pending|failed → running）在裁决通过后才发生：被拒并行的任务保持原状，
      // 用户看到的是「没派出去」而不是「派出去又失败了一次」。非法态由状态机抛错，
      // 落入下方 catch（并回滚并行登记）。
      if (workerTaskToDispatch !== undefined) {
        const runningTask = dispatchTask(workerTaskToDispatch);
        await deps.saveTask(layout, runningTask);
        workerCtx = { layout, runningTask, profileId: profile.id, startedAt };
      }

      // 上下文重建：把重建文本前置到提示词（native 恢复走原生会话，不注入）
      if (resumeContext !== undefined) {
        prompt = `${resumeContext}\n\n${prompt}`;
      }
      // 跨 Agent 迁移：注入用户预览并确认过的交接包正文（§10.4）。注入的是**渲染层送来的文本**
      // 而非在这里重新渲染一遍——用户在预览框里改过的那一份才是他确认的那一份。
      // 与 resumeContext 互斥（migrating 时不会走恢复分支），故两者不会同时前置。
      if (handoffText !== undefined) {
        prompt = `${handoffText}\n\n${prompt}`;
      }

      // Agent 只读知识库检索工具（T6.6，§8.3.5 路径二）：项目开关开启时才装配。
      // 两个角色都挂——Planner 讨论方案时正是最需要查资料的时候。装配失败不该
      // 拖垮整轮（工具是增强而非前提），故失败只记日志、本轮无此工具照常执行。
      let knowledgeCtx: KnowledgeContext | undefined;
      try {
        knowledgeCtx = await deps.prepareKnowledgeTool?.(layout);
      } catch (thrown) {
        console.warn(`[session] knowledge tool unavailable this turn: ${String(thrown)}`);
      }

      const turnCtx: AdapterTurnContext = {
        cwd: request.projectRoot,
        prompt,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(configOverrides).length > 0 ? { configOverrides } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(resumeBinding !== undefined ? { resume: resumeBinding } : {}),
        ...(knowledgeCtx !== undefined
          ? {
              mcpServers: { [knowledgeCtx.serverName]: knowledgeCtx.spec },
              ...(knowledgeCtx.inheritUserMcpServers === true
                ? { inheritUserMcpServers: true }
                : {}),
            }
          : {}),
      };

      // 登记会话（首轮建档；续接轮沿用 createdAt + 已知原生绑定）。session_start 报出
      // 新原生 ID 时由 drain 回写覆盖。即便本轮失败，会话已可被后续续接。
      const sessionCtx: SessionContext = {
        layout,
        sessionId,
        role,
        profileId: profile.id,
        createdAt: existing?.createdAt ?? deps.now(),
        ...(resumeKind !== undefined ? { resumeKind } : {}),
        ...(priorBinding !== undefined ? { native: priorBinding } : {}),
      };
      await registerSession(sessionCtx);

      // 在飞标记 + 回放本 user_message（T8.2b）：都在 spawn 之前落盘。标记先于子进程存在，
      // 才能保证"有子进程在跑却没有标记"这个窗口不存在——退出/崩溃后修正逻辑不会漏掉它。
      const marker: InflightTurnMarker = {
        turnId: request.turnId,
        sessionId,
        role,
        profileId: profile.id,
        startedAt,
        ...(resumeKind !== undefined ? { resumeKind } : {}),
        ...(workerCtx !== undefined ? { taskId: workerCtx.runningTask.id } : {}),
        ...(reviewCtx !== undefined
          ? { taskId: reviewCtx.reviewedRun.taskId, runId: reviewCtx.reviewedRun.id }
          : {}),
      };
      await recordSafely("inflight marker write", () => deps.writeInflightMarker(layout, marker));
      await recordSafely("transcript user_message append", () =>
        deps.appendTranscript(layout, sessionId, {
          kind: "user_message",
          turnId: request.turnId,
          at: startedAt,
          text: transcriptUser.text,
          ...(transcriptUser.taskId !== undefined ? { taskId: transcriptUser.taskId } : {}),
          ...(transcriptUser.runId !== undefined ? { runId: transcriptUser.runId } : {}),
        }),
      );

      const guarded = guardTurn(adapter.startTurn(turnCtx), guardCtx);
      const ctx: TurnContexts = {
        ...(workerCtx !== undefined ? { workerCtx } : {}),
        ...(planCtx !== undefined ? { planCtx } : {}),
        ...(reviewCtx !== undefined ? { reviewCtx } : {}),
        sessionCtx,
        ...(knowledgeCtx !== undefined ? { knowledgeCtx } : {}),
      };
      const turn: ActiveTurn = {
        guarded,
        ctx,
        phase: "streaming",
        answerText: "",
        partialFlushedAt: startedAt,
        partialPendingBytes: 0,
        partialChain: Promise.resolve(),
        done: Promise.resolve(),
      };
      active.set(request.turnId, turn);
      // 并行事实已在裁决通过时登记（admitParallelTurn，writePaths 取装配后信封）——
      // 登记先行是并发受理防竞态的要求，此处只补 active 句柄表。
      deps.publish({
        turnId: request.turnId,
        kind: "started",
        role,
        sessionId,
        ...(model !== undefined ? { model } : {}),
        ...(resumeKind !== undefined ? { resumeKind } : {}),
      });

      // 事件流消费独立于受理应答（fire-and-forget，结束时清理登记）
      turn.done = drain(request.turnId, turn).finally(() => {
        active.delete(request.turnId);
        parallelTable = unregisterActiveTurn(parallelTable, request.turnId);
        turnProjects.delete(request.turnId);
      });

      return { accepted: true, turnId: request.turnId, sessionId };
    } catch (thrown) {
      // 裁决通过后任何一步失败（派发状态机抛错 / spawn 同步抛错等）：回滚并行登记，
      // 不让一个从未起飞的轮占着可写范围挡后续派发。
      if (parallelRegistered) {
        parallelTable = unregisterActiveTurn(parallelTable, request.turnId);
        turnProjects.delete(request.turnId);
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return { accepted: false, reason: message };
    }
  }

  /**
   * partial 文本节流落盘（T8.2b）：阈值见 PARTIAL_FLUSH_*。写入挂在 per-turn 串行链上，
   * 慢盘时多次触发只会排队不会并发覆盖；失败记日志——partial 只是中断时的抢救材料。
   */
  function flushPartialIfDue(turnId: string, turn: ActiveTurn): void {
    const now = deps.now();
    const due =
      turn.partialPendingBytes >= PARTIAL_FLUSH_BYTES ||
      now - turn.partialFlushedAt >= PARTIAL_FLUSH_INTERVAL_MS;
    if (!due || turn.partialPendingBytes === 0) {
      return;
    }
    turn.partialFlushedAt = now;
    turn.partialPendingBytes = 0;
    const snapshot = turn.answerText;
    const layout = turn.ctx.sessionCtx.layout;
    turn.partialChain = turn.partialChain.then(() =>
      recordSafely("inflight partial write", () =>
        deps.writeInflightPartial(layout, turnId, snapshot),
      ),
    );
  }

  /** 消费一轮的事件流，推增量、收尾落库。 */
  async function drain(turnId: string, turn: ActiveTurn): Promise<void> {
    const { guarded, ctx } = turn;
    const { workerCtx, sessionCtx } = ctx;
    let verifyResult: VerifyResult | undefined;
    const verifyCmd = workerCtx?.runningTask.verifyCmd;

    try {
      for await (const event of guarded.events) {
        if (event.kind === "end") {
          await finalize(turnId, turn, {
            reason: event.reason,
            ...(event.message !== undefined ? { message: event.message } : {}),
            report: turn.answerText,
            ...(verifyResult !== undefined ? { verifyResult } : {}),
          });
          return;
        }
        if (event.kind === "session_start") {
          // 原生会话 ID 报出即回写登记（cwd 成对，供后续续接原生恢复，§10.2 规则 3）
          if (event.native !== undefined) {
            await registerSession(sessionCtx, event.native).catch(() => undefined);
          }
          continue;
        }
        if (event.kind === "text" && event.channel === "answer") {
          turn.answerText += event.content;
          turn.partialPendingBytes += Buffer.byteLength(event.content, "utf8");
          flushPartialIfDue(turnId, turn);
        }
        // 捕获验证命令结果（供 completeTask 的 done 门槛判定）
        if (
          verifyCmd !== undefined &&
          event.kind === "command" &&
          (event.status === "completed" || event.status === "failed") &&
          event.command.trim() === verifyCmd.trim()
        ) {
          verifyResult = {
            command: verifyCmd,
            exitCode: event.exitCode ?? -1,
            output: event.output ?? "",
          };
        }
        const mapped = mapAgentEvent(turnId, event);
        if (mapped !== null) {
          deps.publish(mapped);
        }
      }
      // 事件流保证以 end 收尾；未见 end 视作崩溃兜底
      await finalize(turnId, turn, {
        reason: "crashed",
        message: "事件流未以 end 收尾",
        report: turn.answerText,
      });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      await finalize(turnId, turn, {
        reason: "crashed",
        message,
        report: turn.answerText,
      });
    }
  }

  /**
   * 落一份计划草案（T4.6）：无活跃计划 → 创世 v1；有活跃计划（draft/approved）→ 续版 draft
   * 并把旧版转 superseded（§6.1 只增不改）。返回新草案版本号。
   * createNextDraft 对终态/superseded 底稿抛错，由调用方 catch 转为面向用户的失败原因。
   */
  async function persistPlanDraft(
    layout: ProjectLayout,
    changes: Parameters<typeof createInitialDraft>[0],
  ): Promise<PlanVersion> {
    const latest = await deps.loadLatestPlan(layout);
    let draft: Plan;
    if (latest === undefined) {
      draft = createInitialDraft(changes);
    } else {
      draft = createNextDraft(latest, changes);
      await deps.savePlan(layout, supersedePlan(latest));
    }
    await deps.savePlan(layout, draft);
    return draft.version;
  }

  /**
   * 审查轮收尾（T7.2）：解析结论 → 写回被审的那条 Run。
   *
   * **只有轮次自身跑完（completed）才写结论**：取消 / 崩溃 / 失败不是"一次得不出结论的
   * 审查"，而是一次没发生的审查，把它写成 inconclusive 会覆盖掉此前那次真审查的结论。
   * 返回写回的结论（供 end 事件带出）；未写回返回 undefined。
   *
   * 写回失败不抛：整轮已经跑完，把用户已经付出的那次审查连同一个 end 事件一起吞掉，
   * 比丢一条结论更坏。失败记日志，end 事件照推。
   */
  async function persistReview(
    ctx: ReviewTurnContext,
    guarded: GuardedTurn,
    outcome: { readonly reason: Run["endReason"] & string; readonly report: string },
  ): Promise<ReviewRecord | undefined> {
    if (outcome.reason !== "completed") {
      return undefined;
    }
    const conclusion = parseReviewConclusion(outcome.report);
    const evidence = toStoredRunEvidence(guarded.evidence());
    const review: ReviewRecord = {
      reviewedAt: deps.now(),
      profileId: ctx.profileId,
      verdict: conclusion.verdict,
      summary: conclusion.summary,
      findings: conclusion.findings,
      commands: evidence.commands as readonly CommandRecord[],
    };
    try {
      // 从磁盘重读而非改 ctx.reviewedRun：审查期间该 Run 可能已被别处写过
      // （另一次审查、将来的补充字段）。读回来再改一个字段，不把过期的整条覆盖上去。
      const current = (await deps.loadRun(ctx.layout, ctx.reviewedRun.id)) ?? ctx.reviewedRun;
      await deps.updateRun(ctx.layout, { ...current, review });
    } catch (thrown) {
      console.warn(`[session] failed to persist review conclusion: ${String(thrown)}`);
      return undefined;
    }
    return review;
  }

  /**
   * 回放本收尾（T8.2b）：追加 `assistant_message`（有文本才追加；`partial` 只在被中断时标）
   * + `turn_end`，等 partial 写链结算后删标记与 partial。三步各自容错，任一步失败不影响其余。
   */
  async function recordTurnEnd(
    turnId: string,
    turn: ActiveTurn,
    summary: TurnEndSummary,
    options: { readonly partial: boolean },
  ): Promise<void> {
    const { layout, sessionId, role, profileId, resumeKind } = turn.ctx.sessionCtx;
    const text = turn.answerText;
    const at = deps.now();
    if (text.trim().length > 0) {
      await recordSafely("transcript assistant_message append", () =>
        deps.appendTranscript(layout, sessionId, {
          kind: "assistant_message",
          turnId,
          at,
          text,
          ...(options.partial ? { partial: true } : {}),
        }),
      );
    }
    await recordSafely("transcript turn_end append", () =>
      deps.appendTranscript(layout, sessionId, {
        kind: "turn_end",
        turnId,
        at,
        role,
        profileId,
        ...(resumeKind !== undefined ? { resumeKind } : {}),
        ...(summary.runId !== undefined ? { runId: summary.runId } : {}),
        ...(summary.taskId !== undefined ? { taskId: summary.taskId } : {}),
        endReason: summary.endReason,
      }),
    );
    await turn.partialChain;
    await recordSafely("inflight marker delete", () => deps.deleteInflightMarker(layout, turnId));
  }

  /**
   * 收尾：Worker 轮落 Run + 推进任务；计划生成轮落计划；审查轮把结论写回被审的 Run；
   * 四类都推 end 事件；最后写回放本收尾并删在飞标记。
   * 只有 streaming 阶段的轮会被收尾：退出钩子已接手（phase 非 streaming）则放手，
   * 避免两边各写一条 Run。
   */
  async function finalize(
    turnId: string,
    turn: ActiveTurn,
    outcome: {
      readonly reason: Run["endReason"] & string;
      readonly message?: string;
      readonly report: string;
      readonly verifyResult?: VerifyResult;
    },
  ): Promise<void> {
    if (turn.phase !== "streaming") {
      return;
    }
    turn.phase = "finalizing";
    // 并行事实先于 end 事件释放（releaseParallelFacts 注释）：事件流已收尾，
    // 该轮不再占任何可写范围；drain 的 finally 再删一次是幂等兜底。
    releaseParallelFacts(turnId);
    try {
      const summary = await settleTurn(turnId, turn.guarded, turn.ctx, outcome);
      await recordTurnEnd(turnId, turn, summary, { partial: false });
    } finally {
      turn.phase = "settled";
    }
  }

  /** finalize 的主体：按轮次类别落库并推 end 事件，返回进 turn_end 的摘要。 */
  async function settleTurn(
    turnId: string,
    guarded: GuardedTurn,
    ctx: TurnContexts,
    outcome: {
      readonly reason: Run["endReason"] & string;
      readonly message?: string;
      readonly report: string;
      readonly verifyResult?: VerifyResult;
    },
  ): Promise<TurnEndSummary> {
    const { workerCtx, planCtx, reviewCtx, knowledgeCtx } = ctx;
    // 知识库工具审计（T6.6）：轮末一次性回读 sidecar 写下的调用记录。
    // 未挂工具 = undefined（与"挂了但一次没调用"的空数组是两件事，见 Run.knowledgeQueries）。
    // 读取失败不该拖垮收尾：readKnowledgeAudit 自身已把失败归一为空数组，这里再兜一层。
    let knowledgeQueries: readonly KnowledgeQueryRecord[] | undefined;
    if (knowledgeCtx !== undefined) {
      knowledgeQueries = await knowledgeCtx.readAudit().catch(() => []);
      if (knowledgeQueries.length > 0) {
        // 两个角色都推：Planner 轮没有 Run，这是它唯一的可见途径
        deps.publish({ turnId, kind: "knowledge-query", queries: knowledgeQueries });
      }
    }

    if (workerCtx === undefined) {
      // 审查轮：结论写回被审的那条 Run（不铸新 Run，见 ReviewRecord 注释）。
      if (reviewCtx !== undefined) {
        const review = await persistReview(reviewCtx, guarded, outcome);
        deps.publish({
          turnId,
          kind: "end",
          reason: outcome.reason,
          ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          // runId 带的是**被审查**的那条 Run：渲染层据它跳到执行记录页看完整结论。
          runId: reviewCtx.reviewedRun.id,
          ...(review !== undefined ? { reviewVerdict: review.verdict } : {}),
        });
        return {
          endReason: outcome.reason,
          runId: reviewCtx.reviewedRun.id,
          taskId: reviewCtx.reviewedRun.taskId,
        };
      }
      // 计划生成轮：轮成功则解析答复中的计划块并落盘；失败原因经 end.message 回传（不写盘）
      let planVersion: PlanVersion | undefined;
      let endMessage = outcome.message;
      if (planCtx !== undefined && outcome.reason === "completed") {
        const parsed = parsePlannerPlanDraft(outcome.report);
        if (!parsed.ok) {
          endMessage = `计划生成失败：${parsed.error}`;
        } else {
          try {
            planVersion = await persistPlanDraft(planCtx.layout, parsed.changes);
          } catch (thrown) {
            endMessage = `计划落盘失败：${thrown instanceof Error ? thrown.message : String(thrown)}`;
          }
        }
      }
      deps.publish({
        turnId,
        kind: "end",
        reason: outcome.reason,
        ...(endMessage !== undefined ? { message: endMessage } : {}),
        ...(planVersion !== undefined ? { planVersion } : {}),
      });
      return { endReason: outcome.reason };
    }

    const { layout, runningTask, profileId, startedAt } = workerCtx;
    let runId: RunId | undefined;
    try {
      const evidence = toStoredRunEvidence(guarded.evidence());
      runId = deps.newRunId();
      const existingRuns = await deps.listRuns(layout);
      const started = startRun(runningTask, {
        id: runId,
        profileId,
        startedAt,
        rawLogPath: "raw.log",
        existingRuns,
      });
      const report = outcome.report.trim();
      const ended = endRun(started, {
        endedAt: deps.now(),
        endReason: outcome.reason,
        fileChanges: evidence.fileChanges as readonly FileChange[],
        commands: evidence.commands as readonly CommandRecord[],
        ...(outcome.verifyResult !== undefined ? { verifyResult: outcome.verifyResult } : {}),
        ...(report.length > 0 ? { report } : {}),
        ...(knowledgeQueries !== undefined ? { knowledgeQueries } : {}),
      });
      const changesDiff = evidence.fileChanges
        .map((change) => change.diff)
        .filter((diff) => diff.length > 0)
        .join("\n");
      await deps.persistRun(layout, ended, outcome.report, changesDiff);

      // 推进任务：completed 走 completeTask 证据门槛（不合格则记一次失败）
      let settled: Task;
      try {
        settled = settleTaskAfterRun(runningTask, ended, "fail-task");
      } catch {
        // completeTask 的 done 门槛未过（缺验证结果 / 缺报告）：记为一次失败尝试，可重试
        settled = failTask(runningTask);
      }
      await deps.saveTask(layout, settled);
    } catch (thrown) {
      // 落库/推进失败：尽力把任务记为失败，避免卡在 running
      const settled = failTask(runningTask);
      await deps.saveTask(layout, settled).catch(() => undefined);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      deps.publish({ turnId, kind: "end", reason: "failed", message });
      // Run 没落成，turn_end 不带 runId——回放本不该指向一条不存在的记录
      return { endReason: "failed", taskId: runningTask.id };
    }

    deps.publish({
      turnId,
      kind: "end",
      reason: outcome.reason,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(runId !== undefined ? { runId } : {}),
    });
    return {
      endReason: outcome.reason,
      ...(runId !== undefined ? { runId } : {}),
      taskId: runningTask.id,
    };
  }

  /**
   * 退出钩子接手一个仍在 streaming 的轮（T8.2b）：
   * Worker 轮 → Run(interrupted，report 为部分文本，证据取已累积的）+ 任务 failed；
   * 所有轮 → 回放本 `assistant_message{partial}`（有文本才写）+ `turn_end{interrupted}`，删标记；
   * 推一条 end{interrupted}（窗口多半已关，无害）。任一步失败只记日志，不阻塞退出。
   */
  async function settleInterrupted(turnId: string, turn: ActiveTurn): Promise<void> {
    // 与 finalize 同点释放并行事实：本轮已被退出钩子接手，不再占可写范围
    releaseParallelFacts(turnId);
    const { workerCtx, reviewCtx } = turn.ctx;
    let summary: TurnEndSummary = { endReason: "interrupted" };
    if (reviewCtx !== undefined) {
      summary = {
        endReason: "interrupted",
        runId: reviewCtx.reviewedRun.id,
        taskId: reviewCtx.reviewedRun.taskId,
      };
    }
    if (workerCtx !== undefined) {
      const { layout, runningTask, profileId, startedAt } = workerCtx;
      summary = { endReason: "interrupted", taskId: runningTask.id };
      try {
        const evidence = toStoredRunEvidence(turn.guarded.evidence());
        const runId = deps.newRunId();
        const existingRuns = await deps.listRuns(layout);
        const outcome = buildInterruptedRun({
          task: runningTask,
          runId,
          profileId,
          startedAt,
          endedAt: deps.now(),
          existingRuns,
          partialReport: turn.answerText,
          fileChanges: evidence.fileChanges as readonly FileChange[],
          commands: evidence.commands as readonly CommandRecord[],
        });
        const changesDiff = evidence.fileChanges
          .map((change) => change.diff)
          .filter((diff) => diff.length > 0)
          .join("\n");
        await deps.persistRun(layout, outcome.run, turn.answerText, changesDiff);
        await deps.saveTask(layout, outcome.task);
        summary = { endReason: "interrupted", runId, taskId: runningTask.id };
      } catch (thrown) {
        console.warn(`[session] interrupted run persist failed: ${String(thrown)}`);
        // Run 没落成也要把任务从 running 拉回来，否则重启后它永远"执行中"
        await deps.saveTask(layout, failTask(runningTask)).catch(() => undefined);
      }
    }
    await recordTurnEnd(turnId, turn, summary, { partial: true });
    deps.publish({
      turnId,
      kind: "end",
      reason: "interrupted",
      ...(summary.runId !== undefined ? { runId: summary.runId } : {}),
      message: "工作台退出，本轮被中断",
    });
  }

  async function prepareForQuit(): Promise<PrepareForQuitReport> {
    // 先把阶段全部推到 finalizing，再逐个落盘：这一步是同步的，期间不会有 end 事件插进来
    // 抢走某一轮（正常收尾看到非 streaming 即放手）。
    const claimed: Array<[string, ActiveTurn]> = [];
    const finalizing: ActiveTurn[] = [];
    for (const [turnId, turn] of active) {
      if (turn.phase === "streaming") {
        turn.phase = "finalizing";
        claimed.push([turnId, turn]);
      } else if (turn.phase === "finalizing") {
        finalizing.push(turn);
      }
    }
    for (const [turnId, turn] of claimed) {
      try {
        await settleInterrupted(turnId, turn);
      } finally {
        turn.phase = "settled";
      }
    }
    // 正在正常收尾的轮：给它们把落盘做完的机会（受总时限约束，由 quit.ts 兜底）
    await Promise.all(finalizing.map((turn) => turn.done.catch(() => undefined)));

    // 取消全部子进程，最多等 QUIT_CANCEL_WAIT_MS；等不到就放行（Job Object 会收走它们）
    // 每个 cancel 返回后同样挂僵尸注销兜底：正常退出流程里进程随后消亡、表无消费方，
    // 但单测环境与「退出被用户取消」的 Electron 边角（before-quit 后窗口未关）下，
    // 编排器可能继续存活服务派发，悬挂轮不该留在裁决表里。
    const cancels = [...active.entries()].map(([turnId, turn]) =>
      turn.guarded
        .cancel()
        .catch(() => undefined)
        .then(() => {
          void unregisterAfterCancelGrace(turnId, turn);
        }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelledInTime = await Promise.race([
      Promise.all(cancels).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), QUIT_CANCEL_WAIT_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return { interrupted: claimed.length, cancelledInTime };
  }

  async function respondPermission(request: RespondPermissionRequest): Promise<SessionActionAck> {
    const turn = active.get(request.turnId);
    if (turn === undefined) {
      return { ok: false };
    }
    await turn.guarded.respondPermission(request.requestId, request.decision);
    return { ok: true };
  }

  async function cancel(request: CancelSessionRequest): Promise<SessionActionAck> {
    const turn = active.get(request.turnId);
    if (turn === undefined) {
      return { ok: false };
    }
    await turn.guarded.cancel();
    // 僵尸注销兜底（T8.3b）：cancel 返回即进程已消亡；事件流若悬挂不 end，
    // 宽限期后强制释放并行事实，避免死轮挡后续派发。不 await——回执不该等宽限。
    void unregisterAfterCancelGrace(request.turnId, turn);
    return { ok: true };
  }

  return {
    start,
    respondPermission,
    cancel,
    activeCount: () => active.size,
    hasActiveTurn: (turnId) => active.has(turnId),
    listActiveTurns: (projectRoot) => {
      const rootKey = normalizeProjectRootKey(projectRoot);
      return listActiveTurnRecords(parallelTable).filter(
        (record) => turnProjects.get(record.turnId) === rootKey,
      );
    },
    prepareForQuit,
  };
}
