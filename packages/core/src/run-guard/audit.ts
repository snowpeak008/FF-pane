/**
 * Run 证据事后审计（W2.7a）：对一次 Run 已发生的文件修改与命令做越界复核。
 *
 * 这是"事前拦截 + 事后审计"双保险的事后半边，存在的理由是 T2.0 的结论：
 * 三家 CLI 会把权限拒绝伪装成成功，也可能在我们的拦截点之外动手（子进程、
 * 内建工具、Runtime 自己的沙箱放行）。因此 Run 结束时必须拿证据（§6.4 的
 * file_changes / commands）重算一遍——事前拦截漏掉的，事后一定要能查出来。
 *
 * 事后没有"待批准"这一态：操作已经发生了。审计因此把 needs_approval 也计为违规，
 * 除非调用方以 approvedDangerousOperations 明确交出"当时用户确认过"的记录
 *（危险操作的逐次确认不落入信封，见 W1.4c applyRunGrant 的 dangerous_operation
 * 分支，故必须由编排层把审批记录带进来，否则每次危险操作放行都会被误判为违规）。
 *
 * 消费方：Reviewer 的证据验收（§6.4 / §11.5 执行记录页）与 Run 收尾流程。
 */

import type { DangerousOperation, PermissionEnvelope } from "@ff-pane/shared";
import { normalizeCommandKey } from "../permission/index.js";
import { judgeCommand, judgeFileChange } from "./judge.js";
import { resolveRunPath } from "./resolve.js";
import type {
  RunFileChangeKind,
  RunGuardContext,
  RunGuardViolation,
  RunGuardViolationCode,
} from "./types.js";

/**
 * 证据里的一条文件修改。结构上兼容 shared 的 FileChange（§6.4，只有 path + diff）
 * 与 adapters 的 FileChangeEvent（有 changeKind）——桥接层（W2.7b）能给 changeKind
 * 就给，给不出时本模块从 diff 反推（inferFileChangeKind）。
 */
export interface RunEvidenceFileChange {
  readonly path: string;
  readonly changeKind?: RunFileChangeKind;
  /** unified diff 文本（§6.4）。 */
  readonly diff?: string;
}

/** 证据里的一条命令记录。结构上兼容 shared 的 CommandRecord（§6.4）。 */
export interface RunEvidenceCommand {
  readonly command: string;
  readonly exitCode?: number;
}

/** 一次 Run 的证据子集（两个列表都可缺席，缺席即"没有该类证据"）。 */
export interface RunEvidence {
  readonly fileChanges?: readonly RunEvidenceFileChange[];
  readonly commands?: readonly RunEvidenceCommand[];
}

/**
 * 当时已获用户逐次确认的危险操作（§7）。危险操作确认不产生信封层的豁免，
 * 只对"那一次"有效，故审计需要这份记录才能把它与越界区分开。
 * detail 缺省 = 该类危险操作在本 Run 内一律视为已确认；给出 detail 时按精确匹配
 *（命令按比较键、路径按项目内比较键）。
 */
export interface RunDangerousApproval {
  readonly operation: DangerousOperation;
  readonly detail?: string;
}

/** auditRunEvidence 选项：裁决上下文 + 危险操作审批记录。 */
export interface RunEvidenceAuditOptions extends RunGuardContext {
  readonly approvedDangerousOperations?: readonly RunDangerousApproval[];
}

/** 事后审计结果。 */
export interface RunEvidenceAuditResult {
  /** 无违规即通过（waived 不影响通过）。 */
  readonly ok: boolean;
  /** 违规清单（Reviewer 报告与 Run 日志直接使用）。 */
  readonly violations: readonly RunGuardViolation[];
  /** 被"当时已确认"的危险操作审批记录豁免的条目（保留以便追溯，不计入违规）。 */
  readonly waived: readonly RunGuardViolation[];
  readonly checkedFileChanges: number;
  readonly checkedCommands: number;
}

/** 删除侧的 diff 标记（新文件为 /dev/null 即删除；旧文件为 /dev/null 即新建）。 */
const DIFF_DELETED = /^\+\+\+\s+(?:b\/)?\/dev\/null\s*$/m;
const DIFF_ADDED = /^---\s+(?:a\/)?\/dev\/null\s*$/m;

