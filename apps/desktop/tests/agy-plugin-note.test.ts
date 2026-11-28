/**
 * agy 窗口里关于 ffpane 工具的说明：没添加插件时明说没有、别自己去连；添加了给出怎么调。
 */

import { describe, expect, it } from "vitest";
import { AGY_PLUGIN_NAME, AGY_PLUGIN_SERVER_NAME } from "../src/main/user-mods/agy-plugin";
import {
  AGY_PLUGIN_SERVER_REF,
  agyPluginNote,
  withAgyPluginNote,
} from "../src/main/workbench/agy-plugin-note";

describe("agyPluginNote", () => {
  it("服务器引用名 = 插件名_服务器名，和插件模块一致", () => {
    expect(AGY_PLUGIN_SERVER_REF).toBe(`${AGY_PLUGIN_NAME}_${AGY_PLUGIN_SERVER_NAME}`);
  });

  it("没添加：明说没有工具，禁止自己找地址和令牌", () => {
    const note = agyPluginNote(false, "C:\\Users\\u");
    expect(note).toContain("没有 ffpane 工具");
    expect(note).toContain("不要自己去找");
    expect(note).not.toContain("call_mcp_tool");
  });

  it("已添加：给出描述文件目录和 call_mcp_tool 的调法", () => {
    const note = agyPluginNote(true, "C:\\Users\\u");
    expect(note).toContain("call_mcp_tool");
    expect(note).toContain(AGY_PLUGIN_SERVER_REF);
    expect(note).toContain("antigravity-cli");
    expect(note).toContain("不要自己去找");
  });

  it("没查出来：什么都不说，免得说错；拼接时原样保留", () => {
    expect(agyPluginNote(undefined)).toBe("");
    expect(withAgyPluginNote("角色说明", "")).toBe("角色说明");
    expect(withAgyPluginNote("角色说明", "补充")).toBe("角色说明\n\n补充");
  });
});
