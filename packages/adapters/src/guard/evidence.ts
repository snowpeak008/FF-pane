/**
 * 证据收集与收尾审计的纯逻辑（W2.7b 第 2 项）。
 *
 * ## 什么算"证据"
 * 事件流里的动作有四态（started / completed / failed / denied）：
 * - `completed`：动作发生且成功 → 入证据；
 * - `failed`：动作**执行过**但失败 → 入证据。写文件失败可能已部分落地、命令跑失败
 *   也确实跑了，事后审计必须看得见它们（宁严勿松）；
 * - `denied`：Runtime 自称"没执行" → **不入证据，但也不当作放行依据**。T2.0 已证明
 *   Runtime 的回执会说谎，故 guard 对 denied 的动作照样独立裁决一次：判为越界就记入
 *   拦截清单（"尝试越界，Runtime 自称已拒绝，本层不采信"），判为放行则说明这是
 *   Runtime 侧的环境阻断（沙箱 / 自带策略），只记入 {@link GuardRunEvidence.runtimeBlockages}；
 * - `started`：动作尚无结果 → 只做事前拦截，不入证据。
 *
 * ## end 事件的收敛策略（本工单决定）
 * 降级条件 = 事后审计的未豁免违规 ∪ **未能当场拒掉的**恒拒拦截 ∪ guard 主动取消本轮。
 * 命中任一且 Runtime 报的是 `completed` → 改写为 `failed`；Runtime 报的是
 * failed/cancelled/crashed 则保留原 reason，只补写 message。原 end 一并留档，不丢原文。
 *
 * "未能当场拒掉"是关键限定：原生请求判恒拒时 guard 会回执 deny，动作压根没发生，
 * 那是权限系统正常工作，不该把整轮记成失败；而动作级恒拒（无回执通道）与"想拒却
 * 没有通道"的请求都属于拦不住，必须让 end 说出来。
 *
 * `runtimeBlockages` 只进 message、不改 reason：Runtime 侧阻断的判定权属适配器
 * （codex 适配器已按"环境阻断证据"把 turn.completed 收成 failed），guard 再降一次
 * 只会掩盖"是谁发现的"。语义与 codex 的 blockageOf 一致，位置不同而已。
 */

import type { RunDangerousApproval, RunEvidenceAuditResult } from "@ff-pane/core";
import { auditRunEvidence } from "@ff-pane/core";
import type { PermissionEnvelope } from "@ff-pane/shared";
import type { AgentEvent, CommandEvent, EndEvent, FileChangeEvent } from "../events/index.js";
import type {
  GuardEvidenceCommand,
  GuardEvidenceFileChange,
  GuardInterception,
  GuardRunEvidence,
  GuardTurnContext,
  StoredRunEvidence,
} from "./types.js";

/**
 * 无结构化退出码时写入 §6.4 CommandRecord 的占位值（gemini 全程无退出码，
 * codex 的沙箱错误本身也是 -1）。只用于持久化形态，判成败一律看事件的 status。
 */
export const UNKNOWN_EXIT_CODE = -1;

/** 摘要里命令原文的截断长度（codex 在 Windows 下给的是完整 powershell 调用串）。 */
const COMMAND_EXCERPT_LENGTH = 60;

/** 摘要最多列出的条目数。 */
const SUMMARY_EXCERPT_COUNT = 3;

function excerpt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= COMMAND_EXCERPT_LENGTH
    ? single
    : `${single.slice(0, COMMAND_EXCERPT_LENGTH)}…`;
}

function listed(items: readonly string[]): string {
  const head = items.slice(0, SUMMARY_EXCERPT_COUNT).join("；");
  return items.length > SUMMARY_EXCERPT_COUNT ? `${head} 等 ${items.length} 项` : head;
}

/** file_change 事件是否构成证据；构成则给出证据条目（changeKind 恒透传）。 */
export function fileChangeEvidenceOf(event: FileChangeEvent): GuardEvidenceFileChange | undefined {
  if (event.status !== "completed" && event.status !== "failed") {
    return undefined;
  }
  return {
    path: event.path,
    changeKind: event.changeKind,
    ...(event.diff === undefined ? {} : { diff: event.diff }),
  };
}

/** command 事件是否构成证据；构成则给出证据条目。 */
export function commandEvidenceOf(event: CommandEvent): GuardEvidenceCommand | undefined {
  if (event.status !== "completed" && event.status !== "failed") {
    return undefined;
  }
  return {
    command: event.command,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
  };
}

/**
 * Runtime 自称阻断的动作摘要（denied / failed）。语义对齐 codex 适配器的
 * "环境阻断证据"：只用于给 end 写明原因，**不作为权限放行或拒绝的依据**。
 */
export function runtimeBlockageOf(event: AgentEvent): string | undefined {
  if (event.kind === "file_change") {
    if (event.status === "denied") {
      return `file_change ${event.path}：Runtime 自称已拒绝`;
    }
    return event.status === "failed" ? `file_change ${event.path}：写入失败` : undefined;
  }
  if (event.kind === "command") {
    if (event.status === "denied") {
      return `command 被 Runtime 自称拒绝：${excerpt(event.command)}`;
    }
    return event.status === "failed" ? `command 执行失败：${excerpt(event.command)}` : undefined;
  }
  return undefined;
}

