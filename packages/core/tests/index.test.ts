import { describe, expect, it } from "vitest";
import { assertNever, PACKAGE_NAME } from "../src/index.js";

describe("@ff-pane/core", () => {
  it("导出正确的包名常量", () => {
    expect(PACKAGE_NAME).toBe("@ff-pane/core");
  });

  it("assertNever 在穷举 switch 中保证编译期与运行期一致", () => {
    type Status = "draft" | "approved";
    const label = (status: Status): string => {
      switch (status) {
        case "draft":
          return "草稿";
        case "approved":
          return "已批准";
        default:
          return assertNever(status, "label");
      }
    };
    expect(label("draft")).toBe("草稿");
    expect(label("approved")).toBe("已批准");
  });

  it("assertNever 运行期兜底抛出带上下文的错误", () => {
    expect(() => assertNever("rogue" as never, "test")).toThrow('test: unexpected value "rogue"');
  });
});
