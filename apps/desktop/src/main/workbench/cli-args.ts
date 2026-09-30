/**
 * 交互式 Claude Code / Codex 启动参数组装（T10.4）。
 * 纯函数：不含密钥；MCP 路径与 configOverrides 由调用方注入。
 * 与 headless 适配器（-p / exec --json）分离——工作台窗口跑交互 TUI。
 */

/** Claude Code 默认可执行文件名。 */
export const CLAUDE_INTERACTIVE_COMMAND = "claude";

/** Codex 默认可执行文件名。 */
export const CODEX_INTERACTIVE_COMMAND = "codex";

/** 交互式 Claude 启动参数。 */
export interface BuildInteractiveClaudeArgsInput {
  readonly model?: string;
  readonly effort?: string;
  /** 新开会话预分配 UUID（`--session-id`）。与 resumeSessionId 互斥。 */
  readonly sessionId?: string;
  /** 续接 UUID（`--resume`）。 */
  readonly resumeSessionId?: string;
  readonly mcpConfigPath?: string;
  /**
   * 是否加 `--strict-mcp-config`。
   * 有 MCP 注入时默认 true（沿用 headless 适配器：避免用户全局 MCP 混入受管窗口）。
   */
  readonly strictMcp?: boolean;
  readonly initialPrompt?: string;
}

/** 交互式 Codex 启动参数。 */
export interface BuildInteractiveCodexArgsInput {
  readonly cwd: string;
  readonly model?: string;
  /** 已 JSON.stringify 的 configOverrides（含 effort、model_providers、mcp_servers）。 */
  readonly configOverrides?: Readonly<Record<string, string>>;
  /** 精确续接会话 id；缺省且 resume=true 时打开 resume 选择器（不加 --last）。 */
  readonly resumeSessionId?: string;
  /** 是否续接（true 且无 id → `codex resume` 选择器）。 */
  readonly resume?: boolean;
  readonly initialPrompt?: string;
}

/**
 * 组装交互式 `claude` argv（不含可执行文件名）。
 * 不加 `-p` / stream-json——进入 REPL。
 */
export function buildInteractiveClaudeArgs(input: BuildInteractiveClaudeArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "") {
    args.push("--resume", input.resumeSessionId.trim());
  } else if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    args.push("--session-id", input.sessionId.trim());
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("--model", input.model.trim());
  }
  if (input.effort !== undefined && input.effort.trim() !== "") {
    args.push("--effort", input.effort.trim());
  }
  if (input.mcpConfigPath !== undefined && input.mcpConfigPath.trim() !== "") {
    args.push("--mcp-config", input.mcpConfigPath.trim());
    if (input.strictMcp !== false) {
      args.push("--strict-mcp-config");
    }
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(input.initialPrompt);
  }
  return args;
}

/**
 * 组装交互式 `codex` / `codex resume` argv（不含可执行文件名）。
 * 默认进 TUI；续接走 `resume` 子命令。
 */
export function buildInteractiveCodexArgs(input: BuildInteractiveCodexArgsInput): string[] {
  const args: string[] = [];
  const resuming = input.resume === true;
  if (resuming) {
    args.push("resume");
    if (input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "") {
      args.push(input.resumeSessionId.trim());
    }
    // 无 id：不加 --last，进入官方选择器，避免同 cwd 多窗口接错
  }
  args.push("-C", input.cwd);
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("-m", input.model.trim());
  }
  for (const [key, value] of Object.entries(input.configOverrides ?? {})) {
    args.push("-c", `${key}=${value}`);
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(input.initialPrompt);
  }
  return args;
}

/** 断言密钥明文不出现在 argv / 临时文件内容中（单测与启动后自检）。 */
export function assertSecretAbsent(secret: string | undefined, surfaces: readonly string[]): void {
  if (secret === undefined || secret.length === 0) {
    return;
  }
  for (const surface of surfaces) {
    if (surface.includes(secret)) {
      throw new Error("密钥出现在命令行参数或临时文件中（违反 T10.4 红线）");
    }
  }
}
