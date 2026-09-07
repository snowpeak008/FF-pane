/**
 * T9.8 ② 上下文窗口注册表单测：已知模型命中公开规格、未知模型保守默认、
 * 模型缺省按 Runtime 估算（cli_login 场景，T9.2 ④）、来路标注（source）三态。
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_WARN_PERCENT_OPTIONS,
  DEFAULT_CONTEXT_WARN_PERCENT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_GLOBAL_CONFIG,
  resolveContextWindow,
} from "../src/index.js";

describe("resolveContextWindow：已知模型（公开规格，source=model）", () => {
  const cases: readonly (readonly [string, number])[] = [
    ["claude-sonnet-4-5", 200_000],
    ["claude-3-5-haiku-20241022", 200_000],
    ["gpt-5-codex", 400_000],
    ["gpt-5.1", 400_000],
    ["gpt-4.1-mini", 1_000_000],
    ["gpt-4o", 128_000],
    ["gemini-2.5-pro", 1_048_576],
    ["deepseek-chat", 128_000],
    ["deepseek-reasoner", 128_000],
    ["qwen3-coder-plus", 262_144],
    ["grok-code-fast-1", 256_000],
  ];
  for (const [model, tokens] of cases) {
    it(`${model} → ${tokens}`, () => {
      expect(resolveContextWindow(model)).toEqual({ tokens, source: "model" });
    });
  }

  it("匹配大小写不敏感（CLI 报的模型 ID 大小写不定）", () => {
    expect(resolveContextWindow("Claude-Sonnet-4-5").tokens).toBe(200_000);
    expect(resolveContextWindow("GPT-5-CODEX").tokens).toBe(400_000);
  });

  it("特化条目优先：gpt-5 与 gpt-4.1 不互相误伤", () => {
    expect(resolveContextWindow("gpt-5-codex").tokens).toBe(400_000);
    expect(resolveContextWindow("gpt-4.1").tokens).toBe(1_000_000);
  });
});

describe("resolveContextWindow：未知模型 / 缺省模型", () => {
  it("未知模型 → 保守默认且标 fallback（UI 据此标「估算」）", () => {
    expect(resolveContextWindow("my-private-llm-v2")).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: "fallback",
    });
  });

  it("未知模型给了 Runtime 也不按 Runtime 猜：用户显式选的模型才是事实源", () => {
    expect(resolveContextWindow("my-private-llm-v2", "codex")).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: "fallback",
    });
  });

  it("模型缺省 + 已知 Runtime → 按该 CLI 默认模型给保守估算（source=runtime）", () => {
    expect(resolveContextWindow(undefined, "codex")).toEqual({
      tokens: 400_000,
      source: "runtime",
    });
    expect(resolveContextWindow(null, "claude-code")).toEqual({
      tokens: 200_000,
      source: "runtime",
    });
    expect(resolveContextWindow("", "qwen-code")).toEqual({
      tokens: 262_144,
      source: "runtime",
    });
    expect(resolveContextWindow(undefined, "grok-build")).toEqual({
      tokens: 256_000,
      source: "runtime",
    });
    expect(resolveContextWindow(undefined, "gemini-cli")).toEqual({
      tokens: 1_048_576,
      source: "runtime",
    });
  });

  it("模型缺省 + 未知 / 未列 Runtime → 保守默认（opencode 等默认模型随用户配置漂移）", () => {
    expect(resolveContextWindow(undefined, "opencode")).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: "fallback",
    });
    expect(resolveContextWindow(undefined, undefined)).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: "fallback",
    });
  });
});

describe("阈值常量与全局设置接线", () => {
  it("出厂默认 70%，且在候选档位里", () => {
    expect(DEFAULT_CONTEXT_WARN_PERCENT).toBe(70);
    expect(CONTEXT_WARN_PERCENT_OPTIONS).toContain(DEFAULT_CONTEXT_WARN_PERCENT);
  });

  it("DEFAULT_GLOBAL_CONFIG 带 contextWarnPercent（旧 config.json 读入时经浅合并补上）", () => {
    expect(DEFAULT_GLOBAL_CONFIG.contextWarnPercent).toBe(DEFAULT_CONTEXT_WARN_PERCENT);
  });
});
