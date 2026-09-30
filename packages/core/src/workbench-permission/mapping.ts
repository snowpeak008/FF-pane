/**
 * 工作台权限：等级 → CLI 参数映射表（T10.5）。
 * 风格同 provider-injection：映射即数据，无散落 switch。
 *
 * 诚实说明：Windows 上这是 CLI 规则 + 本软件裁决，不是操作系统级隔离。
 * Codex workspace-write 无法单独禁止命令执行（与 edit / edit-exec 的差异主要靠审批策略）。
 */

import type { WorkbenchPermissionLevel } from "@ff-pane/shared";

/** 映射适用的交互式 CLI。 */
export type WorkbenchPermissionCli = "claude-code" | "codex";

/** 单条等级 × CLI 映射。 */
export interface WorkbenchPermissionMapping {
  readonly level: WorkbenchPermissionLevel;
  readonly cli: WorkbenchPermissionCli;
  /**
   * 新开会话 argv 片段（不含可执行文件名）。
   * 禁止把窗口令牌放进此处。
   */
  readonly freshArgs: readonly string[];
  /**
   * 续接会话 argv 片段。
   * Codex：沙箱/审批不随 resume 继承，须用 `-c` 重给（或 bypass 旗标）。
   */
  readonly resumeArgs: readonly string[];
  /** 人类可读备注（文档 / UI 诚实说明）。 */
  readonly notes?: string;
}

/**
 * Claude 只读：禁写工具 + Bash。
 * 工具名以 2.1.220 `--disallowedTools` 空格分隔为准。
 */
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
  "Bash",
] as const;

/** Claude 可改文件：禁 Bash（命令仍不可自动跑）。 */
export const CLAUDE_EDIT_DISALLOWED_TOOLS = ["Bash"] as const;

/**
 * 权限 → CLI 参数映射表。
 *
 * Codex 0.159.2：`-a` 仅 `on-request` | `never`（`untrusted` 已移除）。
 * 产品决策：edit → on-request；edit-exec → never（对齐 Phase10 表「可跑命令」）。
 * Claude edit-exec：`acceptEdits`，不禁 Bash——交互下 Bash 仍由 CLI 询问（合理默认）。
 */
export const WORKBENCH_PERMISSION_MAPPINGS: readonly WorkbenchPermissionMapping[] = [
  // —— Claude ——
  {
    level: "read-only",
    cli: "claude-code",
    freshArgs: [
      "--permission-mode",
      "plan",
      "--disallowedTools",
      ...CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
    ],
    resumeArgs: [
      "--permission-mode",
      "plan",
      "--disallowedTools",
      ...CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
    ],
  },
  {
    level: "edit",
    cli: "claude-code",
    freshArgs: [
      "--permission-mode",
      "acceptEdits",
      "--disallowedTools",
      ...CLAUDE_EDIT_DISALLOWED_TOOLS,
    ],
    resumeArgs: [
      "--permission-mode",
      "acceptEdits",
      "--disallowedTools",
      ...CLAUDE_EDIT_DISALLOWED_TOOLS,
    ],
  },
  {
    level: "edit-exec",
    cli: "claude-code",
    freshArgs: ["--permission-mode", "acceptEdits"],
    resumeArgs: ["--permission-mode", "acceptEdits"],
    notes: "Bash 不加入 disallowed；交互会话下仍由 Claude CLI 询问批准。",
  },
  {
    level: "yolo",
    cli: "claude-code",
    freshArgs: ["--dangerously-skip-permissions"],
    resumeArgs: ["--dangerously-skip-permissions"],
  },
  // —— Codex ——
  {
    level: "read-only",
    cli: "codex",
    freshArgs: ["-s", "read-only"],
    resumeArgs: ["-c", 'sandbox_mode="read-only"'],
    notes: "read-only 下命令执行亦受沙箱限制；无法做到「只读文件但自由跑命令」。",
  },
  {
    level: "edit",
    cli: "codex",
    freshArgs: ["-s", "workspace-write", "-a", "on-request"],
    resumeArgs: ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="on-request"'],
    notes:
      "workspace-write 无法单独禁止 shell；与 edit-exec 的差异主要靠审批（on-request）。untrusted 在 0.159.2 已无效。",
  },
  {
    level: "edit-exec",
    cli: "codex",
    freshArgs: ["-s", "workspace-write", "-a", "never"],
    resumeArgs: ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'],
    notes: "仍非 OS 隔离；never 表示 CLI 不再询问命令审批。",
  },
  {
    level: "yolo",
    cli: "codex",
    freshArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    resumeArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  },
];

const MAPPING_INDEX = new Map<string, WorkbenchPermissionMapping>(
  WORKBENCH_PERMISSION_MAPPINGS.map((row) => [`${row.cli}::${row.level}`, row]),
);

/** 查表；缺行抛错（表应穷尽 4×2）。 */
export function getPermissionMapping(
  cli: WorkbenchPermissionCli,
  level: WorkbenchPermissionLevel,
): WorkbenchPermissionMapping {
  const row = MAPPING_INDEX.get(`${cli}::${level}`);
  if (row === undefined) {
    throw new Error(`missing workbench permission mapping: ${cli} × ${level}`);
  }
  return row;
}

/** 解析指定等级的 argv 片段（新开 / 续接）。 */
export function resolvePermissionCliArgs(input: {
  readonly cli: WorkbenchPermissionCli;
  readonly level: WorkbenchPermissionLevel;
  readonly resume?: boolean;
}): readonly string[] {
  const row = getPermissionMapping(input.cli, input.level);
  return input.resume === true ? row.resumeArgs : row.freshArgs;
}
