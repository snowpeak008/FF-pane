/**
 * T9.4b 规范档 / 收窄 / 派发 helper。
 */

import { describe, expect, it } from "vitest";
import {
  narrowReasoningEffortLevels,
  normalizeReasoningEffort,
  REASONING_EFFORT_LEVELS,
  resolveDispatchedReasoningEffort,
  resolveReasoningEffortOptions,
} from "../src/index.js";

describe("normalizeReasoningEffort", () => {
  it("规范档去空白后通过；空 / 非法 → undefined", () => {
    expect(normalizeReasoningEffort(" high ")).toBe("high");
    expect(normalizeReasoningEffort("")).toBeUndefined();
    expect(normalizeReasoningEffort("  ")).toBeUndefined();
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort("ultra")).toBeUndefined();
  });
});

describe("narrowReasoningEffortLevels", () => {
  it("无目录 = 完整规范档；有目录则求交并丢掉非规范值", () => {
    expect(narrowReasoningEffortLevels()).toEqual(REASONING_EFFORT_LEVELS);
    expect(narrowReasoningEffortLevels(["low", "ultra", "high"])).toEqual(["low", "high"]);
    expect(narrowReasoningEffortLevels([])).toEqual([]);
  });
});

describe("resolveReasoningEffortOptions", () => {
  it("非白名单隐藏；opencode 无目录隐藏；其余白名单无目录给全档", () => {
    expect(resolveReasoningEffortOptions("gemini-cli")).toEqual([]);
    expect(resolveReasoningEffortOptions("opencode")).toEqual([]);
    expect(resolveReasoningEffortOptions("opencode", ["high", "max"])).toEqual(["high", "max"]);
    expect(resolveReasoningEffortOptions("claude-code")).toEqual(REASONING_EFFORT_LEVELS);
    expect(resolveReasoningEffortOptions("codex", ["low", "ultra"])).toEqual(["low"]);
  });
});

describe("resolveDispatchedReasoningEffort", () => {
  it("白名单 + 规范档才下发；空不传；opencode 无目录不下发", () => {
    expect(
      resolveDispatchedReasoningEffort({ runtime: "claude-code", reasoningEffort: "high" }),
    ).toBe("high");
    expect(resolveDispatchedReasoningEffort({ runtime: "claude-code" })).toBeUndefined();
    expect(
      resolveDispatchedReasoningEffort({ runtime: "gemini-cli", reasoningEffort: "high" }),
    ).toBeUndefined();
    expect(
      resolveDispatchedReasoningEffort({ runtime: "opencode", reasoningEffort: "high" }),
    ).toBeUndefined();
    expect(
      resolveDispatchedReasoningEffort({
        runtime: "opencode",
        reasoningEffort: "high",
        catalogLevels: ["high", "max"],
      }),
    ).toBe("high");
  });
});
