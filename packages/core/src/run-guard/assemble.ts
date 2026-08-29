/**
 * Run 权限信封装配（W2.7a，设计文档 §7 / v0.1 §6.8、§29）。
 *
 * 权限公式（v0.1 §29 的五级，v1.0 §7 精简表述为"角色默认 ∩ 任务指定 ∩ 用户批准"）：
 *
 * ```text
 *   项目策略 ∩ 角色默认 ∩ Profile 预设 ∩ 任务信封   （逐级相交，只会变窄）
 *   → 逐条叠加用户批准（applyRunGrant，仅当前 Run 有效）
 *   = 本次 Run 的最终权限
 * ```
 *
 * "委派只能缩小权限"（v0.1 §6.8）由前四级全部走 intersectEnvelopes 保证：
 * 任何一级只能让结果更窄；唯一的放宽通道是用户批准，且逐条记入审计。
 *
 * ## 任务信封派生规则（本工单定义）
 * TaskContract 没有权限信封字段，只有 writeScope / forbidden / verifyCmd，
 * 因此任务这一级的信封按下述规则派生。缺省一律取"不收窄"，让约束由角色默认、
 * Profile 预设、项目策略去表达，避免任务合同意外成为最宽的一级：
 *
 * | 维度 | 派生 | 理由 |
 * |---|---|---|
 * | readPaths | `["**"]`（不收窄） | §7 三角色可读均为"项目内"，任务合同不约束读 |
 * | writePaths | `taskContract.writeScope` 原样 | §7 Worker 可写范围就是任务合同的 write_scope；空数组 = 本任务不可写 |
 * | shell | `"allowed"`（不收窄） | 命令策略是角色属性（Planner 禁止 / Worker 允许 / Reviewer 仅验证）；verify_cmd 不是"更宽的策略"，而是 verify_only 的白名单，走裁决层而非信封 |
 * | network | `taskNetwork ?? true` | §7"默认禁止，任务可开"：未声明 = 不收窄；显式声明 false = 本任务不需要网络，收窄为禁止 |
 * | dangerousOpsRequireApproval | 恒 `true` | §7 第 5 项不可关闭 |
 *
 * 关于"任务可开网络"：声明 `taskNetwork: true` **不构成放宽**。Worker 角色默认
 * network=false，交集后仍是 false；真正开网只能走用户批准（grants 里的
 * `{ kind: "network" }`），由编排层在计划批准时注入。这样"放宽只来自用户批准"
 * 在装配层是可证的性质，不会被任务合同悄悄绕过。
 *
 * forbidden 与 verify_cmd 不落入信封（信封只有 §7 的 5 项）：前者派生为禁写模式，
 * 后者派生为 verify_only 白名单，二者随装配结果一并返回，供裁决函数使用。
 */

import type {
  PermissionEnvelope,
  PermissionRequestPayload,
  Role,
  ShellPolicy,
  TaskContract,
  TaskId,
} from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";
import type { RunEnvelope } from "../permission/index.js";
import {
  applyRunGrant,
  intersectEnvelopes,
  isPatternCoveredByScopes,
  PROJECT_WIDE_SCOPE,
  ROLE_DEFAULT_ENVELOPES,
  toRunEnvelope,
} from "../permission/index.js";
import { deriveForbiddenPathPatterns } from "./forbidden.js";

/**
 * 相交的单位元（"尚无任何约束"）：项目内全部可读可写、shell 允许、网络允许。
 * 仅用作装配的起点与审计的 before 基线——角色默认必然参与相交，故它永远不可能
 * 成为最终信封；任何代码都不得把它当作可用信封直接下发。
 */
export const UNCONSTRAINED_PROJECT_ENVELOPE: PermissionEnvelope = Object.freeze({
  readPaths: Object.freeze([PROJECT_WIDE_SCOPE]),
  writePaths: Object.freeze([PROJECT_WIDE_SCOPE]),
  shell: "allowed",
  network: true,
  dangerousOpsRequireApproval: true,
} satisfies PermissionEnvelope);

