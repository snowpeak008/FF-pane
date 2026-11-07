/**
 * T11.8：AI 窗口能写哪些目录。
 */

import { describe, expect, it } from "vitest";
import {
  claudeProjectDataDir,
  claudeWriteRoots,
  cleanOutsideDirs,
  codexWritableRootsOverride,
  WRITE_ROOTS_ENV,
} from "../src/main/workbench/write-roots";
import { WRITE_ROOTS_ENV as HOOK_ENV } from "../src/mcp/write-guard";

const PROJECT = "D:\\WorkWork\\gamedesign\\项目2--海上生存";
const HOME = "C:\\Users\\admin";
const TMP = "C:\\Users\\admin\\AppData\\Local\\Temp";

describe("write-roots", () => {
  it("主进程和 hook 用同一个环境变量名", () => {
    expect(WRITE_ROOTS_ENV).toBe(HOOK_ENV);
  });

  it("Claude 自己记忆的目录名和现场一致", () => {
    expect(claudeProjectDataDir(HOME, PROJECT)).toBe(
      "C:\\Users\\admin\\.claude\\projects\\D--WorkWork-gamedesign---2------",
    );
  });

  it("Claude 能写：项目在第一个，再是临时目录、计划、自己记忆、项目外可写目录；去重", () => {
    const roots = claudeWriteRoots({
      projectRoot: PROJECT,
      cwd: PROJECT,
      home: HOME,
      tmp: TMP,
      outsideDirs: ["D:\\WorkWork\\共享素材", "d:\\workwork\\共享素材\\", " "],
    });
    expect(roots).toEqual([
      PROJECT,
      TMP,
      "C:\\Users\\admin\\.claude\\plans",
      "C:\\Users\\admin\\.claude\\projects\\D--WorkWork-gamedesign---2------\\memory",
      "D:\\WorkWork\\共享素材",
    ]);
  });

  it("Codex：有项目外可写目录才传 writable_roots", () => {
    expect(codexWritableRootsOverride([])).toEqual({});
    expect(codexWritableRootsOverride(["D:\\A"])).toEqual({
      "sandbox_workspace_write.writable_roots": JSON.stringify(["D:\\A"]),
    });
    expect(cleanOutsideDirs(['"D:\\A"', "D:\\a"])).toEqual(["D:\\A"]);
  });
});
