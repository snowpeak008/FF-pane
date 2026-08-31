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
 * 审查轮（T7.2，§3.1）：Reviewer 角色的一轮，第 4 层是「任务合同的验收标准 + 被审 Run 的
 * 证据」，权限为角色默认的只读 + verify_only；结论解析后写回**被审的那条 Run**，不铸新
 * Run、不改任务状态（done ≠ accepted 由 acceptTask 在状态机层锁死，§6.3）。
 *
 * 边界（各归其工单，本编排器不越界）：
 * - Planner 讨论只产出对话，不解析结构化计划（计划生成是后续细化）；
 * - 记忆候选闭环见 T4.4。
 */

import {
  type AdapterRegistry,
  type AdapterTurnContext,
  type GuardedTurn,
  type GuardTurnContext,
  guardTurn,
  type McpStdioServerSpec,
  toStoredRunEvidence,
} from "@ff-pane/adapters";
import {
  assemblePrompt,
  assembleRebuildContext,
  assembleReviewMaterial,
  assembleRunEnvelope,
  compileHabitProfile,
  createInitialDraft,
  createNextDraft,
  decideResumeKind,
  dispatchTask,
  endRun,
  failTask,
  HABIT_FIRST_INSTRUCTION,
  hasActiveWorkflowHabit,
  intersectEnvelopes,
  isDirectExecuteRequest,
  PLAN_OUTPUT_CONTRACT,
  PLANNER_DEFAULT_ENVELOPE,
  parsePlannerPlanDraft,
  parseReviewConclusion,
  REVIEW_OUTPUT_CONTRACT,
  REVIEWER_DEFAULT_ENVELOPE,
  settleTaskAfterRun,
  startRun,
  supersedePlan,
  toRunEnvelope,
} from "@ff-pane/core";
import type {
  AgentProfile,
  AiOutputLanguageSettings,
  ApiKeyRef,
  CommandRecord,
  FileChange,
  GlobalConfig,
  HabitEntry,
  KnowledgeQueryRecord,
  LocalSessionId,
  MemoryEntry,
  ModelId,
  NativeSessionBinding,
  Plan,
  PlanVersion,
  Provider,
  ReviewRecord,
  Role,
  Run,
  RunId,
  SessionRecord,
  SessionResumeKind,
  Task,
  VerifyResult,
} from "@ff-pane/shared";
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
}