/** 装配的各级（顺序即相交顺序；user_grant 在四级相交之后逐条叠加）。 */
export const RUN_ENVELOPE_STAGES = [
  "project_policy",
  "role_default",
  "profile_preset",
  "task_contract",
  "user_grant",
] as const;

/** 装配级别。 */
export type RunEnvelopeStage = (typeof RUN_ENVELOPE_STAGES)[number];

/** RunEnvelopeStage 运行时守卫。 */
export const isRunEnvelopeStage = createLiteralGuard(RUN_ENVELOPE_STAGES);

/** 信封的可变维度（dangerousOpsRequireApproval 恒 true，不可能变化）。 */
export const RUN_ENVELOPE_DIMENSIONS = [
  "readPaths",
  "writePaths",
  "shell",
  "network",
  "grantedCommands",
] as const;

/** 信封维度。 */
export type RunEnvelopeDimension = (typeof RUN_ENVELOPE_DIMENSIONS)[number];

/** RunEnvelopeDimension 运行时守卫。 */
export const isRunEnvelopeDimension = createLiteralGuard(RUN_ENVELOPE_DIMENSIONS);

/** 某一维在某一级发生的变化（相交只会 narrowed，用户批准才可能 widened）。 */
export type RunEnvelopeChange =
  | {
      readonly dimension: "readPaths" | "writePaths" | "grantedCommands";
      readonly direction: "narrowed" | "widened";
      readonly before: readonly string[];
      readonly after: readonly string[];
      readonly detail: string;
    }
  | {
      readonly dimension: "shell";
      readonly direction: "narrowed" | "widened";
      readonly before: ShellPolicy;
      readonly after: ShellPolicy;
      readonly detail: string;
    }
  | {
      readonly dimension: "network";
      readonly direction: "narrowed" | "widened";
      readonly before: boolean;
      readonly after: boolean;
      readonly detail: string;
    };

/** 装配审计的一步（每级一条；grants 每条批准各一条）。 */
export interface RunEnvelopeAuditStep {
  readonly stage: RunEnvelopeStage;
  /** 本级是否真正参与（项目未配策略、Profile 无预设、批准无效时为 false）。 */
  readonly applied: boolean;
  /** 未参与的原因（applied=false 时给出）。 */
  readonly skippedReason?: string;
  /** 本级引入的信封（相交级给出；user_grant 级没有信封形态的输入）。 */
  readonly input?: PermissionEnvelope;
  /** user_grant 级的批准内容。 */
  readonly grant?: PermissionRequestPayload;
  /** 本级之后的累积信封。 */
  readonly result: PermissionEnvelope;
  /** 本级造成的各维变化（无变化时为空数组）。 */
  readonly changes: readonly RunEnvelopeChange[];
}

/**
 * 装配审计记录：UI"当前权限"面板与 Run 日志的数据源。
 * 逐级可见"谁把哪一维收窄到什么"，以及本 Run 有哪些用户批准造成了放宽。
 */
export interface RunEnvelopeAudit {
  readonly role: Role;
  readonly taskId: TaskId;
  /** 装配起点（相交单位元）。 */
  readonly base: PermissionEnvelope;
  /** 由任务合同派生出的任务信封（供 UI 展示"本任务允许写哪里"）。 */
  readonly taskEnvelope: PermissionEnvelope;
  readonly steps: readonly RunEnvelopeAuditStep[];
  readonly final: RunEnvelope;
  /** 是否存在用户批准造成的放宽（UI 需要显著提示）。 */
  readonly widenedByGrants: boolean;
}

/** assembleRunEnvelope 入参。 */
export interface RunEnvelopeAssemblyInput {
  /** 本次 Run 的执行角色（§3.1）。 */
  readonly role: Role;
  /** 任务合同（§6.2）：writeScope / forbidden / verifyCmd 参与派生。 */
  readonly taskContract: TaskContract;
  /** Agent Profile 的权限预设（§4.4）；缺省 = 该级不收窄。 */
  readonly profilePreset?: PermissionEnvelope;
  /**
   * 项目级权限策略（§10.2 Project.permissionPolicy，按角色覆盖），
   * 原样传入即可；缺该角色 = 项目未设策略 = 该级不收窄。
   */
  readonly projectPolicy?: Partial<Record<Role, PermissionEnvelope>>;
  /** 用户批准（§7，仅当前 Run 有效），按给定顺序逐条叠加。 */
  readonly grants?: readonly PermissionRequestPayload[];
  /** 任务的网络需求声明；缺省 = 未声明（不收窄）。见文件头派生规则。 */
  readonly taskNetwork?: boolean;
}

