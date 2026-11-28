/**
 * 交互式 Claude Code / Codex 启动参数组装（T10.4 / T10.5）。
 * 纯函数：不含密钥与窗口令牌；MCP 路径与 configOverrides 由调用方注入。
 * 与 headless 适配器（-p / exec --json）分离——工作台窗口跑交互 TUI。
 */

import { CLAUDE_COMMAND_TOOL_NAMES, resolvePermissionCliArgs } from "@ff-pane/core";
import type { WorkbenchPermissionLevel } from "@ff-pane/shared";

/** Claude Code 默认可执行文件名。 */
export const CLAUDE_INTERACTIVE_COMMAND = "claude";

/** Codex 默认可执行文件名。 */
export const CODEX_INTERACTIVE_COMMAND = "codex";

/** Grok 默认可执行文件名。 */
export const GROK_INTERACTIVE_COMMAND = "grok";

/**
 * FF-pane 的 Codex 窗口不读也不写 Codex 全局记忆（T11.0）。
 * 全局记忆不分项目，会把别的项目的总结塞进系统说明；只对本次会话关掉，不改用户的 config.toml。
 */
export const CODEX_SESSION_MEMORY_OFF: readonly string[] = [
  "features.memories=false",
  "memories.use_memories=false",
  "memories.generate_memories=false",
];

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
  /**
   * T11.9：本窗口挂的技能插件目录（`--plugin-dir`，每个目录一对参数，只对这次进程生效）。
   * 不写 ~/.claude。
   */
  readonly pluginDirs?: readonly string[];
  /** T10.5：权限等级 → CLI 参数。 */
  readonly permission?: WorkbenchPermissionLevel;
  /**
   * 直接放行的工具（`--allowedTools`）。工作台协作工具放在这里，只读档也能写近况和汇报；
   * 改项目文件的工具仍按权限档禁用。
   */
  readonly allowedTools?: readonly string[];
  /**
   * 禁用的工具（`--disallowedTools`，T11.1 关子 agent）。用逗号合成一个值放在最前面，
   * 后面紧跟 `--session-id` / `--resume` 这类选项，可变参数不会把开场白当工具名吞掉。
   */
  readonly disallowedTools?: readonly string[];
  /**
   * 只读档仍能跑查看类命令（监管者）：不禁命令工具，由 plan 模式只放行只读命令。
   * 不加 Bash(前缀:*) 放行规则：find -delete、git diff --output 这类前缀也能写盘，放行规则会绕过 plan 的只读判断。
   */
  readonly readOnlyShell?: boolean;
  /**
   * T11.20：可改可跑命令的 Claude 窗口在项目内沙盒里跑命令，把两个命令工具也放进 `--allowedTools`，
   * 命令就不再逐条问（Windows 上 autoAllowBashIfSandboxed 不起作用）。放行后命令仍在沙盒里跑。
   * 和协作工具合成同一个 `--allowedTools`，不出现两次。
   */
  readonly sandboxCommandTools?: readonly string[];
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
  /**
   * T11.7：每窗口的内联 hooks，写成 `-c hooks.PostToolUse=[{hooks=[{type="command",command="…"}]}]`。
   * command 走 PowerShell，引号路径前必须带 `& `（2026-11-28 实测：不带会静默不执行）。
   */
  readonly extraConfig?: Readonly<Record<string, string>>;
  /**
   * T11.7：`--dangerously-bypass-hook-trust`。会让用户在 `~/.codex` 和项目 `.codex` 里自己配的 hooks
   * 也免审核运行，只在 Tony 明确同意时开。
   */
  readonly bypassHookTrust?: boolean;
}

/**
 * 组装交互式 `claude` argv（不含可执行文件名）。
 * 不加 `-p` / stream-json——进入 REPL。
 */
