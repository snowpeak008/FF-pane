import { describe, expect, it } from "vitest";
import { appMenuTemplate, resolveAppMenuLanguage } from "../src/main/app-menu";

describe("应用菜单语言", () => {
  it("中文系统显示文件、编辑、查看、窗口", () => {
    expect(resolveAppMenuLanguage("zh-CN")).toBe("zh-CN");
    expect(resolveAppMenuLanguage("zh-Hans")).toBe("zh-CN");
    const labels = appMenuTemplate("zh-CN").map((item) => item.label);
    expect(labels).toEqual(["文件", "编辑", "查看", "窗口"]);
  });

  it("英文界面保留 File Edit View Window", () => {
    expect(resolveAppMenuLanguage("en-US")).toBe("en-US");
    const labels = appMenuTemplate("en-US").map((item) => item.label);
    expect(labels).toEqual(["File", "Edit", "View", "Window"]);
  });
});
