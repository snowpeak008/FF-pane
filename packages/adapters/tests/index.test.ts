import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, splitLines } from "../src/index.js";

describe("@ff-pane/adapters", () => {
  it("导出正确的包名常量", () => {
    expect(PACKAGE_NAME).toBe("@ff-pane/adapters");
  });

  it("splitLines 兼容 LF 与 CRLF", () => {
    expect(splitLines('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitLines('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("splitLines 保留行内内容并处理空输入", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("no-newline")).toEqual(["no-newline"]);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});
