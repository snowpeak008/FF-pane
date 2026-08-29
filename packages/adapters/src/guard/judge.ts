/**
 * 事件 → run-guard 裁决入参的桥接（W2.7b 的裁决半边）。
 *
 * 本模块是纯函数，不碰事件流（那是 guard-turn.ts 的事）。它只做三件事：
 * 1. 把 `GuardTurnContext` 展开成 run-guard 的 `RunGuardContext`——**cwd 必填**，
 *    因为四家 Runtime 的事件多给绝对路径，缺 cwd 会让 run-guard 把项目内的正常
 *    写入全判为项目外 violation；`forbiddenPaths` / `verifyCommands` 原样展开自
 *    `assembleRunEnvelope` 的产物，本层不重新解析任务合同。
 * 2. 把 `FileChangeJudgement` / `CommandJudgement` 收敛成统一的
 *    {@link GuardJudgement}，并补上 `approvalDetail`（危险操作逐次确认的匹配口径，
 *    见该字段注释——这是"审批过却被事后审计记成违规"的唯一防线）。
 * 3. 对 run-guard 不覆盖的两类请求载荷（read_path / network）按信封直判。
 *    W2.7a 只覆盖写路径与命令，因为只有那两类会以事件形式主动发生；读与网络只在
 *    原生权限请求里出现（claude / opencode），故其裁决落在本桥接层，规则与
 *    judgeFileChange 一致：项目外恒拒、信封内放行、其余送审。
 *    凭证类路径（`.ssh` / `.env` / `id_rsa` …）的危险判定在命令层（W1.4c 的危险
 *    规则扫描命令原文），读请求这一侧只过信封的 readPaths。
 *
 * changeKind 的处理遵循 W2.7a 的桥接提醒：能透传就透传（codex 直接给 kind），
 * 给不出时交给 core 的 `inferFileChangeKind` 从 diff 反推，再推不出按 update——
 * 删除越界是危险操作，漏判的代价最大，故 add/delete 的信息一律不丢。
 */

import type { CommandJudgement, FileChangeJudgement, RunGuardContext } from "@ff-pane/core";
import {
  canRead,
  inferFileChangeKind,
  judgeCommand,
  judgeFileChange,
  resolveRunPath,
} from "@ff-pane/core";
import type { PermissionEnvelope, PermissionRequestPayload } from "@ff-pane/shared";
import type { FileChangeKind } from "../events/index.js";
import type { GuardJudgement, GuardTurnContext } from "./types.js";

/** 裁决所需的上下文（`GuardTurnContext` 的裁决子集，cwd 收窄为必填）。 */
export interface GuardJudgeContext extends RunGuardContext {
  /** 本 Run 的最终信封（含已生效的用户批准）。 */
  readonly envelope: PermissionEnvelope;
  /** Run 工作目录 = 项目根，必填。 */
  readonly cwd: string;
}

/** 一次待裁决的文件写入。 */
export interface GuardFileChangeTarget {
  readonly path: string;
  /** Runtime 给出的变更类型；缺席时从 diff 反推，再推不出按 update。 */
  readonly changeKind?: FileChangeKind;
  readonly diff?: string;
}

/** 从 guardTurn 上下文取出裁决上下文（`envelope` 由调用方给，可能已被本轮批准放宽）。 */
export function toGuardJudgeContext(
  context: GuardTurnContext,
  envelope: PermissionEnvelope,
): GuardJudgeContext {
  return {
    cwd: context.cwd,
    envelope,
    ...(context.forbiddenPaths === undefined ? {} : { forbiddenPaths: context.forbiddenPaths }),
    ...(context.verifyCommands === undefined ? {} : { verifyCommands: context.verifyCommands }),
    ...(context.extraDangerousRules === undefined
      ? {}
      : { extraDangerousRules: context.extraDangerousRules }),
  };
}

function runGuardContextOf(context: GuardJudgeContext): RunGuardContext {
  return {
    cwd: context.cwd,
    ...(context.forbiddenPaths === undefined ? {} : { forbiddenPaths: context.forbiddenPaths }),
    ...(context.verifyCommands === undefined ? {} : { verifyCommands: context.verifyCommands }),
    ...(context.extraDangerousRules === undefined
      ? {}
      : { extraDangerousRules: context.extraDangerousRules }),
  };
}

/** 定下本次写入的 changeKind（透传优先 → diff 反推 → update 兜底）。 */
export function resolveGuardChangeKind(target: GuardFileChangeTarget): FileChangeKind {
  return inferFileChangeKind({
    path: target.path,
    ...(target.changeKind === undefined ? {} : { changeKind: target.changeKind }),
    ...(target.diff === undefined ? {} : { diff: target.diff }),
  });
}

