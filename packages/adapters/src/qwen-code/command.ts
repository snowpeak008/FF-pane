/**
 * Qwen Code 启动参数构建（T8.6a，纯函数）。
 *
 * 参数以 docs/adapters/qwen-code.md §2/§9.2 为准，并经本机 0.23.0 真机复核。
 *
 * 固定携带的开关，每个对应一个已实证的坑或纪律：
 * - `-o stream-json --include-partial-messages`：token 级增量的唯一来源
 *   （不开则 assistant 文本整块到达，调研 §3.2）；
 * - `--approval-mode`：**必须显式传**。headless 下 default 把写与命令工具直接
 *   摘出注册表、进程仍退 0、result 仍 success（调研 §8 坑 4）；
 * - `--safe-mode`：受管执行不被用户仓库的 hooks/extensions/skills 注入行为
 *   （官方文档明示 --approval-mode 不受其影响）；
 * - `--auth-type openai`：headless 下 auth type 必须显式（缺席直接
 *   error_during_execution 退出 1，真机实测）；凭据经 OPENAI_API_KEY /
 *   OPENAI_BASE_URL 环境变量注入（--openai-api-key 参数会把密钥放进命令行，违反
 *   §4.3 红线，不用）。
 *
 * **提示词恒走 stdin 管道**：qwen 落地为 npm .cmd 垫片，positional 多行参数会被
 * cmd.exe 在第一个换行截断（codex 同款坑，调研 §8 坑 5）；`-p` 已弃用。
 * stdin 非 TTY 管道即触发 headless（真机实测）。
 */

import type { ModelId, NativeSessionBinding, RuntimeId } from "@ff-pane/shared";

/** Runtime 注册键（native.ts 定义，此处复出口便于单独引用）。 */
export const QWEN_CODE_RUNTIME_KEY: RuntimeId = "qwen-code";

/** 默认可执行文件名（npm 全局安装落地为 qwen.cmd 垫片，由 process 层处理）。 */
export const DEFAULT_QWEN_COMMAND = "qwen";

/** `--approval-mode` 的合法取值（0.23.0 yargs choices；注意 auto-edit 是连字符）。 */
export const QWEN_APPROVAL_MODES = ["plan", "default", "auto-edit", "auto", "yolo"] as const;

/** 审批模式。 */
export type QwenApprovalMode = (typeof QWEN_APPROVAL_MODES)[number];

/** `--auth-type` 的合法取值（qwen-oauth 已废止仅存枚举，调研 §6）。 */
export const QWEN_AUTH_TYPES = ["openai", "anthropic", "gemini", "vertex-ai"] as const;

/** 认证协议。 */
export type QwenAuthType = (typeof QWEN_AUTH_TYPES)[number];

/** 参数构建输入。 */
export interface QwenCommandInput {
  readonly approvalMode: QwenApprovalMode;
  /** 认证协议，默认 "openai"（调研 §6 推荐主路径）。 */
  readonly authType?: QwenAuthType;
  /** 新会话预生成的 UUID（`--session-id`）。与 resumeSessionId 互斥。 */
  readonly sessionId?: string;
  /** 恢复目标会话 ID（`--resume`）。与 sessionId 互斥（CLI 侧强制，退出 1）。 */
  readonly resumeSessionId?: string;
  readonly model?: ModelId;
  /** 额外可读目录（`--include-directories`）。 */
  readonly includeDirectories?: readonly string[];
  /** 轮数上限（`--max-session-turns`，超限退出 53）。 */
  readonly maxSessionTurns?: number;
  /** 关闭 --safe-mode（默认开启；用户明确要 hooks/extensions 时的逃生门）。 */
  readonly safeMode?: boolean;
  /** 逃生舱：直接追加的原始参数（Profile 高级设置）。 */
  readonly extraArgs?: readonly string[];
}

/** 参数装配非法（属装配错误，由适配器转为 end(failed)）。 */
export class QwenCommandError extends Error {
  override readonly name = "QwenCommandError";
}

/** 会话绑定裁决输入 → `--session-id` / `--resume` 二选一。 */
export interface QwenSessionPlan {
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
}

/**
 * 会话绑定裁决。cwd 不一致的绑定是非法输入（会话按 cwd 目录桶隔离，跨目录 resume
 * 报 "No saved session found" 退出 1，调研 §4 真机实测）——启动前快速失败，
 * 而不是让 CLI 报出难懂的错误。
 */
export function planQwenSession(input: {
  readonly cwd: string;
  readonly resume?: NativeSessionBinding | undefined;
  readonly newSessionId: () => string;
  readonly isSameCwd: (left: string, right: string) => boolean;
}): QwenSessionPlan {
  if (input.resume === undefined) {
    return { sessionId: input.newSessionId() };
  }
  if (!input.isSameCwd(input.resume.cwd, input.cwd)) {
    throw new QwenCommandError(
      `原生会话恢复失败：会话 ${input.resume.nativeSessionId} 绑定的工作目录是 ${input.resume.cwd}，` +
        `与本轮 cwd ${input.cwd} 不一致。Qwen Code 的会话按工作目录隔离，跨目录无法恢复；` +
        "请以原目录重跑，或降级为上下文重建（设计文档 §10.3）。",
    );
  }
  return { resumeSessionId: input.resume.nativeSessionId };
}

/** 构建启动参数（提示词不在此处——恒走 stdin，由适配器写入）。 */
export function buildQwenCommand(input: QwenCommandInput): readonly string[] {
  if (input.sessionId !== undefined && input.resumeSessionId !== undefined) {
    throw new QwenCommandError(
      "--session-id 与 --resume 互斥（0.23.0 CLI 侧强制）：新会话给 sessionId，恢复给 resumeSessionId",
    );
  }
  if (
    input.maxSessionTurns !== undefined &&
    (!Number.isInteger(input.maxSessionTurns) || input.maxSessionTurns <= 0)
  ) {
    throw new QwenCommandError(`--max-session-turns 必须是正整数，收到 ${input.maxSessionTurns}`);
  }

  const args: string[] = [
    "-o",
    "stream-json",
    "--include-partial-messages",
    "--approval-mode",
    input.approvalMode,
    "--auth-type",
    input.authType ?? "openai",
  ];
  if (input.safeMode !== false) {
    args.push("--safe-mode");
  }
  if (input.resumeSessionId !== undefined) {
    args.push("--resume", input.resumeSessionId);
  } else if (input.sessionId !== undefined) {
    args.push("--session-id", input.sessionId);
  }
  if (input.model !== undefined) {
    args.push("-m", input.model);
  }
  if (input.maxSessionTurns !== undefined) {
    args.push("--max-session-turns", String(input.maxSessionTurns));
  }
  if (input.includeDirectories !== undefined) {
    // 该选项支持逗号分隔，逐个传更稳（目录名可能含逗号）。
    for (const directory of input.includeDirectories) {
      args.push("--include-directories", directory);
    }
  }
  if (input.extraArgs !== undefined) {
    args.push(...input.extraArgs);
  }
  return args;
}