/** 编排器依赖（全部注入，便于测试替身）。 */
export interface SessionOrchestratorDeps {
  readonly registry: AdapterRegistry;
  /** 推送一条会话事件到渲染层（窗口不存在时静默丢弃）。 */
  readonly publish: (event: SessionStreamEvent) => void;
  readonly loadProfile: (id: AgentProfile["id"]) => Promise<AgentProfile | undefined>;
  readonly loadProvider: (id: Provider["id"]) => Promise<Provider | undefined>;
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

/** 在飞轮次的内部状态。 */
interface ActiveTurn {
  readonly guarded: GuardedTurn;
}

/** 会话登记上下文（每轮都有；session_start 报出原生 ID 时据此回写登记）。 */
interface SessionContext {
  readonly layout: ProjectLayout;
  readonly sessionId: LocalSessionId;
  readonly role: Role;
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

export function createSessionOrchestrator(deps: SessionOrchestratorDeps): SessionOrchestrator {
  const active = new Map<string, ActiveTurn>();

  function outputLanguageSettings(
    config: GlobalConfig,
    profile: AgentProfile,
  ): AiOutputLanguageSettings {
    return {
      global: config.aiOutputLanguage,
      ...(profile.outputLanguage !== undefined ? { profile: profile.outputLanguage } : {}),
    };
  }

  /** 从登记事实（计划/任务/state/最近 Run）重建上下文文本（context_rebuild 用）。 */
  async function buildRebuildContext(layout: ProjectLayout): Promise<string> {
    const [plan, tasks, stateSnapshot, runs] = await Promise.all([
      deps.loadLatestPlan(layout),
      deps.listTasks(layout),
      deps.loadStateSnapshot(layout),
      deps.listRuns(layout),
    ]);
    return assembleRebuildContext({
      ...(plan !== undefined ? { plan } : {}),
      tasks,
      ...(stateSnapshot !== undefined ? { stateSnapshot } : {}),
      recentRuns: runs,
    });
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
    if (active.has(request.turnId)) {
      return { accepted: false, reason: "该轮次已在执行中" };
    }
    try {
      const profile = await deps.loadProfile(request.profileId);
      if (profile === undefined) {
        return { accepted: false, reason: "Profile 不存在" };
      }
      const adapter = deps.registry.get(profile.runtime);
      if (adapter === undefined) {
        return { accepted: false, reason: `Runtime 未注册：${profile.runtime}` };
      }
      const provider = await deps.loadProvider(profile.providerId);
      if (provider === undefined) {
        return { accepted: false, reason: "Provider 不存在" };
      }

      const role: Role =
        request.input.kind === "worker-task"
          ? "worker"
          : request.input.kind === "reviewer-review"
            ? "reviewer"
            : "planner";
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
          resumeContext = await buildRebuildContext(layout);
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
        // 派发：pending|failed → running（非法态由状态机抛错，落入下方 catch）
        const runningTask = dispatchTask(task);
        await deps.saveTask(layout, runningTask);
        workerCtx = {
          layout,
          runningTask,
          profileId: profile.id,
          startedAt: deps.now(),
        };
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
        prompt = assemblePrompt({
          role: "planner",
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
        // Planner 只读：角色默认 ∩ Profile 预设
        const plannerEnvelope = toRunEnvelope(
          intersectEnvelopes(PLANNER_DEFAULT_ENVELOPE, profile.permissionPreset),
        );
        guardCtx = {
          cwd: request.projectRoot,
          envelope: plannerEnvelope,
          ...(Object.keys(env).length > 0 ? { secrets: env } : {}),
        };
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

      const guarded = guardTurn(adapter.startTurn(turnCtx), guardCtx);
      active.set(request.turnId, { guarded });
      deps.publish({
        turnId: request.turnId,
        kind: "started",
        role,
        sessionId,
        ...(model !== undefined ? { model } : {}),
        ...(resumeKind !== undefined ? { resumeKind } : {}),
      });

      // 事件流消费独立于受理应答（fire-and-forget，结束时清理登记）
      void drain(request.turnId, guarded, {
        ...(workerCtx !== undefined ? { workerCtx } : {}),
        ...(planCtx !== undefined ? { planCtx } : {}),
        ...(reviewCtx !== undefined ? { reviewCtx } : {}),
        sessionCtx,
        ...(knowledgeCtx !== undefined ? { knowledgeCtx } : {}),
      }).finally(() => {
        active.delete(request.turnId);
      });

      return { accepted: true, turnId: request.turnId, sessionId };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return { accepted: false, reason: message };
    }
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

  /** 消费一轮的事件流，推增量、收尾落库。 */
  async function drain(turnId: string, guarded: GuardedTurn, ctx: TurnContexts): Promise<void> {
    const { workerCtx, sessionCtx } = ctx;
    let answerText = "";
    let verifyResult: VerifyResult | undefined;
    const verifyCmd = workerCtx?.runningTask.verifyCmd;

    try {
      for await (const event of guarded.events) {
        if (event.kind === "end") {
          await finalize(turnId, guarded, ctx, {
            reason: event.reason,
            ...(event.message !== undefined ? { message: event.message } : {}),
            report: answerText,
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
          answerText += event.content;
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
      await finalize(turnId, guarded, ctx, {
        reason: "crashed",
        message: "事件流未以 end 收尾",
        report: answerText,
      });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      await finalize(turnId, guarded, ctx, {
        reason: "crashed",
        message,
        report: answerText,
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
   * 收尾：Worker 轮落 Run + 推进任务；计划生成轮落计划；审查轮把结论写回被审的 Run；
   * 四类都推 end 事件。
   */
  async function finalize(
    turnId: string,
    guarded: GuardedTurn,
    ctx: TurnContexts,
    outcome: {
      readonly reason: Run["endReason"] & string;
      readonly message?: string;
      readonly report: string;
      readonly verifyResult?: VerifyResult;
    },
  ): Promise<void> {
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
        return;
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
      return;
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
      return;
    }

    deps.publish({
      turnId,
      kind: "end",
      reason: outcome.reason,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(runId !== undefined ? { runId } : {}),
    });
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
    return { ok: true };
  }

  return {
    start,
    respondPermission,
    cancel,
    activeCount: () => active.size,
  };
}
