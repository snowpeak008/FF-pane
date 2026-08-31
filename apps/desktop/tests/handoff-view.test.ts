/**
 * T7.1 跨 Agent 迁移的纯视图逻辑单测：目标候选派生（排己、标出换 Runtime）+ 缺省选中。
 */

import type { AgentProfile, ProfileId, RuntimeId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  defaultHandoffTargetId,
  deriveHandoffTargets,
} from "../src/renderer/src/pages/session/handoff-view";

function profile(id: string, runtime: string): AgentProfile {
  return {
    id: id as ProfileId,
    name: `Profile ${id}`,
    runtime: runtime as RuntimeId,
    providerId: "prov-1",
    defaultRole: "planner",
    permissionPreset: {},
  } as unknown as AgentProfile;
}

describe("deriveHandoffTargets", () => {
  const codex = profile("p-codex", "codex");
  const claude = profile("p-claude", "claude-code");
  const codex2 = profile("p-codex-2", "codex");

  it("排除当前 Profile 自己（迁移到自己就是普通续接）", () => {
    const targets = deriveHandoffTargets([codex, claude], codex);
    expect(targets.map((target) => target.profile.id)).toEqual(["p-claude"]);
  });

  it("标出哪些换了 Runtime；同 Runtime 的换 Provider/模型也照样是候选", () => {
    const targets = deriveHandoffTargets([codex, claude, codex2], codex);
    expect(targets).toEqual([
      { profile: claude, runtimeChanged: true },
      { profile: codex2, runtimeChanged: false },
    ]);
  });

  it("无当前 Profile（尚未绑定）→ 全部是候选且都不标「换 Runtime」", () => {
    const targets = deriveHandoffTargets([codex, claude], null);
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => !target.runtimeChanged)).toBe(true);
  });

  it("顺序沿用 profiles:list（用户在设置页看到的顺序）", () => {
    const targets = deriveHandoffTargets([codex2, claude], codex);
    expect(targets.map((target) => target.profile.id)).toEqual(["p-codex-2", "p-claude"]);
  });
});

describe("defaultHandoffTargetId", () => {
  const codex = profile("p-codex", "codex");
  const claude = profile("p-claude", "claude-code");
  const codex2 = profile("p-codex-2", "codex");

  it("优先选换了 Runtime 的第一个（「换 Agent」最典型的一次）", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex, codex2, claude], codex))).toBe(
      "p-claude",
    );
  });

  it("没有换 Runtime 的候选就取第一个", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex, codex2], codex))).toBe("p-codex-2");
  });

  it("一个候选都没有 → undefined（界面据此提示先去建 Profile）", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex], codex))).toBeUndefined();
  });
});
