/**
 * T9.4b OpenCode 本机模型目录 effort values 解析。
 */

import { describe, expect, it } from "vitest";
import { parseOpenCodeEffortValues } from "../src/local-models/effort-catalog.js";

describe("parseOpenCodeEffortValues", () => {
  it("数组形态：type=effort 的 values；toggle-only / 空数组 → 空档", () => {
    const catalog = {
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["low", "medium", "high"] },
          ],
        },
        { id: "openai/gpt-4o", reasoning_options: [{ type: "toggle" }] },
        { id: "empty/model", reasoning_options: [] },
      ],
    };
    expect(parseOpenCodeEffortValues(catalog, "anthropic/claude-sonnet-4-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(parseOpenCodeEffortValues(catalog, "claude-sonnet-4-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(parseOpenCodeEffortValues(catalog, "openai/gpt-4o")).toEqual([]);
    expect(parseOpenCodeEffortValues(catalog, "empty/model")).toEqual([]);
    expect(parseOpenCodeEffortValues(catalog, "missing/model")).toBeUndefined();
    expect(parseOpenCodeEffortValues(catalog, undefined)).toBeUndefined();
  });

  it("provider/models 键形态同样能命中", () => {
    const catalog = {
      anthropic: {
        models: {
          "claude-opus-4": {
            id: "claude-opus-4",
            reasoning_options: { type: "effort", values: ["high", "max"] },
          },
        },
      },
    };
    expect(parseOpenCodeEffortValues(catalog, "anthropic/claude-opus-4")).toEqual(["high", "max"]);
  });
});
