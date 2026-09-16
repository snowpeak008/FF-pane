/**
 * T9.4b 规范档 / 收窄 / 派发 helper。
 */

import { describe, expect, it } from "vitest";
import {
  inferConnectionMode,
  isConnectionMode,
  narrowReasoningEffortLevels,
  normalizeReasoningEffort,
  REASONING_EFFORT_LEVELS,
  resolveConnectionMode,
  resolveDispatchedReasoningEffort,
  resolveReasoningEffortOptions,
  resolveTurnReasoningEffort,
  runtimeSupportsLocalCli,
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

describe("resolveTurnReasoningEffort", () => {
  it("会话覆盖 > 任务合同 > 档案默认", () => {
    expect(
      resolveTurnReasoningEffort({
        runtime: "claude-code",
        sessionOverride: "medium",
        taskEffort: "high",
        profileEffort: "low",
      }),
    ).toBe("medium");
    expect(
      resolveTurnReasoningEffort({
        runtime: "claude-code",
        taskEffort: "high",
        profileEffort: "low",
      }),
    ).toBe("high");
    expect(
      resolveTurnReasoningEffort({
        runtime: "claude-code",
        profileEffort: "low",
      }),
    ).toBe("low");
  });
});

describe("connectionMode（T9.11）", () => {
  it("cli_login 推断本地 CLI；其余推断中转；显式值优先", () => {
    expect(inferConnectionMode("cli_login")).toBe("local_cli");
    expect(inferConnectionMode("openai_compatible")).toBe("relay");
    expect(inferConnectionMode("anthropic")).toBe("relay");
    expect(resolveConnectionMode("relay", "cli_login")).toBe("relay");
    expect(resolveConnectionMode("local_cli", "openai_compatible")).toBe("local_cli");
    expect(resolveConnectionMode(undefined, "cli_login")).toBe("local_cli");
    expect(resolveConnectionMode("hybrid", "cli_login")).toBe("local_cli");
    expect(isConnectionMode("local_cli")).toBe(true);
    expect(isConnectionMode("relay")).toBe(true);
    expect(isConnectionMode("hybrid")).toBe(false);
  });

  it("本机 CLI Runtime + generic-exec 可走本地；DeepSeek 不是 Runtime", () => {
    expect(runtimeSupportsLocalCli("claude-code")).toBe(true);
    expect(runtimeSupportsLocalCli("codex")).toBe(true);
    expect(runtimeSupportsLocalCli("gemini-cli")).toBe(true);
    expect(runtimeSupportsLocalCli("grok-build")).toBe(true);
    expect(runtimeSupportsLocalCli("opencode")).toBe(true);
    expect(runtimeSupportsLocalCli("generic-exec")).toBe(true);
    expect(runtimeSupportsLocalCli("iflow")).toBe(false);
  });
});
