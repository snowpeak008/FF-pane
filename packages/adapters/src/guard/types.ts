/**
 * 适配器侧运行时权限拦截桥接（W2.7b）的公共类型与常量。
 *
 * 本层是 W2.7a（core/run-guard，纯裁决逻辑）与真实事件流之间的唯一接线：
 * run-guard 不知道"事件"，适配器不知道"权限"，guardTurn 把两者接上，
 * 使 T2.0 结论（三家 CLI 会把权限拒绝伪装成成功、Runtime 自带沙箱与审批
 * 一律不可信）在运行期真正生效。
 *
 * ## 两条路径（依 AdapterTurn.respondPermission 是否存在而分）
 * - **原生请求路径**（claude / opencode）：Runtime 主动发 `permission_request`
 *   事件，guard 用 run-guard 裁决其 payload 后**自动应答**（allowed → allow，
 *   violation → deny），只有 needs_approval 原样上浮给编排层交用户决定。
 * - **自产请求路径**（codex / gemini，无原生转发通道）：guard 在
 *   `file_change` / `command` 的 `started` 事件上做事前裁决，needs_approval 时
 *   **合成** `permission_request` 事件上浮（nativeRequestId 带
 *   {@link SELF_PRODUCED_REQUEST_PREFIX} 前缀），violation 时留档并按
 *   {@link GuardOptions.cancelOnViolation} 取消整轮。
 *
 * ## 取消语义（本工单决定，Phase 4 依赖）
 * 自产路径不存在"暂停 Runtime"这回事：`started` 到达时动作已在执行，guard 只是
 * 观察者，唯一能执行的补救是杀掉这一轮。故：
 * | 层级 | 裁决 | 处置 | 是否取消整轮 |
 * |---|---|---|---|
 * | 请求级（permission_request 事件） | violation | 自动 deny 回执 | 否——拒绝已生效，Agent 可改道继续 |
 * | 请求级 | needs_approval | 原样上浮 | 否 |
 * | 动作级（started 事件） | violation | 合成违规留档事件 | 是（`cancelOnViolation`，默认 true） |
 * | 动作级 | needs_approval | 合成 permission_request 上浮 | 用户 deny 时取消（`cancelOnDeny`，默认 true） |
 *
 * "请求级 violation 不挂起等用户"是有意的：violation 是恒拒态（项目外路径、
 * 合同禁止项、shell 闸门），把它挂成待批会既卡住 Runtime 又违背恒拒语义。
 * 申诉通道不丢——违规留档里带着可送审的 request，编排层可据此让用户批准后
 * 以新的 `grants` 重新 assembleRunEnvelope 并重开一轮。
 */

import type {
  DangerousCommandRule,
  RunDangerousApproval,
  RunEvidenceAuditResult,
  RunGuardViolation,
} from "@ff-pane/core";
import type {
  CommandRecord,
  DangerousOperation,
  FileChange,
  PermissionEnvelope,
  PermissionRequestPayload,
} from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";
import type { AdapterTurn, PermissionDecision } from "../adapter.js";
import type { AgentEvent, FileChangeKind } from "../events/index.js";

/**
 * guard 自产事件的 `runtime` 标记（RawEvent.runtime 是开放的 RuntimeId 字符串）。
 * 任何 `raw` 事件带此值即"来自 FF-pane 权限层，不是 Runtime 原生事件"。
 */
export const GUARD_RUNTIME_ID = "ff-pane-guard";

/**
 * guard 合成的 permission_request 的 nativeRequestId 前缀。
 * 编排层据此区分"原生请求"（回执会真的走 Runtime 协议）与"自产请求"
 * （回执只影响 FF-pane 自己的裁决与取消决策，Runtime 侧无从知晓）。
 */
export const SELF_PRODUCED_REQUEST_PREFIX = "ff-pane-guard:self:";

