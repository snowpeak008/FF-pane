/**
 * 权限设计（设计文档 §7）：5 项权限信封 + 危险操作固定清单 + 权限扩展请求。
 * 信封交集计算（角色默认 ∩ 任务指定 ∩ 用户批准）属 W1.4c，不在本文件。
 */

import type { EpochMillis, PermissionRequestId, RunId, TaskId } from "./common.js";
import { createLiteralGuard } from "./common.js";

/**
 * 设计文档 §7 —— Shell 命令策略（信封第 3 项）：
 * forbidden = 禁止（Planner 默认）；
 * allowed = 允许，危险操作除外——危险操作由信封第 5 项单独把守（Worker 默认）；
 * verify_only = 仅允许任务合同的验证命令（Reviewer 默认）。
 */
export const SHELL_POLICIES = ["forbidden", "allowed", "verify_only"] as const;

/** 设计文档 §7 —— Shell 命令策略。 */
export type ShellPolicy = (typeof SHELL_POLICIES)[number];

/** ShellPolicy 运行时守卫。 */
export const isShellPolicy = createLiteralGuard(SHELL_POLICIES);

/**
 * 设计文档 §7 —— 危险操作固定清单（6 项）。
 * 固定事实：不可配置、不可被 Agent 申请豁免，全部需用户逐次确认。
 * 各项与设计文档原文的对应：
 * - delete_outside_write_scope：删除文件超出 write_scope
 * - git_push：git push
 * - modify_git_dir：修改 .git 目录
 * - read_credential_paths：读取密钥/凭证类路径（~/.ssh、.env 等，内置黑名单）
 * - install_system_software：安装系统级软件
 * - publish_or_deploy：任何形式的发布与部署
 */
export const DANGEROUS_OPERATIONS = [
  "delete_outside_write_scope",
  "git_push",
  "modify_git_dir",
  "read_credential_paths",
  "install_system_software",
  "publish_or_deploy",
] as const;

/** 设计文档 §7 —— 危险操作类别。 */
export type DangerousOperation = (typeof DANGEROUS_OPERATIONS)[number];

/** DangerousOperation 运行时守卫。 */
export const isDangerousOperation = createLiteralGuard(DANGEROUS_OPERATIONS);

/**
 * 设计文档 §7 —— 权限信封（5 项）。每次 Run 的最终信封由
 * "角色默认 ∩ 任务指定 ∩ 用户批准" 交集得出（计算属 W1.4c）。
 * 路径均为相对项目根目录的路径模式（glob），空数组 = 无该项权限。
 */
export interface PermissionEnvelope {
  /** 设计文档 §7 第 1 项 —— 可读路径（各角色默认"项目内"）。 */
  readonly readPaths: readonly string[];
  /** 设计文档 §7 第 2 项 —— 可写路径（Worker 默认为任务合同的 write_scope）。 */
  readonly writePaths: readonly string[];
  /** 设计文档 §7 第 3 项 —— Shell 命令策略。 */
  readonly shell: ShellPolicy;
  /** 设计文档 §7 第 4 项 —— 网络（Planner 默认允许；Worker 默认禁止，任务可开）。 */
  readonly network: boolean;
  /**
   * 设计文档 §7 第 5 项 —— 危险操作确认。
   * 类型固定为 true：危险操作永远需用户逐次确认，任何信封都不能关闭此项。
   */
  readonly dangerousOpsRequireApproval: true;
}

/** 设计文档 §7 —— 权限扩展请求的请求内容类别（与信封 5 项一一对应）。 */
export const PERMISSION_REQUEST_KINDS = [
  "read_path",
  "write_path",
  "shell_command",
  "network",
  "dangerous_operation",
] as const;

/** 设计文档 §7 —— 权限扩展请求类别。 */
export type PermissionRequestKind = (typeof PERMISSION_REQUEST_KINDS)[number];

/** PermissionRequestKind 运行时守卫。 */
export const isPermissionRequestKind = createLiteralGuard(PERMISSION_REQUEST_KINDS);

/** 设计文档 §7 —— 权限扩展请求的具体内容（按信封条目区分）。 */
export type PermissionRequestPayload =
  | { readonly kind: "read_path"; readonly path: string }
  | { readonly kind: "write_path"; readonly path: string }
  | { readonly kind: "shell_command"; readonly command: string }
  | { readonly kind: "network"; readonly target?: string }
  | {
      readonly kind: "dangerous_operation";
      readonly operation: DangerousOperation;
      /** 具体操作描述（如完整命令或目标路径），供用户审批时判断。 */
      readonly detail: string;
    };

/**
 * 设计文档 §7 —— Agent 在 Run 中发起的权限扩展请求。
 * 流程：请求发起 → 任务转 blocked（§6.3）→ 用户一键批准/拒绝；
 * 批准仅对当前 Run 有效，不产生永久授权。
 */
export interface PermissionRequest {
  /** 请求唯一 ID（审批回执据此关联）。 */
  readonly id: PermissionRequestId;
  /** 设计文档 §7 —— 发起请求的 Run。 */
  readonly runId: RunId;
  /** 设计文档 §6.3 —— 受阻塞的任务。 */
  readonly taskId: TaskId;
  /** 请求内容。 */
  readonly payload: PermissionRequestPayload;
  /** Agent 给出的请求理由（原文透传，可空）。 */
  readonly reason?: string;
  /** 请求发起时间（epoch 毫秒）。 */
  readonly requestedAt: EpochMillis;
}
