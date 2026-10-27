/**
 * T11.1：除普通窗口外不能开子 agent，靠启动参数拦。
 */

import { WORKBENCH_ROLES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
} from "../src/main/workbench/cli-args";
import {
  CLAUDE_SUBAGENT_TOOLS,
  subagentPolicyChanged,
  subagentPolicyFor,
} from "../src/main/workbench/role-tool-policy";

describe("角色 × 子 agent", () => {
  it("普通窗口不限，其余角色一律禁", () => {
    for (const role of WORKBENCH_ROLES) {
      const policy = subagentPolicyFor(role);
      if (role === "none") {
        expect(policy.restricted).toBe(false);
        expect(policy.claudeDisallowedTools).toEqual([]);
        expect(policy.codexConfigOverrides).toEqual({});
      } else {
        expect(policy.restricted, role).toBe(true);
        expect(policy.claudeDisallowedTools).toEqual(["Agent", "Task"]);
        expect(policy.codexConfigOverrides).toEqual({
          "features.multi_agent": "false",
          "features.multi_agent_v2": "false",
        });
      }
    }
  });

  it("改角色：限制变了才要重启", () => {
    expect(subagentPolicyChanged("none", "manager")).toBe(true);
    expect(subagentPolicyChanged("manager", "none")).toBe(true);
    expect(subagentPolicyChanged("worker", "manager")).toBe(false);
    expect(subagentPolicyChanged("none", "none")).toBe(false);
  });
});

describe("Claude 参数", () => {
  it("--disallowedTools 放在最前面，后面紧跟选项，开场白还在最后", () => {
    const args = buildInteractiveClaudeArgs({
      sessionId: "11111111-2222-4333-8444-555555555555",
      permission: "yolo",
      disallowedTools: CLAUDE_SUBAGENT_TOOLS,
      initialPrompt: "开始干活",
    });
    expect(args.slice(0, 3)).toEqual(["--disallowedTools", "Agent,Task", "--session-id"]);
    expect(args.at(-1)).toBe("开始干活");
  });

  it("续接也带上；不传就没有", () => {
    const resumed = buildInteractiveClaudeArgs({
      resumeSessionId: "abc",
      disallowedTools: CLAUDE_SUBAGENT_TOOLS,
    });
    expect(resumed.slice(0, 4)).toEqual(["--disallowedTools", "Agent,Task", "--resume", "abc"]);
    expect(buildInteractiveClaudeArgs({ resumeSessionId: "abc" })).not.toContain(
      "--disallowedTools",
    );
  });
});

describe("Codex 参数", () => {
  it("关 multi_agent 走 -c，新开和续接都带", () => {
    const overrides = subagentPolicyFor("worker").codexConfigOverrides;
    for (const resume of [false, true]) {
      const args = buildInteractiveCodexArgs({
        cwd: "C:/p",
        configOverrides: overrides,
        ...(resume ? { resume: true, resumeSessionId: "s-1" } : {}),
      });
      const joined = args.join(" ");
      expect(joined).toContain("-c features.multi_agent=false");
      expect(joined).toContain("-c features.multi_agent_v2=false");
    }
  });
});
