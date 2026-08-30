import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "../src/renderer/src/lib/time";

const NOW = 1_700_000_000_000; // 固定参照点，避免依赖真实时钟
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("不足一分钟归为「现在」（numeric:auto）", () => {
    expect(formatRelativeTime(NOW - 5_000, "en-US", NOW)).toBe("now");
  });

  it("分钟级：过去用 ago", () => {
    expect(formatRelativeTime(NOW - 3 * MINUTE, "en-US", NOW)).toBe("3 minutes ago");
  });

  it("小时级四舍五入到最近单位", () => {
    expect(formatRelativeTime(NOW - 2 * HOUR, "en-US", NOW)).toBe("2 hours ago");
  });

  it("天级：将来用 in", () => {
    expect(formatRelativeTime(NOW + 2 * DAY, "en-US", NOW)).toBe("in 2 days");
  });

  it("跟随 locale：中文输出", () => {
    expect(formatRelativeTime(NOW - 3 * MINUTE, "zh-CN", NOW)).toContain("3");
  });
});

describe("formatAbsoluteTime", () => {
  it("产出非空的本地化字符串（含年份）", () => {
    const text = formatAbsoluteTime(NOW, "en-US");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("2023");
  });
});
