import { describe, expect, it } from "vitest";
import { validateModelOverride } from "../src/domain/model-override.js";

describe("validateModelOverride", () => {
  it("接受别名、全名和后缀", () => {
    const alias = validateModelOverride(" sonnet ");
    const named = validateModelOverride("claude-opus-4-8[1m]");
    const slug = validateModelOverride("gpt-5.5");
    expect(alias.ok && alias.model).toBe("sonnet");
    expect(named.ok && named.model).toBe("claude-opus-4-8[1m]");
    expect(slug.ok && slug.model).toBe("gpt-5.5");
  });

  it("拒绝空白、换行、控制字符、超长和空格", () => {
    expect(validateModelOverride("  ").ok).toBe(false);
    expect(validateModelOverride("opus\nhigh").ok).toBe(false);
    expect(validateModelOverride("opus\u0001").ok).toBe(false);
    expect(validateModelOverride(`${"a".repeat(129)}`).ok).toBe(false);
    expect(validateModelOverride("not a model").ok).toBe(false);
    expect(validateModelOverride("../secret").ok).toBe(false);
  });
});
