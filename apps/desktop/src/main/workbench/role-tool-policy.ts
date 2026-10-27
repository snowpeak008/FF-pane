/**
 * 子 agent 管控（T11.1，Tony 2026-10-24 定）：除了用户自己开的普通窗口，所有角色都不能开子 agent。
 * 规则靠启动参数拦，不靠说明书。纯函数，Claude 和 Codex 共用一张表，有单测。
 *
 * 真机核对（2026-10-27）：
 * - Claude Code 2.1.302：子 agent 工具在工具列表里叫 Task；`--disallowedTools Agent,Task` 之后没有了，
 *   `--dangerously-skip-permissions`（yolo）下也一样。
 * - codex-cli 0.162.0：`multi_agent` 默认开；`-c features.multi_agent=false` 只对这次启动生效，
 *   不改 `~/.codex/config.toml`（Codex 桌面版共用它）。
 * - Grok 的 agent 层没有关子 agent 的参数，只能靠说明书（计划 §5）。
 */

import type { WorkbenchRole } from "@ff-pane/shared";

/** Claude 里子 agent 工具的两个名字（新版叫 Agent，工具列表里显示 Task）。 */
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task"] as const;

export const CODEX_SUBAGENT_OFF: Readonly<Record<string, string>> = {
  "features.multi_agent": "false",
  "features.multi_agent_v2": "false",
};

export interface SubagentPolicy {
  /** 是否禁子 agent。 */
  readonly restricted: boolean;
  readonly claudeDisallowedTools: readonly string[];
  readonly codexConfigOverrides: Readonly<Record<string, string>>;
}

const OPEN: SubagentPolicy = {
  restricted: false,
  claudeDisallowedTools: [],
  codexConfigOverrides: {},
};

const RESTRICTED: SubagentPolicy = {
  restricted: true,
  claudeDisallowedTools: CLAUDE_SUBAGENT_TOOLS,
  codexConfigOverrides: CODEX_SUBAGENT_OFF,
};

export function subagentPolicyFor(role: WorkbenchRole): SubagentPolicy {
  return role === "none" ? OPEN : RESTRICTED;
}

/** 运行中改角色：限制变了要重启窗口才生效（启动参数换了）。 */
export function subagentPolicyChanged(from: WorkbenchRole, to: WorkbenchRole): boolean {
  return subagentPolicyFor(from).restricted !== subagentPolicyFor(to).restricted;
}
