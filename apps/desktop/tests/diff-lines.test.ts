import { describe, expect, it } from "vitest";
import { classifyDiffLine } from "../src/renderer/src/pages/runs/diff-lines";

describe("classifyDiffLine", () => {
  it("hunk 头", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
  });

  it("文件头归 meta（+++ / --- / diff / index / new file）", () => {
    expect(classifyDiffLine("+++ b/a.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/a.ts")).toBe("meta");
    expect(classifyDiffLine("diff --git a/a.ts b/a.ts")).toBe("meta");
    expect(classifyDiffLine("index e69de29..0000000")).toBe("meta");
    expect(classifyDiffLine("new file mode 100644")).toBe("meta");
  });

  it("增删行（+++/--- 已先归 meta，此处为单个 +/-）", () => {
    expect(classifyDiffLine("+const a = 1;")).toBe("added");
    expect(classifyDiffLine("-const a = 0;")).toBe("removed");
  });

  it("上下文行", () => {
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});