/** guard 留档事件的 `nativeType`（raw 事件的稳定判别键，进 Run 原始日志）。 */
export const GUARD_EVENT_TYPES = [
  /** 原生请求经裁决自动放行并已回执 allow。 */
  "guard.request_auto_allowed",
  /** 原生请求经裁决判为恒拒并已回执 deny。 */
  "guard.request_auto_denied",
  /** 动作级事前裁决判为恒拒（无回执通道，故只能留档 + 按选项取消整轮）。 */
  "guard.action_violation",
  /** 用户批准了一条待批请求（含本轮信封放宽 / 危险操作逐次确认记录）。 */
  "guard.request_approved",
  /** 用户拒绝了一条待批请求。 */
  "guard.request_denied",
  /** guard 主动取消了本轮。 */
  "guard.cancelled",
  /** Runtime 自称拒绝了某动作（不作为放行依据，见 README 提醒 ⑥）。 */
  "guard.runtime_denied",
  /** 收尾审计结论。 */
  "guard.audit_result",
  /** end 事件被审计结论改写（原文一并留档）。 */
  "guard.end_rewritten",
  /** 其它诊断（无法回执、未登记的回执、内层流未以 end 收尾等）。 */
  "guard.notice",
] as const;

/** guard 留档事件的 nativeType。 */
export type GuardEventType = (typeof GUARD_EVENT_TYPES)[number];

/** GuardEventType 运行时守卫（读入持久化的事件日志时校验）。 */
export const isGuardEventType = createLiteralGuard(GUARD_EVENT_TYPES);

/** 被裁决对象的来源路径。 */
export const GUARD_REQUEST_ORIGINS = ["native", "self_produced"] as const;

/** 被裁决对象的来源路径。 */
export type GuardRequestOrigin = (typeof GUARD_REQUEST_ORIGINS)[number];

/** GuardRequestOrigin 运行时守卫。 */
export const isGuardRequestOrigin = createLiteralGuard(GUARD_REQUEST_ORIGINS);

/**
 * 一条拦截记录的最终处置：
 * - auto_denied  原生请求判恒拒，guard 已回执 deny；
 * - recorded     判恒拒但无回执通道（自产路径），只留档（并按选项取消整轮）；
 * - pending      已上浮待用户决定，本轮结束时仍未回执；
 * - approved     用户批准（写路径/命令批准落入本轮信封；危险操作落入逐次确认记录）；
 * - denied       用户拒绝；
 * - reapproved   本轮此前已批准过同一操作，未再次打扰用户。
 */
export const GUARD_INTERCEPTION_OUTCOMES = [
  "auto_denied",
  "recorded",
  "pending",
  "approved",
  "denied",
  "reapproved",
] as const;

/** 拦截记录的最终处置。 */
export type GuardInterceptionOutcome = (typeof GUARD_INTERCEPTION_OUTCOMES)[number];

/** GuardInterceptionOutcome 运行时守卫。 */
export const isGuardInterceptionOutcome = createLiteralGuard(GUARD_INTERCEPTION_OUTCOMES);

/** 裁决对象的层级：请求级（Runtime 主动问）还是动作级（我们从事件流截获）。 */
export const GUARD_INTERCEPTION_LEVELS = ["request", "action"] as const;

/** 裁决对象的层级。 */
export type GuardInterceptionLevel = (typeof GUARD_INTERCEPTION_LEVELS)[number];

/** GuardInterceptionLevel 运行时守卫。 */
export const isGuardInterceptionLevel = createLiteralGuard(GUARD_INTERCEPTION_LEVELS);

/**
 * 归一化的三态裁决（把 run-guard 的 FileChangeJudgement / CommandJudgement 与
 * 本层自判的读/网络裁决收敛为同一形状）。
 *
 * `violation` 分支的 `violation` 字段仅在 run-guard 真的产出结构化违规记录时出现
 *（写路径与命令）；读路径与网络的裁决是本层按信封直判的，不伪造 RunGuardViolation
 *（RunGuardViolation.target 只表达"写文件 / 执行命令"两种对象）。
 */
