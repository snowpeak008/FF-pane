/**
 * T11.4：计划评审的校验和台账行。只测纯逻辑。
 */

import { describe, expect, it } from "vitest";
import {
  formatLedgerEntry,
  ledgerHeader,
  reviewLedgerFileName,
  validateReview,
} from "../src/main/workbench/plan-review";

const finding = (overrides: Record<string, unknown> = {}) => ({
  level: "important",
  layer: "boundary",
  location: "§3.2",
  suggestion: "补上窗口之间的接口",
  ...overrides,
});

describe("validateReview", () => {
  it("正常一轮放行", () => {
    const result = validateReview({ findings: [finding()], round: 1, rejectedNumbers: new Set() });
    expect(result).toMatchObject({ ok: true, round: 1 });
  });

  it("阻断没有证据退回", () => {
    const result = validateReview({
      findings: [finding({ level: "blocking" })],
      round: 1,
      rejectedNumbers: new Set(),
    });
    expect(result).toMatchObject({ ok: false, reason: "blocking_no_evidence" });
  });

  it("阻断带证据放行", () => {
    const result = validateReview({
      findings: [finding({ level: "blocking", evidence: "apps/x.ts:42" })],
      round: 1,
      rejectedNumbers: new Set(),
    });
    expect(result.ok).toBe(true);
  });

  it("阻断加重要超过 5 条退回", () => {
    const many = Array.from({ length: 6 }, () => finding());
    expect(validateReview({ findings: many, round: 1, rejectedNumbers: new Set() })).toMatchObject({
      ok: false,
      reason: "too_many_findings",
    });
  });

  it("实现层自动降为细节，不占阻断加重要的名额", () => {
    const result = validateReview({
      findings: Array.from({ length: 6 }, () => finding({ layer: "implementation" })),
      round: 1,
      rejectedNumbers: new Set(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.every((item) => item.level === "detail")).toBe(true);
    }
  });

  it("第二轮不许提新的非阻断问题，阻断可以", () => {
    expect(
      validateReview({ findings: [finding()], round: 2, rejectedNumbers: new Set() }),
    ).toMatchObject({ ok: false, reason: "new_finding_round2" });
    expect(
      validateReview({
        findings: [finding({ level: "blocking", evidence: "跑出 ENOENT" })],
        round: 2,
        rejectedNumbers: new Set(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("第三轮退回", () => {
    expect(
      validateReview({ findings: [finding()], round: 3, rejectedNumbers: new Set() }),
    ).toMatchObject({ ok: false, reason: "round_limit" });
  });

  it("重提已否决的问题退回", () => {
    expect(
      validateReview({
        findings: [finding({ refersTo: 7 })],
        round: 2,
        rejectedNumbers: new Set([7]),
      }),
    ).toMatchObject({ ok: false, reason: "already_rejected" });
  });

  it("缺字段退回并指出第几条", () => {
    const result = validateReview({
      findings: [{ level: "important", layer: "goal" }],
      round: 1,
      rejectedNumbers: new Set(),
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("findings[0]");
    }
  });
});

describe("台账", () => {
  it("表头写明计划和规则", () => {
    const text = ledgerHeader(".ffpane/briefs/计划.md");
    expect(text).toContain("计划：.ffpane/briefs/计划.md");
    expect(text).toContain("否决过的不许重提");
  });

  it("一行一条，级别和层写中文", () => {
    const line = formatLedgerEntry({
      number: 3,
      level: "blocking",
      layer: "boundary",
      reviewer: "评审甲",
      round: 1,
      status: "待定",
      location: "§4",
      suggestion: "改接口",
      evidence: "apps/x.ts:42",
    });
    expect(line).toContain("| 3 | 阻断 | 边界 | 评审甲 | 第1轮 | 待定 |");
    expect(line).toContain("证据 apps/x.ts:42");
  });

  it("台账文件名去路径、去扩展名", () => {
    expect(reviewLedgerFileName(".ffpane/briefs/登录重构.md")).toBe("登录重构.md");
    expect(reviewLedgerFileName("a/b/plan.md")).toBe("plan.md");
  });
});