/** 装配结果：最终信封 + 裁决所需的非信封约束 + 审计记录。 */
export interface AssembledRunEnvelope {
  readonly envelope: RunEnvelope;
  /** 任务合同 forbidden 派生的禁写模式（judgeFileChange 的 forbiddenPaths 入参）。 */
  readonly forbiddenPaths: readonly string[];
  /** verify_only 白名单（judgeCommand 的 verifyCommands 入参）。 */
  readonly verifyCommands: readonly string[];
  readonly audit: RunEnvelopeAudit;
}

/** 任务信封派生（规则见文件头表格）。 */
export function deriveTaskEnvelope(
  taskContract: TaskContract,
  taskNetwork?: boolean,
): PermissionEnvelope {
  return Object.freeze({
    readPaths: Object.freeze([PROJECT_WIDE_SCOPE]),
    writePaths: Object.freeze([...taskContract.writeScope]),
    shell: "allowed",
    network: taskNetwork ?? true,
    dangerousOpsRequireApproval: true,
  } satisfies PermissionEnvelope);
}

const SHELL_RANK: Readonly<Record<ShellPolicy, 0 | 1 | 2>> = Object.freeze({
  forbidden: 0,
  verify_only: 1,
  allowed: 2,
});

function renderScopeList(scopes: readonly string[]): string {
  return scopes.length === 0 ? "（无）" : `[${scopes.join(", ")}]`;
}

function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((scope, index) => scope === sortedB[index]);
}

function scopeChange(
  dimension: "readPaths" | "writePaths",
  before: readonly string[],
  after: readonly string[],
): RunEnvelopeChange | null {
  if (sameScopeSet(before, after)) {
    return null;
  }
  const narrowed = after.every((scope) => isPatternCoveredByScopes(before, scope));
  const label = dimension === "readPaths" ? "可读路径" : "可写路径";
  return {
    dimension,
    direction: narrowed ? "narrowed" : "widened",
    before: Object.freeze([...before]),
    after: Object.freeze([...after]),
    detail: `${label}由 ${renderScopeList(before)} ${narrowed ? "收窄" : "放宽"}为 ${renderScopeList(after)}`,
  };
}

function grantedCommandsOf(envelope: PermissionEnvelope): readonly string[] {
  const candidate = (envelope as Partial<RunEnvelope>).grantedCommands;
  return Array.isArray(candidate) ? candidate : [];
}

/** 两个信封的逐维差异（before → after）。 */
function diffEnvelopes(
  before: PermissionEnvelope,
  after: PermissionEnvelope,
): readonly RunEnvelopeChange[] {
  const changes: RunEnvelopeChange[] = [];
  const readChange = scopeChange("readPaths", before.readPaths, after.readPaths);
  if (readChange !== null) {
    changes.push(readChange);
  }
  const writeChange = scopeChange("writePaths", before.writePaths, after.writePaths);
  if (writeChange !== null) {
    changes.push(writeChange);
  }
  if (before.shell !== after.shell) {
    const narrowed = SHELL_RANK[after.shell] < SHELL_RANK[before.shell];
    changes.push({
      dimension: "shell",
      direction: narrowed ? "narrowed" : "widened",
      before: before.shell,
      after: after.shell,
      detail: `shell 策略由 ${before.shell} ${narrowed ? "收窄" : "放宽"}为 ${after.shell}`,
    });
  }
  if (before.network !== after.network) {
    changes.push({
      dimension: "network",
      direction: after.network ? "widened" : "narrowed",
      before: before.network,
      after: after.network,
      detail: after.network ? "网络由禁止放宽为允许" : "网络由允许收窄为禁止",
    });
  }
  const beforeCommands = grantedCommandsOf(before);
  const afterCommands = grantedCommandsOf(after);
  if (!sameScopeSet(beforeCommands, afterCommands)) {
    const added = afterCommands.filter((command) => !beforeCommands.includes(command));
    changes.push({
      dimension: "grantedCommands",
      direction: added.length > 0 ? "widened" : "narrowed",
      before: Object.freeze([...beforeCommands]),
      after: Object.freeze([...afterCommands]),
      detail: `本 Run 命令白名单新增 ${renderScopeList(added)}`,
    });
  }
  return Object.freeze(changes);
}