export function buildInteractiveClaudeArgs(input: BuildInteractiveClaudeArgsInput): string[] {
  const args: string[] = [];
  const disallowed = (input.disallowedTools ?? []).filter((tool) => tool.trim() !== "");
  if (disallowed.length > 0) {
    args.push("--disallowedTools", disallowed.join(","));
  }
  if (input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "") {
    args.push("--resume", input.resumeSessionId.trim());
  } else if (input.resumePicker === true) {
    args.push("--resume");
  } else if (input.sessionId !== undefined && input.sessionId.trim() !== "") {
    args.push("--session-id", input.sessionId.trim());
  }
  const readOnlyShell = input.readOnlyShell === true && input.permission === "read-only";
  if (input.permission !== undefined) {
    const permissionArgs = resolvePermissionCliArgs({
      cli: "claude-code",
      level: input.permission,
      resume: input.resumeSessionId !== undefined && input.resumeSessionId.trim() !== "",
    });
    args.push(
      ...(readOnlyShell
        ? permissionArgs.filter(
            (arg) => !(CLAUDE_COMMAND_TOOL_NAMES as readonly string[]).includes(arg),
          )
        : permissionArgs),
    );
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("--model", input.model.trim());
  }
  if (input.effort !== undefined && input.effort.trim() !== "") {
    args.push("--effort", input.effort.trim());
  }
  const sandboxTools = (input.sandboxCommandTools ?? []).filter((tool) => tool.trim() !== "");
  const hasMcp = input.mcpConfigPath !== undefined && input.mcpConfigPath.trim() !== "";
  // 没有 MCP 时也没有要放行的协作工具，只剩沙盒的命令工具。
  const allowed = [
    ...(hasMcp ? (input.allowedTools ?? []).filter((tool) => tool.trim() !== "") : []),
    ...sandboxTools,
  ];
  if (hasMcp) {
    // 可变参数：紧跟 --mcp-config，免得把开场白当成工具名吞掉。
    if (allowed.length > 0) {
      args.push("--allowedTools", ...allowed);
    }
    args.push("--mcp-config", (input.mcpConfigPath ?? "").trim());
    if (input.strictMcp !== false) {
      args.push("--strict-mcp-config");
    }
  } else if (allowed.length > 0) {
    // 用一个值的写法（Claude 自己也这样传），后面跟什么都不会被当成工具名。
    args.push(`--allowedTools=${allowed.join(",")}`);
  }
  if (input.appendSystemPromptFile !== undefined && input.appendSystemPromptFile.trim() !== "") {
    args.push("--append-system-prompt-file", input.appendSystemPromptFile.trim());
  }
  if (input.settingsFile !== undefined && input.settingsFile.trim() !== "") {
    args.push("--settings", input.settingsFile.trim());
  }
  for (const dir of input.pluginDirs ?? []) {
    if (dir.trim() !== "") {
      args.push("--plugin-dir", dir.trim());
    }
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
  // 放在 configOverrides 之后，同名覆盖也盖不过它。
  for (const override of CODEX_SESSION_MEMORY_OFF) {
    args.push("-c", override);
  }
  if (input.developerInstructions !== undefined && input.developerInstructions.trim() !== "") {
    args.push("-c", `developer_instructions=${JSON.stringify(input.developerInstructions)}`);
  }
  if (input.notifyArgv !== undefined && input.notifyArgv.length > 0) {
    const encoded = input.notifyArgv.map((part) => JSON.stringify(part)).join(",");
    args.push("-c", `notify=[${encoded}]`);
  }
  // 内联 hooks 放在最后，同名覆盖盖不过它。
  for (const [key, value] of Object.entries(input.extraConfig ?? {})) {
    args.push("-c", `${key}=${value}`);
  }
  if (input.bypassHookTrust === true) {
    args.push("--dangerously-bypass-hook-trust");
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
 * `--trust` 让 Grok 把该项目文件夹记成可信（写入用户的 trusted_folders，不改 config.toml）。
 */
export function buildInteractiveGrokArgs(input: BuildInteractiveGrokArgsInput): string[] {
  const args: string[] = ["--trust"];
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

/** 交互式 Cursor 启动参数（T11.10）。新开不指定编号，由 sessionStart 钩子报回来。 */
export interface BuildInteractiveCursorArgsInput {
  /** 续接编号（`--resume <id>`）。 */
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly permission?: WorkbenchPermissionLevel;
  /** 本窗口插件目录（MCP）。 */
  readonly pluginDir?: string;
  readonly initialPrompt?: string;
}

/**
 * 组装交互式 `cursor-agent` argv（不含 node.exe 和 index.js）。
 * `--trust`：没见过的目录 Cursor 会先弹「Workspace Trust Required」，界面卡在那里（真机）；
 * 帮助里写着只给无界面模式，实测交互界面也认。同 Grok，项目是用户自己加进来的。
 * `--approve-mcps`：插件里的工作台 MCP 不再逐个询问。
 */
export function buildInteractiveCursorArgs(input: BuildInteractiveCursorArgsInput): string[] {
  const args: string[] = ["--trust"];
  const resumeId = input.resumeSessionId?.trim() ?? "";
  if (resumeId !== "") {
    args.push("--resume", resumeId);
  }
  if (input.permission !== undefined) {
    args.push(
      ...resolvePermissionCliArgs({
        cli: "cursor",
        level: input.permission,
        resume: resumeId !== "",
      }),
    );
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("--model", input.model.trim());
  }
  if (input.pluginDir !== undefined && input.pluginDir.trim() !== "") {
    args.push("--approve-mcps", "--plugin-dir", input.pluginDir);
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(input.initialPrompt);
  }
  return args;
}

/** 交互式 Gemini（agy）启动参数（T11.23）。新开不指定编号，由 SessionStart 钩子报回来。 */
export interface BuildInteractiveAgyArgsInput {
  /** 续接编号（`--conversation <id>`）。没有编号时调用方不启动，避免接上最近一条。 */
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permission?: WorkbenchPermissionLevel;
  readonly initialPrompt?: string;
  /** 初始提示是否留在交互界面（`-i` 跑完提示不走）。新开默认用 `-i`。 */
  readonly interactivePrompt?: boolean;
  /**
   * 本次会话要预先信任的目录（项目根）。写成 `--settings={"trustedWorkspaces":[…]}`：
   * 只对这个会话生效、agy 不保存，不动用户的 agy 设置，也免得停在「是否信任此文件夹」
   * （`--dangerously-skip-permissions` 不管这一项；管理者开的窗口没人去点它）。
   */
  readonly trustedWorkspaces?: readonly string[];
}

/** agy 默认可执行文件名。 */
export const AGY_INTERACTIVE_COMMAND = "agy";

/**
 * 组装交互式 `agy` argv（不含可执行文件名）。
 * - 开场白写成 `-i=<开场白>`，放在所有开关后面。agy 的 `-i`（`--prompt-interactive`）要带值，
 *   写成 `-i --mode …` 时它会把 `--mode` 当成开场白，真正的开场白被丢掉，agy 直接报错退出
 *   （2026-11-28 真机：模型和权限档都没生效，窗口一启动就退出）。跑完开场白留在交互界面。
 * - 续接：`--conversation <id>`；agy 没有「打开选择器」的写法，没有编号时调用方不得启动。
 * - `--mode` / `--dangerously-skip-permissions` 按权限档来（见 `WORKBENCH_PERMISSION_MAPPINGS`）。
 */
export function buildInteractiveAgyArgs(input: BuildInteractiveAgyArgsInput): string[] {
  const args: string[] = [];
  const resumeId = input.resumeSessionId?.trim() ?? "";
  if (resumeId !== "") {
    args.push("--conversation", resumeId);
  }
  if (input.permission !== undefined) {
    args.push(
      ...resolvePermissionCliArgs({
        cli: "agy",
        level: input.permission,
        resume: resumeId !== "",
      }),
    );
  }
  if (input.model !== undefined && input.model.trim() !== "") {
    args.push("--model", input.model.trim());
  }
  if (input.effort !== undefined && input.effort.trim() !== "") {
    args.push("--effort", input.effort.trim());
  }
  const trusted = (input.trustedWorkspaces ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (trusted.length > 0) {
    args.push(`--settings=${JSON.stringify({ trustedWorkspaces: [...new Set(trusted)] })}`);
  }
  if (input.initialPrompt !== undefined && input.initialPrompt.trim() !== "") {
    args.push(`-i=${input.initialPrompt}`);
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
