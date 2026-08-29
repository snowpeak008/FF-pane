/**
 * guardTurn —— 把 W2.7a 的裁决接到真实事件流上（W2.7b 主体）。
 *
 * 包装任意 `AdapterTurn`，对外仍是一个 `AdapterTurn`（事件流恰好一条 end 收尾），
 * 额外承担四件事：事前拦截、审批中转、证据收集、收尾审计加注。
 *
 * ## 通道判定
 * 是否有原生转发通道，只看内层 turn 有没有 `respondPermission`
 *（claude / opencode 有，codex / gemini / generic-exec 没有）。它决定两件事：
 * - 原生 `permission_request` 的自动应答能否真的回执给 Runtime；
 * - 动作级 needs_approval 是否上浮：有原生通道时审批由 Runtime 的请求驱动，
 *   动作级不再重复送审（否则同一次操作会被两条路径各问一遍，违背 §7 的"逐次确认"）。
 *
 * ## 事件处理表
 * | 入口 | 裁决 | guard 行为 |
 * |---|---|---|
 * | `permission_request` | allowed | 回执 allow + `guard.request_auto_allowed` 留档，请求本身不上浮（已应答的请求再上浮只会让用户批准一件已批准的事） |
 * | `permission_request` | violation | 回执 deny + `guard.request_auto_denied` 留档，请求本身不上浮（恒拒不该挂成待批） |
 * | `permission_request` | needs_approval | **原样上浮**，登记待批，等编排层回执 |
 * | `file_change`/`command` `started` | allowed | 无动作（不产生噪声事件） |
 * | 同上 | violation | `guard.action_violation` 留档 + 按 `cancelOnViolation` 取消整轮 |
 * | 同上 | needs_approval | 无原生通道 → 合成 `permission_request` 上浮；有原生通道 → 只留档不重复送审 |
 * | 同上 `completed`/`failed` | —— | 入证据 |
 * | 同上 `denied` | —— | 不入证据；未裁决过则独立裁决一次（提醒 ⑥：Runtime 的 denied 不是放行依据） |
 * | `end` | —— | 跑 `auditRunEvidence`，按结论加注 end（原 end 一并留档） |
 * | 其余 | —— | 原样透传 |
 *
 * ## 顺序与可辨识性
 * 原生事件相对顺序完全不变，且恒排在 guard 对其反应之前（日志读起来就是
 * "动作 → 权限层如何处置"）。guard 自产事件一律是 `raw`（`runtime` 为
 * {@link GUARD_RUNTIME_ID}、`nativeType` 为 `guard.*`）或带
 * {@link SELF_PRODUCED_REQUEST_PREFIX} 前缀的 `permission_request`，用
 * `isGuardProducedEvent` 可判。外部回执（`respondPermission`）产生的留档事件不能
 * 凭空插进流里，故排在"下一条原生事件之前"，并在 end 之前必定全部落地。
 *
 * ## 密钥遮蔽
 * 每条入流事件在进入裁决之前先过 `maskGuardEvent`：这样透传文本、证据、guard 自产
 * 事件的说明文字全都由已遮蔽的文本派生，不存在"漏一条路径"的可能。
 */

import type {
  RunDangerousApproval,
  RunEvidenceAuditResult,
  RunGuardViolation,
} from "@ff-pane/core";
import { applyRunGrant, normalizeCommandKey } from "@ff-pane/core";
import type {
  DangerousOperation,
  PermissionEnvelope,
  PermissionRequestPayload,
} from "@ff-pane/shared";
import type { AdapterTurn, PermissionDecision } from "../adapter.js";
import type {
  AgentEvent,
  CommandEvent,
  EndEvent,
  FileChangeEvent,
  PermissionRequestEvent,
  RawEvent,
} from "../events/index.js";
import { toRawEvent } from "../events/index.js";
import type { GuardEndFacts } from "./evidence.js";
import {
  annotateGuardEnd,
  auditGuardEvidence,
  commandEvidenceOf,
  fileChangeEvidenceOf,
  runtimeBlockageOf,
} from "./evidence.js";
import {
  judgeGuardCommand,
  judgeGuardFileChange,
  judgeGuardPayload,
  toGuardJudgeContext,
} from "./judge.js";
import { maskGuardEvent } from "./secrets.js";
import type {
  GuardEventType,
  GuardEvidenceCommand,
  GuardEvidenceFileChange,
  GuardedTurn,
  GuardInterception,
  GuardInterceptionLevel,
  GuardInterceptionOutcome,
  GuardJudgement,
  GuardRequestOrigin,
  GuardRunEvidence,
  GuardTurnContext,
} from "./types.js";
import { GUARD_RUNTIME_ID, GuardError, SELF_PRODUCED_REQUEST_PREFIX } from "./types.js";

