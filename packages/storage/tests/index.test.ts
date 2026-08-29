import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, toPosixPath } from "../src/index.js";

describe("@ff-pane/storage", () => {
  it("导出正确的包名常量", () => {
    expect(PACKAGE_NAME).toBe("@ff-pane/storage");
  });

  it("toPosixPath 归一化 Windows 路径（含中文）", () => {
    expect(toPosixPath("D:\\WorkWork\\项目\\.workbench\\plans\\计划.md")).toBe(
      "D:/WorkWork/项目/.workbench/plans/计划.md",
    );
  });

  it("toPosixPath 对 POSIX 路径保持原样", () => {
    expect(toPosixPath("/home/user/.aiworkbench/index.sqlite")).toBe(
      "/home/user/.aiworkbench/index.sqlite",
    );
  });
});
