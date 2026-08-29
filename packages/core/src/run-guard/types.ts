/**
 * Run 权限执行层的公共类型（W2.7a）。
 *
 * 本层的定位：W1.4c 的权限数学（信封交集、路径归一、命令分类）本身不知道
 * "一次 Run 正在发生什么"；本层把那些原语接到具体的写文件 / 执行命令动作上，
 * 给出可执行的裁决三态。T2.0 已证明三家 CLI 会把"权限被拒"伪装成成功，
 * 因此 FF-pane 不信任 Runtime 自带的沙箱与审批——本层是唯一的权限事实源。
 *
 * 依赖方向：core 不依赖 adapters。事件（FileChangeEvent / CommandEvent）到本层
 * 入参的桥接属 W2.7b，因此这里的入参是结构化子集类型，与适配器事件形状同构
 * 但互不依赖（changeKind 的字面量与 adapters 的 FILE_CHANGE_KINDS 保持同名同义）。
 */

import type {
  DangerousOperation,
  PermissionEnvelope,
  PermissionRequestPayload,
} from "@ff-pane/shared";
import { createLiteralGuard } from "@ff-pane/shared";
import type { CommandClassification, DangerousCommandRule } from "../permission/index.js";

/** 文件变更类型（与 adapters 的 FILE_CHANGE_KINDS 同名同义，见文件头依赖方向说明）。 */
export const RUN_FILE_CHANGE_KINDS = ["add", "update", "delete"] as const;

/** 文件变更类型。 */
export type RunFileChangeKind = (typeof RUN_FILE_CHANGE_KINDS)[number];

/** RunFileChangeKind 运行时守卫（IPC / JSON 边界复核用）。 */
export const isRunFileChangeKind = createLiteralGuard(RUN_FILE_CHANGE_KINDS);

/**
 * 裁决三态（事前拦截）：
 * - allowed         信封放行，直接执行；
 * - violation       恒拒，没有审批通道（项目外路径、任务合同禁止项、shell 策略闸门）；
 * - needs_approval  需用户逐次批准（§7 权限扩展请求 / 危险操作确认），
 *                   裁决同时给出可直接送审的 PermissionRequestPayload。
 *
 * 事后审计（auditRunEvidence）把 needs_approval 也计为违规——事后意味着操作
 * 已经发生，没有"待批准"这一态：要么当时批过（已落入信封 / 危险操作放行记录），
 * 要么就是越界。
 */
export const RUN_GUARD_DECISIONS = ["allowed", "violation", "needs_approval"] as const;

/** 裁决三态。 */
export type RunGuardDecision = (typeof RUN_GUARD_DECISIONS)[number];

/** RunGuardDecision 运行时守卫。 */
export const isRunGuardDecision = createLiteralGuard(RUN_GUARD_DECISIONS);

/**
 * 违规代码（审计清单与 UI 文案的稳定键）：
 * - path_outside_project            路径在项目根之外（恒拒，§7 信封只表达项目内）；
 * - forbidden_path                  命中任务合同 forbidden 派生的禁写模式（恒拒）；
 * - write_outside_envelope          写入超出信封 writePaths（可申请 write_path 扩展）；
 * - dangerous_operation_unapproved  危险操作未获逐次确认（§7 固定清单）；
 * - command_denied                  命令被 shell 策略闸门拒绝（可申请 shell_command 扩展）。
 */
export const RUN_GUARD_VIOLATION_CODES = [
  "path_outside_project",
  "forbidden_path",
  "write_outside_envelope",
  "dangerous_operation_unapproved",
  "command_denied",
] as const;

/** 违规代码。 */
export type RunGuardViolationCode = (typeof RUN_GUARD_VIOLATION_CODES)[number];

/** RunGuardViolationCode 运行时守卫。 */
export const isRunGuardViolationCode = createLiteralGuard(RUN_GUARD_VIOLATION_CODES);

