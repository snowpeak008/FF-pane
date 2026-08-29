/**
 * Gemini CLI 启动参数构建（W2.5，纯函数）。
 *
 * 参数以 docs/adapters/gemini-cli.md §2/§8.2 为准，并经本机 0.57.0 的 yargs 选项定义复核
 * （choices、互斥关系、数组选项的逗号分隔行为均取自安装包源码）。
 *
 * 固定携带的三个开关，每个都对应一个已实证的坑：
 * - `-o stream-json`：唯一能拿到过程事件的输出格式（`-o json` 只有最终文本，
 *   丢失文件修改与命令执行事件，调研 §8.4 坑 4）；
 * - `--skip-trust`：新目录下不带此开关直接退出码 55、stdout 无输出（真机验证，坑 3）；
 * - `--approval-mode`：**必须显式传**。headless 下 default 会把一切写操作静默拒掉，
 *   而进程仍以 0 退出、result 仍是 success（坑 1）。
 */

import type { AgentStdinMode } from "../process/index.js";

/** 默认可执行文件名（Windows 下由 W2.1a 的 PATH × PATHEXT 解析命中 gemini.cmd）。 */
export const GEMINI_DEFAULT_COMMAND = "gemini";

/** `--approval-mode` 的合法取值（0.57.0 yargs choices）。 */
export const GEMINI_APPROVAL_MODES = ["default", "auto_edit", "yolo", "plan"] as const;

/** 审批模式。 */
export type GeminiApprovalMode = (typeof GEMINI_APPROVAL_MODES)[number];

/**
 * 提示词走命令行参数的长度上限（超过则改走 stdin 管道）。
 *
 * 依据：Windows 命令行整体约 32k 字符（调研 §2 对 `-p` 的备注），且我们的参数还要
 * 经 cmd.exe 垫片再传一层。24k 是留足余量的保守值；超限时 CLI 侧的表现是"参数被截断"
 * 或直接启动失败，属于必须避免的静默事故。
 */
export const GEMINI_PROMPT_ARG_MAX_CHARS = 24_000;

/** 参数构建输入。 */
export interface GeminiCommandInput {
  readonly prompt: string;
  readonly approvalMode: GeminiApprovalMode;
  /** 新会话预生成的 UUID（`--session-id`）。与 resumeSessionId 互斥。 */
  readonly sessionId?: string;
  /** 恢复目标会话 ID（`--resume`）。与 sessionId 互斥（CLI 侧强制互斥）。 */
  readonly resumeSessionId?: string;
  readonly model?: string;
  /** 每 Run 策略文件路径（`--policy`）。 */
  readonly policyFile?: string;
  /** 额外可读目录（`--include-directories`）。 */
  readonly includeDirectories?: readonly string[];
  /** 逃生舱：直接追加的原始参数（Profile 高级设置）。 */
  readonly extraArgs?: readonly string[];
  /** 覆盖提示词走参数的长度上限（测试用）。 */
  readonly promptArgMaxChars?: number;
}

/** 启动方案：参数 + stdin 形态。 */
export interface GeminiCommandPlan {
  readonly args: readonly string[];
  readonly stdin: AgentStdinMode;
  /**
   * 需要写入 stdin 的提示词（仅长提示词场景）。
   * 依据调研 §2：stdin 为非 TTY 管道同样触发 headless；stdin 内容在前、`-p` 文本在后拼接，
   * 故长提示词单独走 stdin 时**不再传 `-p`**，避免同一段任务文本出现两次。
   */
  readonly stdinPayload?: string;
}

/** 参数装配非法（属装配错误，由适配器转为 end(failed)）。 */
export class GeminiCommandError extends Error {
  override readonly name = "GeminiCommandError";
}

/** 构建启动参数。 */
export function buildGeminiCommand(input: GeminiCommandInput): GeminiCommandPlan {
  if (input.sessionId !== undefined && input.resumeSessionId !== undefined) {
    throw new GeminiCommandError(
      "--session-id 与 --resume 互斥（0.57.0 CLI 侧强制）：新会话给 sessionId，恢复给 resumeSessionId",
    );
  }
  if (input.policyFile !== undefined) {
    if (!input.policyFile.endsWith(".toml")) {
      throw new GeminiCommandError(`--policy 只接受 .toml 文件：${input.policyFile}`);
    }
    if (input.policyFile.includes(",")) {
      throw new GeminiCommandError(
        `--policy 路径不得含逗号（逗号是该选项的分隔符）：${input.policyFile}`,
      );
    }
  }

  const args: string[] = [
    "-o",
    "stream-json",
    "--skip-trust",
    "--approval-mode",
    input.approvalMode,
  ];

  if (input.resumeSessionId !== undefined) {
    args.push("--resume", input.resumeSessionId);
  } else if (input.sessionId !== undefined) {
    args.push("--session-id", input.sessionId);
  }
  if (input.model !== undefined) {
    args.push("-m", input.model);
  }
  if (input.policyFile !== undefined) {
    args.push("--policy", input.policyFile);
  }
  if (input.includeDirectories !== undefined && input.includeDirectories.length > 0) {
    // 该选项本身支持逗号分隔，逐个传更稳（目录名可能含逗号）。
    for (const directory of input.includeDirectories) {
      args.push("--include-directories", directory);
    }
  }
  if (input.extraArgs !== undefined) {
    args.push(...input.extraArgs);
  }

  const maxChars = input.promptArgMaxChars ?? GEMINI_PROMPT_ARG_MAX_CHARS;
  if (input.prompt.length > maxChars) {
    return { args, stdin: "pipe", stdinPayload: input.prompt };
  }
  // -p 放最后：排障时把命令贴进终端，任务文本在末尾最好读。
  args.push("-p", input.prompt);
  return { args, stdin: "closed" };
}