/**
 * 推断文件变更类型：显式 changeKind 优先；否则从 unified diff 的 /dev/null 侧反推
 *（storage 里的 FileChange 只有 path + diff）；再推不出按 update 处理——update 是
 * 最弱的假设，不会把普通修改误升级为"删除越界"这类危险操作。
 */
export function inferFileChangeKind(change: RunEvidenceFileChange): RunFileChangeKind {
  if (change.changeKind !== undefined) {
    return change.changeKind;
  }
  const diff = change.diff ?? "";
  if (DIFF_DELETED.test(diff)) {
    return "delete";
  }
  if (DIFF_ADDED.test(diff)) {
    return "add";
  }
  return "update";
}

function approvalMatches(
  approval: RunDangerousApproval,
  violation: RunGuardViolation,
  cwd: string | undefined,
): boolean {
  if (!violation.dangerousOperations.includes(approval.operation)) {
    return false;
  }
  if (approval.detail === undefined) {
    return true;
  }
  if (violation.target.kind === "command") {
    return normalizeCommandKey(approval.detail) === normalizeCommandKey(violation.target.command);
  }
  const resolved = resolveRunPath(approval.detail, cwd);
  return resolved.inProject && resolved.key === violation.target.projectPath;
}

function contextOf(options: RunEvidenceAuditOptions): RunGuardContext {
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.forbiddenPaths === undefined ? {} : { forbiddenPaths: options.forbiddenPaths }),
    ...(options.verifyCommands === undefined ? {} : { verifyCommands: options.verifyCommands }),
    ...(options.extraDangerousRules === undefined
      ? {}
      : { extraDangerousRules: options.extraDangerousRules }),
  };
}

/**
 * 事后审计一次 Run 的证据。envelope 传该 Run 的最终信封（assembleRunEnvelope
 * 的产物，已含用户批准），否则批准过的写路径会被误报为越界。
 */
export function auditRunEvidence(
  envelope: PermissionEnvelope,
  evidence: RunEvidence,
  options: RunEvidenceAuditOptions = {},
): RunEvidenceAuditResult {
  const context = contextOf(options);
  const approvals = options.approvedDangerousOperations ?? [];
  const violations: RunGuardViolation[] = [];
  const waived: RunGuardViolation[] = [];

  const record = (violation: RunGuardViolation): void => {
    const waivable = violation.code === "dangerous_operation_unapproved";
    const approved =
      waivable && approvals.some((approval) => approvalMatches(approval, violation, options.cwd));
    (approved ? waived : violations).push(violation);
  };

  const fileChanges = evidence.fileChanges ?? [];
  for (const change of fileChanges) {
    const changeKind = inferFileChangeKind(change);
    const judgement = judgeFileChange({ ...context, envelope, path: change.path, changeKind });
    if (judgement.decision === "violation") {
      record(judgement.violation);
      continue;
    }
    if (judgement.decision === "needs_approval") {
      const code: RunGuardViolationCode =
        judgement.request.kind === "write_path"
          ? "write_outside_envelope"
          : "dangerous_operation_unapproved";
      record({
        code,
        target: {
          kind: "file_change",
          path: change.path,
          changeKind,
          projectPath: judgement.projectPath,
        },
        reason: `事后审计：该操作已发生但未获批准。${judgement.reason}`,
        dangerousOperations: judgement.dangerousOperations,
      });
    }
  }

  const commands = evidence.commands ?? [];
  for (const entry of commands) {
    const judgement = judgeCommand({ ...context, envelope, command: entry.command });
    if (judgement.decision === "violation") {
      record({
        ...judgement.violation,
        reason: `事后审计：该命令已执行但不被本 Run 权限放行。${judgement.violation.reason}`,
      });
      continue;
    }
    if (judgement.decision === "needs_approval") {
      record({
        code: "dangerous_operation_unapproved",
        target: { kind: "command", command: entry.command },
        reason: `事后审计：该命令已执行但未获逐次确认。${judgement.reason}`,
        dangerousOperations: judgement.classification.dangerousOperations,
      });
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    waived: Object.freeze(waived),
    checkedFileChanges: fileChanges.length,
    checkedCommands: commands.length,
  });
}