/** 被裁决的对象（判别联合：写文件 / 执行命令）。 */
export type RunGuardTarget =
  | {
      readonly kind: "file_change";
      /** 原始路径（Runtime 给出的形态，仅供展示）。 */
      readonly path: string;
      readonly changeKind: RunFileChangeKind;
      /** 项目内比较键（解析失败即项目外，此时缺席）。 */
      readonly projectPath?: string;
    }
  | {
      readonly kind: "command";
      /** 命令原文。 */
      readonly command: string;
    };

/** 一条违规记录（事前拦截与事后审计共用）。 */
export interface RunGuardViolation {
  readonly code: RunGuardViolationCode;
  readonly target: RunGuardTarget;
  /** 人类可读的拒绝依据（进 Run 日志与 Reviewer 报告）。 */
  readonly reason: string;
  /** 命中的危险操作类别（§7 固定清单；未命中为空数组）。 */
  readonly dangerousOperations: readonly DangerousOperation[];
}

/**
 * 裁决上下文：信封之外的裁决输入。assembleRunEnvelope 产出其中的
 * forbiddenPaths / verifyCommands，cwd 由编排层（Run 的工作目录）补上。
 */
export interface RunGuardContext {
  /**
   * Run 的工作目录，约定即项目根（§10.2：项目根是 `.workbench/` 的宿主目录）。
   * 绝对路径以此折算为项目内相对路径；缺省时一切绝对路径判为项目外——
   * 四家 Runtime 的事件多给绝对路径，桥接层（W2.7b）务必传入。
   */
  readonly cwd?: string;
  /** 任务合同 forbidden 派生出的禁写模式（deriveForbiddenPathPatterns 产物）。 */
  readonly forbiddenPaths?: readonly string[];
  /** shell = verify_only 时放行的验证命令（任务合同 verify_cmd）。 */
  readonly verifyCommands?: readonly string[];
  /** 追加的危险命令规则（§7 内置固定清单不可移除，只增不减）。 */
  readonly extraDangerousRules?: readonly DangerousCommandRule[];
}

/** judgeFileChange 入参。envelope 传 RunEnvelope 或基础信封均可。 */
export interface FileChangeJudgeInput extends RunGuardContext {
  readonly envelope: PermissionEnvelope;
  /** 被写入的路径（原样透传 Runtime 给出的形态，可为绝对路径）。 */
  readonly path: string;
  readonly changeKind: RunFileChangeKind;
}

/** 写路径裁决结果。 */
export type FileChangeJudgement =
  | {
      readonly decision: "allowed";
      /** 项目内比较键。 */
      readonly projectPath: string;
      readonly reason: string;
    }
  | {
      readonly decision: "violation";
      readonly violation: RunGuardViolation;
    }
  | {
      readonly decision: "needs_approval";
      readonly projectPath: string;
      /** 可直接送审的权限扩展请求内容（§7）。 */
      readonly request: PermissionRequestPayload;
      readonly reason: string;
      readonly dangerousOperations: readonly DangerousOperation[];
    };

/** judgeCommand 入参。 */
export interface CommandJudgeInput extends RunGuardContext {
  readonly envelope: PermissionEnvelope;
  /** 命令原文。 */
  readonly command: string;
  /** 任务合同的 verify_cmd（与 verifyCommands 合并后作为 verify_only 白名单）。 */
  readonly verifyCmd?: string;
}

/** 命令裁决结果。violation 对应 classifyCommand 的 denied。 */
export type CommandJudgement =
  | {
      readonly decision: "allowed";
      readonly classification: CommandClassification;
      readonly reason: string;
    }
  | {
      readonly decision: "violation";
      readonly violation: RunGuardViolation;
      readonly classification: CommandClassification;
      /**
       * shell 策略闸门可由用户逐条批准打开，故拒绝仍附带送审内容；
       * 是否放行由用户决定，本层不预设。
       */
      readonly request: PermissionRequestPayload;
    }
  | {
      readonly decision: "needs_approval";
      readonly classification: CommandClassification;
      readonly request: PermissionRequestPayload;
      readonly reason: string;
    };