export type GuardJudgement =
  | {
      readonly decision: "allowed";
      readonly reason: string;
    }
  | {
      readonly decision: "violation";
      readonly reason: string;
      /** run-guard 的结构化违规记录（读/网络裁决时缺席）。 */
      readonly violation?: RunGuardViolation;
      /** 可送审的申诉载荷（恒拒但存在批准通道时给出，如 shell 闸门）。 */
      readonly request?: PermissionRequestPayload;
    }
  | {
      readonly decision: "needs_approval";
      readonly reason: string;
      /** 可直接上浮的送审载荷。 */
      readonly request: PermissionRequestPayload;
      readonly dangerousOperations: readonly DangerousOperation[];
      /**
       * 交给 `auditRunEvidence` 的审批明细（危险操作逐次确认用）。
       *
       * **不能拿 `request.detail` 当它用**：`request.detail` 是给人看的文案
       *（如"删除 src/a.ts"），而 core 的审批匹配对路径按项目内比较键、对命令按
       * 命令比较键做精确匹配。故此处给的是路径本身或命令原文。
       */
      readonly approvalDetail?: string;
    };

/** 一条拦截记录（`GuardedTurn.interceptions()` 的元素，快照语义）。 */
export interface GuardInterception {
  readonly origin: GuardRequestOrigin;
  readonly level: GuardInterceptionLevel;
  readonly decision: "violation" | "needs_approval";
  readonly outcome: GuardInterceptionOutcome;
  readonly reason: string;
  /** 上浮时使用的请求 ID（未上浮时缺席）。 */
  readonly nativeRequestId?: string;
  /** run-guard 的结构化违规记录（有则给出，便于 Reviewer 报告直接复用）。 */
  readonly violation?: RunGuardViolation;
  /** 送审 / 申诉载荷。 */
  readonly request?: PermissionRequestPayload;
}

/** 证据里的一条文件修改（changeKind 恒透传给 run-guard，避免删除越界被漏判）。 */
export interface GuardEvidenceFileChange {
  readonly path: string;
  readonly changeKind: FileChangeKind;
  /** unified diff。Runtime 未给出且适配器未自补时缺席（不造假空 diff）。 */
  readonly diff?: string;
}

/** 证据里的一条命令记录。 */
export interface GuardEvidenceCommand {
  readonly command: string;
  /** 结构化退出码。Runtime 不提供时缺席（如 gemini）。 */
  readonly exitCode?: number;
}

/** 本轮收集到的证据（喂给 `auditRunEvidence`，并供 Phase 4 落 §6.4 的 Run 记录）。 */
export interface GuardRunEvidence {
  /** 已发生的文件修改（status 为 completed / failed 的 file_change）。 */
  readonly fileChanges: readonly GuardEvidenceFileChange[];
  /** 已执行的命令（status 为 completed / failed 的 command）。 */
  readonly commands: readonly GuardEvidenceCommand[];
  /**
   * Runtime 自称被阻断的动作摘要（denied / failed），语义与 codex 适配器的
   * "环境阻断证据"一致：**只用于给 end 写明原因，不作为放行依据**——Runtime 说
   * "我拒绝了"不能证明动作没发生，权限事实源只有 run-guard 的裁决。
   */
  readonly runtimeBlockages: readonly string[];
}

/** §6.4 的 Run 记录形态（`toStoredRunEvidence` 的产物）。 */
export interface StoredRunEvidence {
  readonly fileChanges: readonly FileChange[];
  readonly commands: readonly CommandRecord[];
}

/** guardTurn 的行为选项。 */
export interface GuardOptions {
  /**
   * 动作级事前裁决判为恒拒时是否取消整轮。默认 **true**。
   *
   * 为什么默认取消：自产路径没有回执通道，`started` 已经意味着 Runtime 正在动手，
   * 不取消就等于放任越界继续（T2.0 的"沙箱不可信"正是此处的前提）。
   * 请求级 violation 不受此项影响——那里的 deny 回执已经精确阻断。
   */
  readonly cancelOnViolation?: boolean;
  /**
   * 用户拒绝一条 **自产** 请求后是否取消整轮。默认 **true**。
   *
   * 同上：自产请求的 deny 无法送达 Runtime，唯一能执行的补救就是取消。
   * 原生请求的 deny 恒不取消（Runtime 已收到拒绝，Agent 可改道继续）。
   */
  readonly cancelOnDeny?: boolean;
}

