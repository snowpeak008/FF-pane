import { composeWorkbenchSystemPrompt } from "@ff-pane/core";
import { describe, expect, it } from "vitest";

describe("composeWorkbenchSystemPrompt", () => {
  it("none 只有 base，忽略角色正文", () => {
    expect(
      composeWorkbenchSystemPrompt({
        base: " 共同说明 \r\n",
        role: "none",
        roleManual: "执行说明书",
      }),
    ).toBe("共同说明");
  });

  it("其它角色是 base 加说明书", () => {
    expect(
      composeWorkbenchSystemPrompt({
        base: "共同",
        role: "worker",
        roleManual: "只改 brief 范围内的文件",
      }),
    ).toBe("共同\n\n只改 brief 范围内的文件");
  });

  it("覆盖副本由调用方传入，空正文则退回 base", () => {
    expect(
      composeWorkbenchSystemPrompt({
        base: "共同",
        role: "manager",
        roleManual: "  覆盖后的管理者说明  ",
      }),
    ).toBe("共同\n\n覆盖后的管理者说明");
    expect(
      composeWorkbenchSystemPrompt({
        base: "共同",
        role: "planner",
        roleManual: "   ",
      }),
    ).toBe("共同");
  });
});
