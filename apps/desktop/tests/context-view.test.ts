/**
 * T9.8 ② 上下文阈值提醒的纯视图逻辑单测：
 * 分子双路（真实 usage 优先 / 字符估算回退 + 估算标注）、分母三级（Agent 自报 /
 * 注册表公开规格 / Runtime 保守估算）、阈值触发判定。
 */

import { describe, expect, it } from "vitest";
import {
  ASCII_CHARS_PER_TOKEN,
  deriveContextGauge,
  estimateTokensFromText,
} from "../src/renderer/src/pages/session/context-view";

describe("estimateTokensFromText（字符估算折算）", () => {
  it("纯 ASCII：约 4 字符 1 token，向上取整", () => {
    expect(estimateTokensFromText("abcd")).toBe(1);
    expect(estimateTokensFromText("abcde")).toBe(2);
    expect(estimateTokensFromText("a".repeat(400))).toBe(100);
  });

  it("CJK 每字约 1 token（比 ASCII 密——不按 4:1 摊薄）", () => {
    expect(estimateTokensFromText("上下文膨胀")).toBe(5);
  });

  it("混合文本分段折算", () => {
    // 4 个 CJK（4 token）+ 8 个 ASCII（2 token）
    expect(estimateTokensFromText("上下文长abcdefgh")).toBe(6);
  });

  it("空文本 → 0", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });
});

describe("deriveContextGauge：分子双路", () => {
  it("真实 usage 优先（分子路径 1）：已知模型 → 非估算", () => {
    const gauge = deriveContextGauge({
      usage: { usedTokens: 100_000 },
      transcriptText: "无关紧要的转录",
      model: "claude-sonnet-4-5",
      runtime: "claude-code",
      warnPercent: 70,
    });
    expect(gauge).toEqual({
      usedTokens: 100_000,
      windowTokens: 200_000,
      percent: 50,
      estimated: false,
      shouldWarn: false,
    });
  });

  it("无真实 usage → 字符估算（分子路径 2）且标注估算", () => {
    const text = "a".repeat(4_000);
    const gauge = deriveContextGauge({
      usage: undefined,
      transcriptText: text,
      model: "claude-sonnet-4-5",
      runtime: "claude-code",
      warnPercent: 70,
    });
    expect(gauge?.usedTokens).toBe(4_000 / ASCII_CHARS_PER_TOKEN);
    expect(gauge?.estimated).toBe(true);
  });

  it("无 usage 且转录为空 → null（没有可提醒的对象）", () => {
    expect(
      deriveContextGauge({
        usage: undefined,
        transcriptText: "",
        model: "claude-sonnet-4-5",
        runtime: "claude-code",
        warnPercent: 70,
      }),
    ).toBeNull();
  });
});

describe("deriveContextGauge：分母三级", () => {
  it("Agent 自报窗口最权威（grok ACP usage_update 的 size）→ 非估算", () => {
    const gauge = deriveContextGauge({
      usage: { usedTokens: 400_000, windowTokens: 500_000 },
      transcriptText: "",
      // 模型注册表会给 grok 家族 256K——自报的 500K 必须压过它
      model: "grok-4.6",
      runtime: "grok-build",
      warnPercent: 70,
    });
    expect(gauge?.windowTokens).toBe(500_000);
    expect(gauge?.percent).toBe(80);
    expect(gauge?.estimated).toBe(false);
  });

  it("未知模型 → 保守默认 128K 且标注估算（即便分子是真实 usage）", () => {
    const gauge = deriveContextGauge({
      usage: { usedTokens: 64_000 },
      transcriptText: "",
      model: "my-private-llm",
      runtime: "codex",
      warnPercent: 70,
    });
    expect(gauge?.windowTokens).toBe(128_000);
    expect(gauge?.percent).toBe(50);
    expect(gauge?.estimated).toBe(true);
  });

  it("cli_login 缺省模型（model 空）→ 按 Runtime 给保守窗口且标注估算", () => {
    const gauge = deriveContextGauge({
      usage: { usedTokens: 300_000 },
      transcriptText: "",
      model: null,
      runtime: "codex",
      warnPercent: 70,
    });
    // codex CLI 默认 gpt-5-codex（400K）
    expect(gauge?.windowTokens).toBe(400_000);
    expect(gauge?.percent).toBe(75);
    expect(gauge?.estimated).toBe(true);
  });
});

describe("deriveContextGauge：阈值触发", () => {
  const at = (usedTokens: number, warnPercent: number) =>
    deriveContextGauge({
      usage: { usedTokens },
      transcriptText: "",
      model: "claude-sonnet-4-5",
      runtime: "claude-code",
      warnPercent,
    });

  it("达阈值（含恰好等于）→ shouldWarn", () => {
    expect(at(140_000, 70)?.shouldWarn).toBe(true); // 恰 70%
    expect(at(180_000, 70)?.shouldWarn).toBe(true); // 90%
  });

  it("低于阈值 → 不提醒", () => {
    expect(at(139_000, 70)?.shouldWarn).toBe(false); // 69%
  });

  it("阈值可设置：同一用量在 50% 阈值下触发、在 90% 阈值下不触发", () => {
    expect(at(140_000, 50)?.shouldWarn).toBe(true);
    expect(at(140_000, 90)?.shouldWarn).toBe(false);
  });

  it("窗口真被撑爆时如实显示超 100%", () => {
    expect(at(250_000, 70)?.percent).toBe(125);
  });
});