/** 把收集到的证据折算为 §6.4 的 Run 记录形态（Phase 4 落库用）。 */
export function toStoredRunEvidence(evidence: GuardRunEvidence): StoredRunEvidence {
  return {
    fileChanges: evidence.fileChanges.map((change) => ({
      path: change.path,
      diff: change.diff ?? "",
    })),
    commands: evidence.commands.map((entry) => ({
      command: entry.command,
      exitCode: entry.exitCode ?? UNKNOWN_EXIT_CODE,
    })),
  };
}

/**
 * 收尾审计。`approvals` 必须是本轮的危险操作逐次确认记录——危险操作的批准
 * 不落信封（W1.4c applyRunGrant 的 dangerous_operation 分支会抛错），不带进来
 * 的话每一次合法放行的危险操作都会被事后审计记成违规。
 */
export function auditGuardEvidence(
  envelope: PermissionEnvelope,
  evidence: GuardRunEvidence,
  context: GuardTurnContext,
  approvals: readonly RunDangerousApproval[],
): RunEvidenceAuditResult {
  return auditRunEvidence(
    envelope,
    { fileChanges: evidence.fileChanges, commands: evidence.commands },
    {
      cwd: context.cwd,
      approvedDangerousOperations: approvals,
      ...(context.forbiddenPaths === undefined ? {} : { forbiddenPaths: context.forbiddenPaths }),
      ...(context.verifyCommands === undefined ? {} : { verifyCommands: context.verifyCommands }),
      ...(context.extraDangerousRules === undefined
        ? {}
        : { extraDangerousRules: context.extraDangerousRules }),
    },
  );
}

/** end 收敛的输入事实。 */
export interface GuardEndFacts {
  readonly audit: RunEvidenceAuditResult;
  /** 判为恒拒**且未能当场拒掉**的拦截条目（已回执 deny 的不算，见文件头）。 */
  readonly violationInterceptions: readonly GuardInterception[];
  /** guard 主动取消本轮的原因；未取消时缺席。 */
  readonly guardCancelReason?: string;
  /** Runtime 自称阻断的动作摘要。 */
  readonly runtimeBlockages: readonly string[];
}

/** end 收敛结果。 */
export interface GuardEndAnnotation {
  /** 收敛后的 end（未命中降级条件时与入参同一引用）。 */
  readonly end: EndEvent;
  /** 是否改写了 reason 或 message。 */
  readonly rewritten: boolean;
  /** 收敛说明（留档事件与 end.message 共用）。 */
  readonly summary: string;
}

/** 生成收敛说明（无任何异常事实时返回空字符串）。 */
export function summarizeGuardFacts(facts: GuardEndFacts): string {
  const parts: string[] = [];
  if (facts.audit.violations.length > 0) {
    parts.push(
      `事后审计发现 ${facts.audit.violations.length} 项越界：` +
        listed(facts.audit.violations.map((violation) => violation.reason)),
    );
  }
  if (facts.violationInterceptions.length > 0) {
    parts.push(
      `事前拦截 ${facts.violationInterceptions.length} 项恒拒：` +
        listed(facts.violationInterceptions.map((interception) => interception.reason)),
    );
  }
  if (facts.guardCancelReason !== undefined) {
    parts.push(`FF-pane 权限层已取消本轮：${facts.guardCancelReason}`);
  }
  if (facts.audit.waived.length > 0) {
    parts.push(`另有 ${facts.audit.waived.length} 项危险操作因本轮已获用户逐次确认而豁免`);
  }
  if (facts.runtimeBlockages.length > 0) {
    parts.push(
      `Runtime 自称阻断 ${facts.runtimeBlockages.length} 项（不作为放行依据）：` +
        listed(facts.runtimeBlockages),
    );
  }
  return parts.join("；");
}

/**
 * 按审计结论给 end 加注（策略见文件头）。
 * 硬约束：存在未批违规时 reason 绝不为 `completed`。
 */
export function annotateGuardEnd(end: EndEvent, facts: GuardEndFacts): GuardEndAnnotation {
  const summary = summarizeGuardFacts(facts);
  const blocking = facts.audit.violations.length + facts.violationInterceptions.length;
  const downgrade = blocking > 0 || facts.guardCancelReason !== undefined;
  if (!downgrade) {
    // 只有 Runtime 阻断 / 豁免记录之类的诊断信息：不动 reason，也不改写 message。
    return { end, rewritten: false, summary };
  }
  const reason = end.reason === "completed" ? "failed" : end.reason;
  const message =
    end.message === undefined
      ? `FF-pane 权限层收尾判定：${summary}`
      : `FF-pane 权限层收尾判定：${summary}。Runtime 原文：${end.message}`;
  return { end: { ...end, reason, message }, rewritten: true, summary };
}