/** 可变的拦截记录（`outcome` 随用户回执演进；对外只给冻结快照）。 */
interface MutableInterception {
  readonly origin: GuardRequestOrigin;
  readonly level: GuardInterceptionLevel;
  readonly decision: "violation" | "needs_approval";
  readonly reason: string;
  readonly nativeRequestId?: string;
  readonly violation?: RunGuardViolation;
  readonly request?: PermissionRequestPayload;
  outcome: GuardInterceptionOutcome;
}

/** 一条已上浮、等待回执的请求。 */
interface PendingRequest {
  readonly origin: GuardRequestOrigin;
  readonly request: PermissionRequestPayload;
  readonly dangerousOperations: readonly DangerousOperation[];
  /** 交给 `auditRunEvidence` 的审批明细（路径用比较键、命令用原文）。 */
  readonly approvalDetail?: string;
  readonly interception: MutableInterception;
}

/** 动作级裁决的两个时机（决定是否还有补救手段）。 */
type ActionStage = "pre_flight" | "runtime_denied";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 动作去重键：优先用原生动作 ID，缺席时退回"类型 + 目标"。 */
function actionKeyOf(event: FileChangeEvent | CommandEvent): string {
  if (event.actionId !== undefined) {
    return `${event.kind}:id:${event.actionId}`;
  }
  return event.kind === "file_change"
    ? `file_change:path:${event.changeKind}:${event.path}`
    : `command:text:${normalizeCommandKey(event.command)}`;
}

/** 动作的展示标识（进 guard 留档事件）。 */
function actionTargetOf(event: FileChangeEvent | CommandEvent): string {
  return event.kind === "file_change" ? `${event.changeKind} ${event.path}` : event.command;
}