/** 参与相交的一级（envelope 缺席即该级不参与）。 */
interface StageCandidate {
  readonly stage: Exclude<RunEnvelopeStage, "user_grant">;
  readonly envelope: PermissionEnvelope | undefined;
  readonly skippedReason: string;
}

function stageCandidates(
  input: RunEnvelopeAssemblyInput,
  taskEnvelope: PermissionEnvelope,
): readonly StageCandidate[] {
  return [
    {
      stage: "project_policy",
      envelope: input.projectPolicy?.[input.role],
      skippedReason: `项目未为角色 ${input.role} 配置权限策略（§10.2），本级不收窄`,
    },
    {
      stage: "role_default",
      envelope: ROLE_DEFAULT_ENVELOPES[input.role],
      skippedReason: "",
    },
    {
      stage: "profile_preset",
      envelope: input.profilePreset,
      skippedReason: "Agent Profile 未提供权限预设，本级不收窄",
    },
    {
      stage: "task_contract",
      envelope: taskEnvelope,
      skippedReason: "",
    },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 装配一次 Run 的最终权限信封（公式与派生规则见文件头）。
 *
 * 纯函数、零 IO，不改动任何入参；对无效批准（危险操作豁免、项目外路径）不抛错，
 * 而是逐条记入审计并跳过——装配发生在 Run 启动路径上，一条脏批准不该让整个 Run
 * 起不来，但必须在审计里留痕。
 */
export function assembleRunEnvelope(input: RunEnvelopeAssemblyInput): AssembledRunEnvelope {
  const taskEnvelope = deriveTaskEnvelope(input.taskContract, input.taskNetwork);
  const steps: RunEnvelopeAuditStep[] = [];
  let accumulated = intersectEnvelopes(UNCONSTRAINED_PROJECT_ENVELOPE);

  for (const candidate of stageCandidates(input, taskEnvelope)) {
    if (candidate.envelope === undefined) {
      steps.push({
        stage: candidate.stage,
        applied: false,
        skippedReason: candidate.skippedReason,
        result: accumulated,
        changes: [],
      });
      continue;
    }
    const before = accumulated;
    accumulated = intersectEnvelopes(before, candidate.envelope);
    steps.push({
      stage: candidate.stage,
      applied: true,
      input: candidate.envelope,
      result: accumulated,
      changes: diffEnvelopes(before, accumulated),
    });
  }

  let runEnvelope = toRunEnvelope(accumulated);
  for (const grant of input.grants ?? []) {
    const before = runEnvelope;
    try {
      runEnvelope = applyRunGrant(before, grant);
    } catch (error) {
      steps.push({
        stage: "user_grant",
        applied: false,
        skippedReason: errorMessage(error),
        grant,
        result: before,
        changes: [],
      });
      continue;
    }
    steps.push({
      stage: "user_grant",
      applied: true,
      grant,
      result: runEnvelope,
      changes: diffEnvelopes(before, runEnvelope),
    });
  }

  const verifyCommands =
    input.taskContract.verifyCmd === undefined ? [] : [input.taskContract.verifyCmd];
  return Object.freeze({
    envelope: runEnvelope,
    forbiddenPaths: deriveForbiddenPathPatterns(input.taskContract.forbidden),
    verifyCommands: Object.freeze(verifyCommands),
    audit: Object.freeze({
      role: input.role,
      taskId: input.taskContract.id,
      base: UNCONSTRAINED_PROJECT_ENVELOPE,
      taskEnvelope,
      steps: Object.freeze(steps),
      final: runEnvelope,
      widenedByGrants: steps.some(
        (step) =>
          step.stage === "user_grant" &&
          step.changes.some((change) => change.direction === "widened"),
      ),
    }),
  });
}