function fromFileChangeJudgement(judgement: FileChangeJudgement): GuardJudgement {
  if (judgement.decision === "allowed") {
    return { decision: "allowed", reason: judgement.reason };
  }
  if (judgement.decision === "violation") {
    return {
      decision: "violation",
      reason: judgement.violation.reason,
      violation: judgement.violation,
    };
  }
  return {
    decision: "needs_approval",
    reason: judgement.reason,
    request: judgement.request,
    dangerousOperations: judgement.dangerousOperations,
    // 路径按项目内比较键交给审批记录：core 的审批匹配对路径正是按此键比较，
    // 而 request.detail 是"删除 xxx"这样的展示文案，拿它当明细必然匹配不上。
    approvalDetail: judgement.projectPath,
  };
}

function fromCommandJudgement(judgement: CommandJudgement, command: string): GuardJudgement {
  if (judgement.decision === "allowed") {
    return { decision: "allowed", reason: judgement.reason };
  }
  if (judgement.decision === "violation") {
    return {
      decision: "violation",
      reason: judgement.violation.reason,
      violation: judgement.violation,
      // shell 闸门的拒绝可由用户逐条批准打开，故保留申诉载荷（本层不自行放行）。
      request: judgement.request,
    };
  }
  return {
    decision: "needs_approval",
    reason: judgement.reason,
    request: judgement.request,
    dangerousOperations: judgement.classification.dangerousOperations,
    approvalDetail: command,
  };
}

/** 裁决一次文件写入（file_change 的 started 事件 / write_path 请求载荷）。 */
export function judgeGuardFileChange(
  target: GuardFileChangeTarget,
  context: GuardJudgeContext,
): GuardJudgement {
  return fromFileChangeJudgement(
    judgeFileChange({
      ...runGuardContextOf(context),
      envelope: context.envelope,
      path: target.path,
      changeKind: resolveGuardChangeKind(target),
    }),
  );
}

/** 裁决一条命令（command 的 started 事件 / shell_command 请求载荷）。 */
export function judgeGuardCommand(command: string, context: GuardJudgeContext): GuardJudgement {
  return fromCommandJudgement(
    judgeCommand({ ...runGuardContextOf(context), envelope: context.envelope, command }),
    command,
  );
}

/** 裁决一次读取（仅原生请求载荷会出现；规则见文件头第 3 条）。 */
export function judgeGuardRead(path: string, context: GuardJudgeContext): GuardJudgement {
  const resolution = resolveRunPath(path, context.cwd);
  if (!resolution.inProject) {
    return {
      decision: "violation",
      reason: `读取的目标在项目外，恒拒：${resolution.reason}`,
    };
  }
  if (canRead(context.envelope, resolution.key)) {
    return { decision: "allowed", reason: `读取 ${resolution.key} 在本 Run 可读范围内` };
  }
  return {
    decision: "needs_approval",
    reason: `读取 ${resolution.key} 超出本 Run 可读范围，需用户批准 read_path 扩展（仅当前 Run 有效）`,
    request: { kind: "read_path", path: resolution.key },
    dangerousOperations: [],
    approvalDetail: resolution.key,
  };
}

/** 裁决一次联网（仅原生请求载荷会出现）。 */
export function judgeGuardNetwork(
  payload: Extract<PermissionRequestPayload, { kind: "network" }>,
  context: GuardJudgeContext,
): GuardJudgement {
  const target = payload.target === undefined ? "" : `（目标 ${payload.target}）`;
  if (context.envelope.network) {
    return { decision: "allowed", reason: `本 Run 允许联网${target}` };
  }
  return {
    decision: "needs_approval",
    reason: `本 Run 默认禁止联网${target}，需用户批准 network 扩展（仅当前 Run 有效）`,
    request: payload,
    dangerousOperations: [],
  };
}

/**
 * 裁决一条原生权限请求的载荷。
 *
 * `hints` 用于补 write_path 载荷缺失的变更类型信息：原生请求只给路径
 *（opencode 的 permission.asked 另给 metadata.diff），把 diff 交给本函数就能让
 * run-guard 认出"这是删除"，从而走危险操作逐次确认而不是普通的 write_path 扩展。
 */
export function judgeGuardPayload(
  payload: PermissionRequestPayload,
  context: GuardJudgeContext,
  hints: { readonly changeKind?: FileChangeKind; readonly diff?: string } = {},
): GuardJudgement {
  switch (payload.kind) {
    case "read_path":
      return judgeGuardRead(payload.path, context);
    case "write_path":
      return judgeGuardFileChange(
        {
          path: payload.path,
          ...(hints.changeKind === undefined ? {} : { changeKind: hints.changeKind }),
          ...(hints.diff === undefined ? {} : { diff: hints.diff }),
        },
        context,
      );
    case "shell_command":
      return judgeGuardCommand(payload.command, context);
    case "network":
      return judgeGuardNetwork(payload, context);
    case "dangerous_operation":
      // §7 第 5 项不可关闭：危险操作恒需用户逐次确认，没有"信封已放行"这一态。
      return {
        decision: "needs_approval",
        reason: `危险操作「${payload.operation}」需用户逐次确认（§7 固定清单）：${payload.detail}`,
        request: payload,
        dangerousOperations: [payload.operation],
        approvalDetail: payload.detail,
      };
  }
}
