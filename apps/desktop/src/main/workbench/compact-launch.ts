/**
 * 管理者窗口的压缩（T10.20）。
 * 只描述这一次进程要带的环境变量或 Codex `-c`。不写任何配置文件。
 */

import {
  GROK_COMPACT_PERCENT_CAP,
  parseManagerCompactPercent,
  resolveContextWindow,
  type WorkbenchRole,
} from "@ff-pane/shared";

/** Claude / DeepSeek：上下文窗口的 token 整数。必须和百分比一起设。 */
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** Claude / DeepSeek：到达这个百分比就压。只设它、不设窗口，往往不生效。 */
export const CLAUDE_AUTOCOMPACT_PCT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";

/** Grok：只给这个进程的百分比。 */
export const GROK_AUTO_COMPACT_PERCENT_ENV = "GROK_AUTO_COMPACT_THRESHOLD_PERCENT";

/** Codex：`-c` 的键。值是 token 整数，不改 config.toml。 */
export const CODEX_AUTO_COMPACT_TOKEN_KEY = "model_auto_compact_token_limit";

export interface ManagerCompactLaunch {
  /** 只在需要时有条目。值都是十进制整数，不带 k 这类单位。 */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Codex `-c model_auto_compact_token_limit=` 后面的原文。
   * 十进制整数，不加引号。
   */
  readonly codexTokenLimit?: string;
}

const EMPTY: ManagerCompactLaunch = { env: {} };

/**
 * 按窗口角色和种类决定这一次进程怎么压。
 * 不是管理者、没指定比例、或比例不在 50–90：什么都不传。
 */
export function resolveManagerCompact(input: {
  readonly role: WorkbenchRole;
  readonly kind: "claude" | "codex" | "grok" | "deepseek";
  readonly percent: unknown;
  readonly model?: string;
}): ManagerCompactLaunch {
  if (input.role !== "manager") {
    return EMPTY;
  }
  const percent = parseManagerCompactPercent(input.percent);
  if (percent === undefined) {
    return EMPTY;
  }
  if (input.kind === "claude" || input.kind === "deepseek") {
    const tokens = contextTokens(input.kind, input.model);
    return {
      env: {
        [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: String(tokens),
        [CLAUDE_AUTOCOMPACT_PCT_ENV]: String(percent),
      },
    };
  }
  if (input.kind === "grok") {
    const grokPercent = Math.min(percent, GROK_COMPACT_PERCENT_CAP);
    return { env: { [GROK_AUTO_COMPACT_PERCENT_ENV]: String(grokPercent) } };
  }
  const tokens = contextTokens("codex", input.model);
  const limit = Math.floor((tokens * percent) / 100);
  return { env: {}, codexTokenLimit: String(limit) };
}

/**
 * 百分比要乘在已知的上下文窗口上。
 * DeepSeek 不借用 Claude 的 200K 默认，认不出模型时用保守的 128K，避免压得更晚。
 */
function contextTokens(kind: "claude" | "codex" | "deepseek", model: string | undefined): number {
  if (kind === "deepseek") {
    return resolveContextWindow(model).tokens;
  }
  const runtime = kind === "codex" ? "codex" : "claude-code";
  return resolveContextWindow(model, runtime).tokens;
}
