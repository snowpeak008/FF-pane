/**
 * T11.6：按需手册的解析与挂载。只测纯逻辑和写文件，不启动 CLI。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeManualIndex,
  manualsForRole,
  parseManual,
  readManualDir,
  writeManualMount,
} from "../src/main/workbench/on-demand-manuals";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ffpane-manuals-"));
  dirs.push(dir);
  return dir;
}

const TEXT = `---
id: ffpane-canvas-edit
title: 画板改图
roles: worker, reviewer
version: 1
description: 读要求、改图、存回画板。
---

# 正文第一行
第二行`;

describe("parseManual", () => {
  it("读 frontmatter 和正文", () => {
    const manual = parseManual("ffpane-canvas-edit", TEXT);
    expect(manual).toMatchObject({
      id: "ffpane-canvas-edit",
      title: "画板改图",
      roles: ["worker", "reviewer"],
      version: "1",
      description: "读要求、改图、存回画板。",
    });
    expect(manual?.body.startsWith("# 正文第一行")).toBe(true);
  });

  it("没描述的不收（常驻清单要靠描述）", () => {
    expect(parseManual("x", "---\ntitle: 无描述\n---\n正文")).toBeUndefined();
  });

  it("roles 里认不出的角色丢掉", () => {
    const manual = parseManual("x", "---\ndescription: d\nroles: worker, 乱写\n---\n正文");
    expect(manual?.roles).toEqual(["worker"]);
  });
});

describe("按角色挑选", () => {
  it("没写 roles 的挂给所有角色", () => {
    const all = parseManual("all", "---\ndescription: d\n---\n正文");
    const only = parseManual("only", "---\ndescription: d\nroles: manager\n---\n正文");
    if (all === undefined || only === undefined) {
      throw new Error("parse failed");
    }
    expect(manualsForRole([all, only], "worker").map((manual) => manual.id)).toEqual(["all"]);
    expect(manualsForRole([all, only], "manager").map((manual) => manual.id)).toEqual([
      "all",
      "only",
    ]);
  });
});

describe("composeManualIndex", () => {
  it("只列名字、标题和描述", () => {
    const manual = parseManual("m", "---\ntitle: 某手册\ndescription: 一句话\n---\n很长的正文");
    if (manual === undefined) {
      throw new Error("parse failed");
    }
    const index = composeManualIndex([manual]) ?? "";
    expect(index).toContain("m（某手册）：一句话");
    expect(index).not.toContain("很长的正文");
  });

  it("没有手册时不返回", () => {
    expect(composeManualIndex([])).toBeUndefined();
  });
});

describe("readManualDir", () => {
  it("读目录下每本的 MANUAL.md，跳过不完整和目录外的", () => {
    const root = temp();
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "MANUAL.md"), "---\ntitle: A\ndescription: 甲\n---\n正文");
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "b", "MANUAL.md"), "没有 frontmatter");
    expect(readManualDir(root).map((manual) => manual.id)).toEqual(["a"]);
    expect(readManualDir(join(root, "missing"))).toEqual([]);
  });
});

describe("writeManualMount", () => {
  it("Claude 写出插件目录和 SKILL.md", async () => {
    const base = temp();
    const manual = parseManual("m", "---\ntitle: 某\ndescription: 一句\n---\n正文内容");
    if (manual === undefined) {
      throw new Error("parse failed");
    }
    const prepared = await writeManualMount({
      baseDir: base,
      windowId: "win-1",
      manuals: [manual],
      runtime: "claude-code",
    });
    expect(prepared.claudePluginDir).toBeDefined();
    expect(prepared.mounted).toEqual(["m"]);
    const plugin = JSON.parse(
      readFileSync(join(prepared.claudePluginDir ?? "", ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(plugin.name).toBe("ffpane-manuals");
    const skill = readFileSync(
      join(prepared.claudePluginDir ?? "", "skills", "m", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("正文内容");
    expect(skill).toContain("name: m");
  });

  it("其它运行时只给清单，不写目录", async () => {
    const base = temp();
    const manual = parseManual("m", "---\ntitle: 某\ndescription: 一句\n---\n正文");
    if (manual === undefined) {
      throw new Error("parse failed");
    }
    const prepared = await writeManualMount({
      baseDir: base,
      windowId: "win-1",
      manuals: [manual],
      runtime: "codex",
    });
    expect(prepared.claudePluginDir).toBeUndefined();
    expect(prepared.index).toContain("m（某）");
    expect(existsSync(join(base, "win-1"))).toBe(false);
  });

  it("没有手册什么都不写", async () => {
    const prepared = await writeManualMount({
      baseDir: temp(),
      windowId: "w",
      manuals: [],
      runtime: "claude-code",
    });
    expect(prepared).toEqual({ mounted: [] });
  });
});
