/**
 * T7.1 → T9.8 ① 跨 Agent 迁移 / 轻装新开的纯视图逻辑单测：
 * 目标候选派生（含自身、标出换 Runtime 与 isCurrent）+ 两种意图各自的缺省选中。
 */

import type { AgentProfile, ProfileId, RuntimeId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  defaultHandoffTargetId,
  defaultInheritTargetId,
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

  it("包含当前 Profile 自己（T9.8 ①：迁移到自己 = 同 Profile 轻装新开）", () => {
    const targets = deriveHandoffTargets([codex, claude], codex);
    expect(targets.map((target) => target.profile.id)).toEqual(["p-codex", "p-claude"]);
    expect(targets[0]).toEqual({ profile: codex, runtimeChanged: false, isCurrent: true });
  });

  it("标出哪些换了 Runtime；自己不标（同 Runtime 恒成立）；同 Runtime 换 Provider/模型也照样是候选", () => {
    const targets = deriveHandoffTargets([codex, claude, codex2], codex);
    expect(targets).toEqual([
      { profile: codex, runtimeChanged: false, isCurrent: true },
      { profile: claude, runtimeChanged: true, isCurrent: false },
      { profile: codex2, runtimeChanged: false, isCurrent: false },
    ]);
  });

  it("无当前 Profile（尚未绑定）→ 全部是候选且都不标「换 Runtime」/「自己」", () => {
    const targets = deriveHandoffTargets([codex, claude], null);
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => !target.runtimeChanged && !target.isCurrent)).toBe(true);
  });

  it("顺序沿用 profiles:list（用户在设置页看到的顺序）", () => {
    const targets = deriveHandoffTargets([codex2, claude], codex);
    expect(targets.map((target) => target.profile.id)).toEqual(["p-codex-2", "p-claude"]);
  });
});

describe("defaultHandoffTargetId（「换 Agent」意图）", () => {
  const codex = profile("p-codex", "codex");
  const claude = profile("p-claude", "claude-code");
  const codex2 = profile("p-codex-2", "codex");

  it("优先选换了 Runtime 的第一个（「换 Agent」最典型的一次）", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex, codex2, claude], codex))).toBe(
      "p-claude",
    );
  });

  it("没有换 Runtime 的候选就取第一个非自己的", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex, codex2], codex))).toBe("p-codex-2");
  });

  it("只剩自己 → 选自己（轻装新开也是有效去处，不再返回 undefined）", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([codex], codex))).toBe("p-codex");
  });

  it("一个候选都没有 → undefined（界面据此提示先去建 Profile）", () => {
    expect(defaultHandoffTargetId(deriveHandoffTargets([], codex))).toBeUndefined();
  });
});

describe("defaultInheritTargetId（「开新会话并继承」意图，T9.8 ①）", () => {
  const codex = profile("p-codex", "codex");
  const claude = profile("p-claude", "claude-code");

  it("优先选当前 Profile 自己（轻装新开的常态：还是这个 Agent）", () => {
    expect(defaultInheritTargetId(deriveHandoffTargets([claude, codex], codex))).toBe("p-codex");
  });

  it("无当前 Profile 时退回换 Agent 的缺省逻辑（取第一个）", () => {
    expect(defaultInheritTargetId(deriveHandoffTargets([claude, codex], null))).toBe("p-claude");
  });

  it("一个候选都没有 → undefined", () => {
    expect(defaultInheritTargetId(deriveHandoffTargets([], codex))).toBeUndefined();
  });
});