/** guardTurn 的裁决上下文。 */
export interface GuardTurnContext {
  /**
   * Run 工作目录 = 项目根（§10.2）。**必填**：四家 Runtime 的事件多给绝对路径，
   * 缺 cwd 会让 run-guard 把一切绝对路径判为项目外，正常写入全报 violation。
   * 应与 `AdapterTurnContext.cwd` 完全一致。
   */
  readonly cwd: string;
  /** 本 Run 的最终信封（`assembleRunEnvelope().envelope`，已含计划批准）。 */
  readonly envelope: PermissionEnvelope;
  /** `assembleRunEnvelope().forbiddenPaths` 原样展开（不要自己解析 taskContract）。 */
  readonly forbiddenPaths?: readonly string[];
  /** `assembleRunEnvelope().verifyCommands` 原样展开。 */
  readonly verifyCommands?: readonly string[];
  /** 追加的危险命令规则（§7 内置清单只增不减）。 */
  readonly extraDangerousRules?: readonly DangerousCommandRule[];
  /**
   * 本轮注入的密钥表（`buildGuardedEnv().secrets`），**仅用于事件文本的兜底遮蔽**。
   * guard 不读取、不转发、不记录其内容，只把值的字面量从透传文本里换成占位标记。
   */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly options?: GuardOptions;
}

/**
 * 被 guard 包装后的一轮。事件流形状与 `AdapterTurn` 完全一致（仍恰好一条 end 收尾），
 * 额外暴露裁决侧的事实：本轮信封、拦截清单、危险操作审批记录、证据与收尾审计结论。
 */
export interface GuardedTurn extends AdapterTurn {
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * 回执一条上浮的权限请求。
   *
   * - 原生请求：转发给内层 turn（真的走 Runtime 协议）；
   * - 自产请求：allow = 记录放行（写路径/命令批准并入本轮信封，危险操作进逐次
   *   确认记录）；deny = 按 `cancelOnDeny` 决定是否取消整轮。
   *
   * 同一请求 ID 只应回执一次；未登记的 ID 在无原生通道时抛 {@link GuardError}。
   */
  respondPermission(nativeRequestId: string, decision: PermissionDecision): Promise<void>;
  cancel(): Promise<void>;
  /** 本轮当前信封（含用户批准造成的放宽；危险操作确认不落信封，见 approvals()）。 */
  envelope(): PermissionEnvelope;
  /** 拦截清单快照（violation 与 needs_approval，含最终处置）。 */
  interceptions(): readonly GuardInterception[];
  /** 本轮的危险操作逐次确认记录（原样交给 `auditRunEvidence`）。 */
  approvals(): readonly RunDangerousApproval[];
  /** 已收集的证据快照。 */
  evidence(): GuardRunEvidence;
  /** 收尾审计结论；end 事件到达前为 undefined。 */
  auditResult(): RunEvidenceAuditResult | undefined;
}

/** guard 使用错误（未登记的权限回执等装配级 bug），快速失败。 */
export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** nativeRequestId 是否为 guard 自产（无原生转发通道）。 */
export function isSelfProducedRequestId(nativeRequestId: string): boolean {
  return nativeRequestId.startsWith(SELF_PRODUCED_REQUEST_PREFIX);
}

/** 事件是否由 guard 自身产生（留档 raw 事件或自产权限请求）。 */
export function isGuardProducedEvent(event: AgentEvent): boolean {
  if (event.kind === "raw") {
    return event.runtime === GUARD_RUNTIME_ID;
  }
  if (event.kind === "permission_request") {
    return isSelfProducedRequestId(event.nativeRequestId);
  }
  return false;
}