/** 包装一轮，接上运行时权限拦截。行为细节见文件头表格与 `types.ts` 的取消语义表。 */
export function guardTurn(turn: AdapterTurn, context: GuardTurnContext): GuardedTurn {
  const cancelOnViolation = context.options?.cancelOnViolation ?? true;
  const cancelOnDeny = context.options?.cancelOnDeny ?? true;
  const hasNativeChannel = typeof turn.respondPermission === "function";

  /** 本轮信封：用户批准的读/写/命令/网络扩展经 applyRunGrant 就地放宽（仅本轮有效）。 */
  let envelope: PermissionEnvelope = context.envelope;
  const approvals: RunDangerousApproval[] = [];
  const interceptions: MutableInterception[] = [];
  const fileChanges: GuardEvidenceFileChange[] = [];
  const commands: GuardEvidenceCommand[] = [];
  const runtimeBlockages: string[] = [];
  const pendingRequests = new Map<string, PendingRequest>();
  const judgedActions = new Set<string>();
  /** 外部回执产生的留档事件（插入到下一条原生事件之前）。 */
  const outbox: AgentEvent[] = [];
  let selfRequestSeq = 0;
  let guardCancelReason: string | undefined;
  let auditResult: RunEvidenceAuditResult | undefined;

  function guardRaw(
    type: GuardEventType,
    native: Readonly<Record<string, unknown>>,
    note: string,
  ): RawEvent {
    return toRawEvent(GUARD_RUNTIME_ID, { type, ...native }, note);
  }

  function snapshot(entry: MutableInterception): GuardInterception {
    return Object.freeze({
      origin: entry.origin,
      level: entry.level,
      decision: entry.decision,
      outcome: entry.outcome,
      reason: entry.reason,
      ...(entry.nativeRequestId === undefined ? {} : { nativeRequestId: entry.nativeRequestId }),
      ...(entry.violation === undefined ? {} : { violation: entry.violation }),
      ...(entry.request === undefined ? {} : { request: entry.request }),
    });
  }

  function record(entry: MutableInterception): MutableInterception {
    interceptions.push(entry);
    return entry;
  }

  async function respondNative(
    nativeRequestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    await turn.respondPermission?.(nativeRequestId, decision);
  }

  /** 取消整轮（幂等）。取消失败不打断事件流，只留档。 */
  async function cancelForGuard(reason: string): Promise<void> {
    if (guardCancelReason !== undefined) {
      return;
    }
    guardCancelReason = reason;
    outbox.push(guardRaw("guard.cancelled", { reason }, `FF-pane 权限层取消本轮：${reason}`));
    try {
      await turn.cancel();
    } catch (error) {
      outbox.push(
        guardRaw(
          "guard.notice",
          { reason, error: errorMessage(error) },
          `取消本轮失败（进程可能已消亡）：${errorMessage(error)}`,
        ),
      );
    }
  }

  /** 本轮是否已确认过同一危险操作 + 同一目标（避免同一次操作被问第二遍）。 */
  function alreadyApproved(operation: DangerousOperation, detail: string | undefined): boolean {
    return approvals.some((approval) => {
      if (approval.operation !== operation) {
        return false;
      }
      if (approval.detail === undefined || detail === undefined) {
        return true;
      }
      return (
        approval.detail === detail ||
        normalizeCommandKey(approval.detail) === normalizeCommandKey(detail)
      );
    });
  }

  /** 登记一条待批请求（原生请求与自产请求共用）。 */
  function registerPending(
    judgement: Extract<GuardJudgement, { decision: "needs_approval" }>,
    origin: GuardRequestOrigin,
    level: GuardInterceptionLevel,
    nativeRequestId: string,
  ): void {
    const entry = record({
      origin,
      level,
      decision: "needs_approval",
      reason: judgement.reason,
      nativeRequestId,
      request: judgement.request,
      outcome: "pending",
    });
    pendingRequests.set(nativeRequestId, {
      origin,
      request: judgement.request,
      dangerousOperations: judgement.dangerousOperations,
      ...(judgement.approvalDetail === undefined
        ? {}
        : { approvalDetail: judgement.approvalDetail }),
      interception: entry,
    });
  }

  /** 处理一条原生权限请求事件（claude / opencode 路径）。 */
  async function handleNativeRequest(
    event: PermissionRequestEvent,
  ): Promise<readonly AgentEvent[]> {
    const judgement = judgeGuardPayload(event.payload, toGuardJudgeContext(context, envelope), {
      ...(event.diff === undefined ? {} : { diff: event.diff }),
    });
    const native = {
      nativeRequestId: event.nativeRequestId,
      payload: event.payload,
      judgement: judgement.reason,
    };

    if (judgement.decision === "allowed") {
      if (!hasNativeChannel) {
        return [
          event,
          guardRaw(
            "guard.notice",
            native,
            `裁决可放行，但本适配器没有回执通道，请求原样上浮：${judgement.reason}`,
          ),
        ];
      }
      await respondNative(event.nativeRequestId, "allow");
      return [
        guardRaw(
          "guard.request_auto_allowed",
          native,
          `信封放行，已自动回执 allow：${judgement.reason}`,
        ),
      ];
    }

    if (judgement.decision === "violation") {
      record({
        origin: "native",
        level: "request",
        decision: "violation",
        reason: judgement.reason,
        nativeRequestId: event.nativeRequestId,
        ...(judgement.violation === undefined ? {} : { violation: judgement.violation }),
        ...(judgement.request === undefined ? {} : { request: judgement.request }),
        outcome: hasNativeChannel ? "auto_denied" : "recorded",
      });
      if (!hasNativeChannel) {
        return [
          guardRaw(
            "guard.request_auto_denied",
            native,
            `裁决为恒拒，但本适配器没有回执通道，无法回执 deny（仅留档）：${judgement.reason}`,
          ),
        ];
      }
      await respondNative(event.nativeRequestId, "deny");
      return [
        guardRaw(
          "guard.request_auto_denied",
          native,
          `裁决为恒拒，已自动回执 deny：${judgement.reason}`,
        ),
      ];
    }

    // needs_approval：不自动应答，原样上浮交用户决定。
    registerPending(judgement, "native", "request", event.nativeRequestId);
    return [event];
  }

  /** 动作级裁决（started 的事前拦截 / denied 的独立复核）。 */
  async function judgeAction(
    event: FileChangeEvent | CommandEvent,
    stage: ActionStage,
  ): Promise<readonly AgentEvent[]> {
    const judgeContext = toGuardJudgeContext(context, envelope);
    const judgement =
      event.kind === "file_change"
        ? judgeGuardFileChange(
            {
              path: event.path,
              changeKind: event.changeKind,
              ...(event.diff === undefined ? {} : { diff: event.diff }),
            },
            judgeContext,
          )
        : judgeGuardCommand(event.command, judgeContext);
    const target = actionTargetOf(event);

    if (judgement.decision === "allowed") {
      if (stage === "pre_flight") {
        return [];
      }
      // Runtime 自称拒绝了一件本层允许的事：这是 Runtime 侧的环境阻断（沙箱 / 自带
      // 策略），不是权限违规，故只留档说明，不进拦截清单。
      return [
        guardRaw(
          "guard.runtime_denied",
          { target },
          `Runtime 自称已拒绝该动作，但本层裁决为放行 → 属 Runtime 侧环境阻断，不计权限违规：${judgement.reason}`,
        ),
      ];
    }

    if (judgement.decision === "violation") {
      record({
        origin: "self_produced",
        level: "action",
        decision: "violation",
        reason: judgement.reason,
        ...(judgement.violation === undefined ? {} : { violation: judgement.violation }),
        ...(judgement.request === undefined ? {} : { request: judgement.request }),
        outcome: "recorded",
      });
      const produced: AgentEvent[] = [
        guardRaw(
          "guard.action_violation",
          { target, stage, appeal: judgement.request },
          stage === "pre_flight"
            ? `动作级事前拦截判为恒拒：${judgement.reason}`
            : `Runtime 自称已拒绝该动作，本层裁决同样判其恒拒（Runtime 回执不是放行依据）：${judgement.reason}`,
        ),
      ];
      // 只有事前拦截才取消：runtime_denied 阶段动作已成定局，取消没有补救意义。
      if (stage === "pre_flight" && cancelOnViolation) {
        await cancelForGuard(`动作越界且无回执通道可拒绝：${judgement.reason}`);
      }
      return produced;
    }

    const operation =
      judgement.request.kind === "dangerous_operation" ? judgement.request.operation : undefined;
    if (operation !== undefined && alreadyApproved(operation, judgement.approvalDetail)) {
      record({
        origin: "self_produced",
        level: "action",
        decision: "needs_approval",
        reason: judgement.reason,
        request: judgement.request,
        outcome: "reapproved",
      });
      return [
        guardRaw(
          "guard.request_approved",
          { target, payload: judgement.request },
          `本轮已获用户确认过同一危险操作，直接放行不再打扰：${judgement.reason}`,
        ),
      ];
    }
    if (hasNativeChannel) {
      // 原生通道的审批由 Runtime 的请求驱动；此处再送审会让同一次操作被问两遍。
      // Runtime 若压根没问就动手（bypass 模式），收尾审计必然报违规，兜得住。
      return [
        guardRaw(
          "guard.notice",
          { target, stage, payload: judgement.request },
          `动作需审批，但本适配器有原生审批通道，不重复送审（交由收尾审计复核）：${judgement.reason}`,
        ),
      ];
    }
    if (stage === "runtime_denied") {
      // 没必要为一个"Runtime 自称没发生"的操作去打扰用户，但这次未获批准的尝试必须
      // 留在拦截清单里——Runtime 的 denied 不是"此事没发生"的证明（提醒 ⑥）。
      record({
        origin: "self_produced",
        level: "action",
        decision: "needs_approval",
        reason: judgement.reason,
        request: judgement.request,
        outcome: "recorded",
      });
      return [
        guardRaw(
          "guard.runtime_denied",
          { target, payload: judgement.request },
          `Runtime 自称已拒绝该动作，本层裁决为需审批，仅留档不送审：${judgement.reason}`,
        ),
      ];
    }
    selfRequestSeq += 1;
    const nativeRequestId = `${SELF_PRODUCED_REQUEST_PREFIX}${selfRequestSeq}`;
    registerPending(judgement, "self_produced", "action", nativeRequestId);
    const request: PermissionRequestEvent = {
      kind: "permission_request",
      nativeRequestId,
      payload: judgement.request,
      reason: judgement.reason,
      ...(event.kind === "file_change" && event.diff !== undefined ? { diff: event.diff } : {}),
    };
    return [request];
  }

  async function handleAction(
    event: FileChangeEvent | CommandEvent,
  ): Promise<readonly AgentEvent[]> {
    const key = actionKeyOf(event);

    if (event.status === "started") {
      judgedActions.add(key);
      return [event, ...(await judgeAction(event, "pre_flight"))];
    }

    const blockage = runtimeBlockageOf(event);
    if (blockage !== undefined) {
      runtimeBlockages.push(blockage);
    }

    if (event.status === "denied") {
      // 提醒 ⑥：Runtime 说"我拒绝了"既不是权限事实，也不是放行依据。该动作不入证据
      //（Runtime 自称未执行），故此处补一次独立裁决，越界照记。
      if (judgedActions.has(key)) {
        return [
          event,
          guardRaw(
            "guard.runtime_denied",
            { target: actionTargetOf(event) },
            "Runtime 自称已拒绝该动作（本层已在 started 阶段裁决过，不重复裁决）",
          ),
        ];
      }
      judgedActions.add(key);
      return [event, ...(await judgeAction(event, "runtime_denied"))];
    }

    if (event.kind === "file_change") {
      const entry = fileChangeEvidenceOf(event);
      if (entry !== undefined) {
        fileChanges.push(entry);
      }
    } else {
      const entry = commandEvidenceOf(event);
      if (entry !== undefined) {
        commands.push(entry);
      }
    }
    return [event];
  }

  function evidenceSnapshot(): GuardRunEvidence {
    return Object.freeze({
      fileChanges: Object.freeze([...fileChanges]),
      commands: Object.freeze([...commands]),
      runtimeBlockages: Object.freeze([...runtimeBlockages]),
    });
  }

  /** end 收尾：跑事后审计 → 留档 → 按结论加注 end。 */
  function finalize(end: EndEvent): readonly AgentEvent[] {
    const evidence = evidenceSnapshot();
    const audit = auditGuardEvidence(envelope, evidence, context, approvals);
    auditResult = audit;
    const facts: GuardEndFacts = {
      audit,
      // 只有"没能当场拒掉"的恒拒条目才参与降级：请求级 violation 已经以 deny 回执
      // 精确阻断，那是权限系统正常工作，不是本轮的失败。
      violationInterceptions: interceptions
        .filter((entry) => entry.decision === "violation" && entry.outcome !== "auto_denied")
        .map(snapshot),
      runtimeBlockages: evidence.runtimeBlockages,
      ...(guardCancelReason === undefined ? {} : { guardCancelReason }),
    };
    const annotation = annotateGuardEnd(end, facts);
    const produced: AgentEvent[] = [
      guardRaw(
        "guard.audit_result",
        {
          ok: audit.ok,
          checkedFileChanges: audit.checkedFileChanges,
          checkedCommands: audit.checkedCommands,
          violations: audit.violations,
          waived: audit.waived,
          runtimeBlockages: evidence.runtimeBlockages,
          pendingRequests: [...pendingRequests.keys()],
        },
        `收尾审计：检查 ${audit.checkedFileChanges} 项文件修改、${audit.checkedCommands} 条命令，` +
          `未批违规 ${audit.violations.length} 项、豁免 ${audit.waived.length} 项` +
          (pendingRequests.size === 0 ? "" : `，仍有 ${pendingRequests.size} 条待批请求未回执`),
      ),
    ];
    if (annotation.rewritten) {
      produced.push(
        guardRaw(
          "guard.end_rewritten",
          { original: end, reason: annotation.end.reason },
          `end 按审计结论改写：reason ${end.reason} → ${annotation.end.reason}（原文已留档）`,
        ),
      );
    }
    produced.push(annotation.end);
    return produced;
  }

  async function processEvent(event: AgentEvent): Promise<readonly AgentEvent[]> {
    switch (event.kind) {
      case "permission_request":
        return await handleNativeRequest(event);
      case "file_change":
      case "command":
        return await handleAction(event);
      default:
        return [event];
    }
  }

  function drainOutbox(): readonly AgentEvent[] {
    return outbox.splice(0, outbox.length);
  }

  async function* generate(): AsyncGenerator<AgentEvent> {
    for await (const incoming of turn.events) {
      const event = maskGuardEvent(incoming, context.secrets);
      yield* drainOutbox();
      if (event.kind === "end") {
        yield* finalize(event);
        return;
      }
      yield* await processEvent(event);
      yield* drainOutbox();
    }
    // 内层流无 end 违反 AdapterTurn 约定，但下游只认"恰好一条 end"，故兜底合成。
    yield* drainOutbox();
    yield* finalize({
      kind: "end",
      reason: guardCancelReason === undefined ? "crashed" : "cancelled",
      message: "内层适配器事件流未以 end 收尾（违反 AdapterTurn 约定），由权限层兜底合成",
    });
  }

  return {
    events: generate(),

    async respondPermission(nativeRequestId: string, decision: PermissionDecision): Promise<void> {
      const pending = pendingRequests.get(nativeRequestId);
      if (pending === undefined) {
        if (!hasNativeChannel) {
          throw new GuardError(
            `未登记的权限请求 ID「${nativeRequestId}」：` +
              "guard 只受理由自己上浮的请求（重复回执，或该请求已被自动应答？）",
          );
        }
        outbox.push(
          guardRaw(
            "guard.notice",
            { nativeRequestId, decision },
            "回执了一条 guard 未登记的请求 ID，已原样转发给适配器（重复回执或旁路上浮？）",
          ),
        );
        await respondNative(nativeRequestId, decision);
        return;
      }
      pendingRequests.delete(nativeRequestId);

      if (decision === "deny") {
        pending.interception.outcome = "denied";
        outbox.push(
          guardRaw(
            "guard.request_denied",
            { nativeRequestId, payload: pending.request, origin: pending.origin },
            `用户拒绝了该请求（${
              pending.origin === "native" ? "已回执给 Runtime" : "自产请求，Runtime 无从知晓"
            }）`,
          ),
        );
        if (pending.origin === "native") {
          await respondNative(nativeRequestId, "deny");
          return;
        }
        if (cancelOnDeny) {
          await cancelForGuard(
            `用户拒绝了一条无原生回执通道的权限请求（${pending.request.kind}），只能取消整轮`,
          );
        }
        return;
      }

      pending.interception.outcome = "approved";
      const notes: string[] = [];
      if (pending.request.kind === "dangerous_operation") {
        // §7：危险操作的逐次确认不产生任何信封层豁免，只能以审批记录交给事后审计，
        // 否则这次合法放行会在收尾时被记成违规（W2.7a 桥接提醒 ⑤）。
        const approval: RunDangerousApproval = {
          operation: pending.request.operation,
          ...(pending.approvalDetail === undefined ? {} : { detail: pending.approvalDetail }),
        };
        approvals.push(approval);
        notes.push(`已记入本轮危险操作逐次确认记录（${approval.operation}）`);
      } else {
        try {
          envelope = applyRunGrant(envelope, pending.request);
          notes.push("已并入本轮信封（仅当前 Run 有效）");
        } catch (error) {
          notes.push(`无法并入信封，仅作单次放行记录：${errorMessage(error)}`);
        }
      }
      outbox.push(
        guardRaw(
          "guard.request_approved",
          { nativeRequestId, payload: pending.request, origin: pending.origin },
          `用户批准了该请求：${notes.join("；")}`,
        ),
      );
      if (pending.origin === "native") {
        await respondNative(nativeRequestId, "allow");
      }
    },

    async cancel(): Promise<void> {
      await turn.cancel();
    },

    envelope(): PermissionEnvelope {
      return envelope;
    },

    interceptions(): readonly GuardInterception[] {
      return Object.freeze(interceptions.map(snapshot));
    },

    approvals(): readonly RunDangerousApproval[] {
      return Object.freeze([...approvals]);
    },

    evidence(): GuardRunEvidence {
      return evidenceSnapshot();
    },

    auditResult(): RunEvidenceAuditResult | undefined {
      return auditResult;
    },
  };
}
