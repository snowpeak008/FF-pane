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
 * 边界（各归其工单，本编排器不越界）：
 * - Planner 讨论只产出对话，不解析结构化计划（计划生成是后续细化）；
 * - 会话恢复（resume）见 T4.3；记忆候选闭环见 T4.4。
 */

import {
  type AdapterRegistry,
  type AdapterTurnContext,
  type GuardedTurn,
  type GuardTurnContext,
  guardTurn,
  toStoredRunEvidence,
} from "@ff-pane/adapters";
import {
  assemblePrompt,
  assembleRunEnvelope,
  dispatchTask,
  endRun,
  failTask,
  intersectEnvelopes,
  PLANNER_DEFAULT_ENVELOPE,
  settleTaskAfterRun,
  startRun,
  toRunEnvelope,
} from "@ff-pane/core";
import type {
  AgentProfile,
  AiOutputLanguageSettings,
  ApiKeyRef,
  CommandRecord,
  FileChange,
  GlobalConfig,
  MemoryEntry,
  ModelId,
  Provider,
  Role,
  Run,
  RunId,
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
import { resolveRuntimeEnv } from "./env";
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
  /** memory/state.md 快照文本（Planner 注入；缺省 undefined）。 */
  readonly loadStateSnapshot: (layout: ProjectLayout) => Promise<string | undefined>;
  readonly loadGlobalConfig: () => Promise<GlobalConfig>;
  readonly loadTask: (layout: ProjectLayout, id: Task["id"]) => Promise<Task | undefined>;
  readonly saveTask: (layout: ProjectLayout, task: Task) => Promise<void>;
  readonly listRuns: (layout: ProjectLayout) => Promise<readonly Run[]>;
  /** 落库一条已结束 Run（run.json + raw.log + changes.diff）。 */
  readonly persistRun: (
    layout: ProjectLayout,
    run: Run,
    rawLog: string,
    changesDiff: string,
  ) => Promise<void>;
  readonly now: () => number;
  readonly newRunId: () => RunId;
}

/** 在飞轮次的内部状态。 */
interface ActiveTurn {
  readonly guarded: GuardedTurn;
}

/** Worker 轮落库所需的上下文（Planner 轮为 undefined）。 */
interface WorkerContext {
  readonly layout: ProjectLayout;
  readonly runningTask: Task;
  readonly profileId: AgentProfile["id"];
  readonly startedAt: number;
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

      const role: Role = request.input.kind === "planner-message" ? "planner" : "worker";
      const layout = deps.resolveLayout(request.projectRoot);
      const [memory, config] = await Promise.all([
        deps.loadActiveMemory(layout),
        deps.loadGlobalConfig(),
      ]);
      const outputLanguage = outputLanguageSettings(config, profile);

      // 密钥解密 → Run 级注入环境变量（唯一密钥通道，§4.3）
      const apiKeyPlaintext =
        provider.apiKeyRef !== undefined ? await deps.revealSecret(provider.apiKeyRef) : undefined;
      const env = resolveRuntimeEnv({
        runtime: profile.runtime,
        provider,
        ...(apiKeyPlaintext !== undefined ? { apiKeyPlaintext } : {}),
      });
      const model: ModelId | undefined = profile.model ?? provider.defaultModel;

      // 组装 Prompt + 权限信封（Worker 从任务合同派生，Planner 用只读角色默认）
      let prompt: string;
      let guardCtx: GuardTurnContext;
      let workerCtx: WorkerContext | undefined;

      if (request.input.kind === "worker-task") {
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
        prompt = assemblePrompt({
          role: "planner",
          input: { kind: "message", text: request.input.text },
          projectMemory: memory,
          outputLanguage,
          ...(stateSnapshot !== undefined ? { stateSnapshot } : {}),
        });
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

      const turnCtx: AdapterTurnContext = {
        cwd: request.projectRoot,
        prompt,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(model !== undefined ? { model } : {}),
      };

      const guarded = guardTurn(adapter.startTurn(turnCtx), guardCtx);
      active.set(request.turnId, { guarded });
      deps.publish({
        turnId: request.turnId,
        kind: "started",
        role,
        ...(model !== undefined ? { model } : {}),
      });

      // 事件流消费独立于受理应答（fire-and-forget，结束时清理登记）
      void drain(request.turnId, guarded, workerCtx).finally(() => {
        active.delete(request.turnId);
      });

      return { accepted: true, turnId: request.turnId };
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return { accepted: false, reason: message };
    }
  }

  /** 消费一轮的事件流，推增量、收尾落库。 */
  async function drain(
    turnId: string,
    guarded: GuardedTurn,
    workerCtx: WorkerContext | undefined,
  ): Promise<void> {
    let answerText = "";
    let verifyResult: VerifyResult | undefined;
    const verifyCmd = workerCtx?.runningTask.verifyCmd;

    try {
      for await (const event of guarded.events) {
        if (event.kind === "end") {
          await finalize(turnId, guarded, workerCtx, {
            reason: event.reason,
            ...(event.message !== undefined ? { message: event.message } : {}),
            report: answerText,
            ...(verifyResult !== undefined ? { verifyResult } : {}),
          });
          return;
        }
        if (event.kind === "session_start") {
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
      await finalize(turnId, guarded, workerCtx, {
        reason: "crashed",
        message: "事件流未以 end 收尾",
        report: answerText,
      });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      await finalize(turnId, guarded, workerCtx, {
        reason: "crashed",
        message,
        report: answerText,
      });
    }
  }

  /** 收尾：Worker 轮落 Run + 推进任务；两类轮次都推 end 事件。 */
  async function finalize(
    turnId: string,
    guarded: GuardedTurn,
    workerCtx: WorkerContext | undefined,
    outcome: {
      readonly reason: Run["endReason"] & string;
      readonly message?: string;
      readonly report: string;
      readonly verifyResult?: VerifyResult;
    },
  ): Promise<void> {
    if (workerCtx === undefined) {
      deps.publish({
        turnId,
        kind: "end",
        reason: outcome.reason,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
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
