import { describe, expect, it } from "vitest";
import {
  formatPathLines,
  parsePathLines,
} from "../src/renderer/src/pages/settings/permission-envelope";

describe("parsePathLines", () => {
  it("按行拆、去空白、丢空行", () => {
    expect(parsePathLines("src/**\n  docs/*  \n\n\ntests/**\n")).toEqual([
      "src/**",
      "docs/*",
      "tests/**",
    ]);
  });

  it("去重保序", () => {
    expect(parsePathLines("a\nb\na\nc\nb")).toEqual(["a", "b", "c"]);
  });

  it("全空白 → 空数组", () => {
    expect(parsePathLines("\n  \n")).toEqual([]);
  });
});

describe("formatPathLines", () => {
  it("一行一条", () => {
    expect(formatPathLines(["src/**", "docs/*"])).toBe("src/**\ndocs/*");
  });

  it("round-trip", () => {
    const paths = ["src/**", "package.json", "tests/**"];
    expect(parsePathLines(formatPathLines(paths))).toEqual(paths);
  });
});
