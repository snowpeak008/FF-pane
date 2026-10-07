/**
 * 交互式 Claude Code / Codex 启动参数组装（T10.4 / T10.5）。
 * 纯函数：不含密钥与窗口令牌；MCP 路径与 configOverrides 由调用方注入。
 * 与 headless 适配器（-p / exec --json）分离——工作台窗口跑交互 TUI。
 */

import { resolvePermissionCliArgs } from "@ff-pane/core";
import type { WorkbenchPermissionLevel } from "@ff-pane/shared";

/** Claude Code 默认可执行文件名。 */
export const CLAUDE_INTERACTIVE_COMMAND = "claude";

/** Codex 默认可执行文件名。 */
export const CODEX_INTERACTIVE_COMMAND = "codex";

/** Grok 默认可执行文件名。 */
export const GROK_INTERACTIVE_COMMAND = "grok";

/** 交互式 Claude 启动参数。 */
export interface BuildInteractiveClaudeArgsInput {
  readonly model?: string;
  readonly effort?: string;
  /** 新开会话预分配 UUID（`--session-id`）。与 resumeSessionId 互斥。 */
  readonly sessionId?: string;
  /** 续接 UUID（`--resume <id>`）。 */
  readonly resumeSessionId?: string;
  /** 没有编号时只传 `--resume`，打开选择器，不接最近一条。 */
  readonly resumePicker?: boolean;
  readonly mcpConfigPath?: string;
  /**
   * 是否加 `--strict-mcp-config`。
   * 有 MCP 注入时默认 true（沿用 headless 适配器：避免用户全局 MCP 混入受管窗口）。
   */
  readonly strictMcp?: boolean;
  readonly initialPrompt?: string;
  /** 合并后的系统提示文件（`--append-system-prompt-file`）。无密钥。 */
  readonly appendSystemPromptFile?: string;
  /**
   * 本窗口额外 settings（`--settings`）。只放观察型 hooks。
   * 官方行为是与用户 settings 合并，不会关掉用户自己的 hooks。
   */
  readonly settingsFile?: string;
  /** T10.5：权限等级 → CLI 参数。 */
  readonly permission?: WorkbenchPermissionLevel;
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
  /**
   * 追加到 Codex 开发者说明前面的文本（`-c developer_instructions=`）。
   * 不替换 Codex 自带说明。值由本函数 JSON.stringify。
   */
  readonly developerInstructions?: string;
  /** T10.5：权限等级 → CLI 参数（续接时同样重给）。 */
  readonly permission?: WorkbenchPermissionLevel;
  /**
   * Codex `notify` 命令数组，只能是 `[node 可执行文件, hook 脚本]`。
   * 写成 `-c notify=[...]`。Codex 会把事件 JSON 追加为最后一个参数，不经 shell。
   * 这条覆盖会盖过用户 config.toml 里的 notify，且只对本次进程生效。
   */
  readonly notifyArgv?: readonly string[];
}

/**
 * 组装交互式 `claude` argv（不含可执行文件名）。
 * 不加 `-p` / stream-json——进入 REPL。
 */
export function buildInteractiveClaudeArgs(input: BuildInteractiveClaudeArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "") {
    args.push("--resume", input.resumeSessionId.trim());
  } else if (input.resumePicker === true) {
    args.push("--resume");
  } else if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    args.push("--session-id", input.sessionId.trim());
  }
  if (input.permission !== undefined) {
    args.push(
      ...resolvePermissionCliArgs({
        cli: "claude-code",
        level: input.permission,
        resume: input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "",
      }),
    );
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
  if (input.appendSystemPromptFile !== undefined && input.appendSystemPromptFile.trim() !== "") {
    args.push("--append-system-prompt-file", input.appendSystemPromptFile.trim());
  }
  if (input.settingsFile !== undefined && input.settingsFile.trim() !== "") {
    args.push("--settings", input.settingsFile.trim());
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(input.initialPrompt);
  }
  return args;
}

/**
 * 组装交互式 `codex` / `codex resume` argv（不含可执行文件名）。
 * 默认进 TUI；续接走 `resume` 子命令；权限参数新开/续接均显式带上。
 */
export function buildInteractiveCodexArgs(input: BuildInteractiveCodexArgsInput): string[] {
  const args: string[] = [];
  const resuming = input.resume === true;
  if (resuming) {
    args.push("resume");
    if (input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "") {
      args.push(input.resumeSessionId.trim());
    }
  }
  args.push("-C", input.cwd);
  if (input.permission !== undefined) {
    args.push(
      ...resolvePermissionCliArgs({
        cli: "codex",
        level: input.permission,
        resume: resuming,
      }),
    );
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("-m", input.model.trim());
  }
  for (const [key, value] of Object.entries(input.configOverrides ?? {})) {
    args.push("-c", `${key}=${value}`);
  }
  if (input.developerInstructions !== undefined && input.developerInstructions.trim() !== "") {
    args.push("-c", `developer_instructions=${JSON.stringify(input.developerInstructions)}`);
  }
  if (input.notifyArgv !== undefined && input.notifyArgv.length > 0) {
    const encoded = input.notifyArgv.map((part) => JSON.stringify(part)).join(",");
    args.push("-c", `notify=[${encoded}]`);
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(input.initialPrompt);
  }
  return args;
}

/** 交互式 Grok 启动参数。会话编号能指定，所以新开用 `--session-id`。 */
export interface BuildInteractiveGrokArgsInput {
  readonly model?: string;
  readonly effort?: string;
  /** 新开会话的 UUID（`--session-id`）。与 resumeSessionId 互斥。 */
  readonly sessionId?: string;
  /** 续接已有 UUID（`--resume <id>`）。没有 id 时调用方不得启动，避免接上最近一条。 */
  readonly resumeSessionId?: string;
  /** 追加到系统提示（`--rules`）。不使用 `--system-prompt-override`。 */
  readonly rules?: string;
  readonly initialPrompt?: string;
  readonly permission?: WorkbenchPermissionLevel;
}

/**
 * 组装交互式 `grok` argv（不含可执行文件名）。
 * 不加 `-p`。续接必须带会话 id，绝不使用 `--continue` 或空的 `--resume`。
 */
export function buildInteractiveGrokArgs(input: BuildInteractiveGrokArgsInput): string[] {
  const args: string[] = [];
  const resumeId = input.resumeSessionId?.trim() ?? "";
  if (resumeId !== "") {
    args.push("--resume", resumeId);
  } else if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    args.push("--session-id", input.sessionId.trim());
  }
  if (input.permission !== undefined) {
    args.push(
      ...resolvePermissionCliArgs({
        cli: "grok",
        level: input.permission,
        resume: resumeId !== "",
      }),
    );
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("--model", input.model.trim());
  }
  if (input.effort !== undefined && input.effort.trim() !== "") {
    args.push("--reasoning-effort", input.effort.trim());
  }
  if (input.rules !== undefined && input.rules.trim() !== "") {
    args.push("--rules", input.rules);
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

/** 断言窗口令牌不出现在 argv / 布局等表面。 */
export function assertTokenAbsent(token: string | undefined, surfaces: readonly string[]): void {
  if (token === undefined || token.length === 0) {
    return;
  }
  for (const surface of surfaces) {
    if (surface.includes(token)) {
      throw new Error("窗口令牌出现在命令行参数或落盘内容中（违反 T10.5 红线）");
    }
  }
}
