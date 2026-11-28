/**
 * 按需手册（T11.6，计划 §2、§3）。
 *
 * 低频、篇幅长、漏了也不致命的流程不常驻说明书，做成手册：平时只给名字和一句描述，
 * 用到才读全文。源文件是 `apps/desktop/resources/workbench-manuals/<id>/MANUAL.md`，随包打包。
 *
 * 挂载方式复用技能那一套（`skill-mounts.ts` 同款）：Claude 生成插件目录加 `--plugin-dir`，
 * Codex / Grok 把清单写进窗口说明。**不写用户目录**，每个窗口的临时目录关窗即删。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkbenchRole } from "@ff-pane/shared";

/** 单本手册正文的上限（和技能说明同一量级，避免常驻说明被撑大）。 */
export const MAX_MANUAL_CHARS = 16 * 1024;

export interface ManualManifest {
  readonly id: string;
  readonly title: string;
  /** 挂给哪些角色。空 = 所有角色。 */
  readonly roles: readonly WorkbenchRole[];
  readonly version: string;
  readonly description: string;
  readonly body: string;
}

const ROLES = new Set([
  "manager",
  "planner",
  "worker",
  "reviewer",
  "supervisor",
  "researcher",
  "none",
]);

/** 拆 frontmatter 和正文。认不出的字段跳过。 */
export function parseManual(id: string, text: string): ManualManifest | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const fields = new Map<string, string>();
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      end = index;
      break;
    }
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (match !== null) {
      fields.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").replace(/^["']|["']$/g, ""));
    }
  }
  if (end < 0) {
    return undefined;
  }
  const title = fields.get("title") ?? id;
  const description = fields.get("description") ?? "";
  if (description === "") {
    return undefined;
  }
  const roles = (fields.get("roles") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is WorkbenchRole => ROLES.has(part));
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return {
    id,
    title,
    roles,
    version: fields.get("version") ?? "1",
    description: description.slice(0, 400),
    body: body.slice(0, MAX_MANUAL_CHARS),
  };
}

/** 读某个目录下的所有手册（不看角色）。目录不在返回空。 */
export function readManualDir(dir: string): readonly ManualManifest[] {
  if (!existsSync(dir)) {
    return [];
  }
  const manuals: ManualManifest[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = join(dir, entry.name, "MANUAL.md");
    if (!existsSync(file)) {
      continue;
    }
    try {
      const parsed = parseManual(entry.name, readFileSync(file, "utf8"));
      if (parsed !== undefined) {
        manuals.push(parsed);
      }
    } catch {
      // 读不了就跳过，不阻断其它手册
    }
  }
  return manuals.sort((a, b) => a.id.localeCompare(b.id));
}

/** 这个角色该挂哪几本。 */
export function manualsForRole(
  manuals: readonly ManualManifest[],
  role: WorkbenchRole,
): readonly ManualManifest[] {
  return manuals.filter((manual) => manual.roles.length === 0 || manual.roles.includes(role));
}

/** 常驻说明末尾追加的清单：只给名字和一句描述，正文用到再读。 */
export function composeManualIndex(manuals: readonly ManualManifest[]): string | undefined {
  if (manuals.length === 0) {
    return undefined;
  }
  const lines = manuals.map((manual) => `- ${manual.id}（${manual.title}）：${manual.description}`);
  return ["## 按需手册", "下面的流程平时不用读，遇到时再打开对应文件看全文：", ...lines].join("\n");
}

/** 生成本窗口的手册目录（Claude 当插件目录用）。返回目录和要给模型看的清单。 */
export interface PreparedManualMount {
  /** Claude：`--plugin-dir` 的目录；其余运行时为空（走清单）。 */
  readonly claudePluginDir?: string;
  /** 所有运行时都追加到说明末尾的清单。 */
  readonly index?: string;
  readonly mounted: readonly string[];
}

/**
 * 写挂载目录：`<baseDir>/<窗口>/skills/<id>/MANUAL.md` + `.claude-plugin/plugin.json`。
 * 内容是复制不是链接（手册随包，量小，复制更省事也免了跨盘链接问题）。
 */
export async function writeManualMount(input: {
  readonly baseDir: string;
  readonly windowId: string;
  readonly manuals: readonly ManualManifest[];
  readonly runtime: "claude-code" | "codex" | "grok" | "cursor" | "agy";
}): Promise<PreparedManualMount> {
  if (input.manuals.length === 0) {
    return { mounted: [] };
  }
  const index = composeManualIndex(input.manuals);
  const mounted = input.manuals.map((manual) => manual.id);
  if (input.runtime !== "claude-code") {
    return { ...(index !== undefined ? { index } : {}), mounted };
  }
  const { mkdir, writeFile } = await import("node:fs/promises");
  const safe = input.windowId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = join(input.baseDir, safe);
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "ffpane-manuals",
        version: "1.0.0",
        description: "On-demand manuals enabled for this FF-pane window",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  for (const manual of input.manuals) {
    const skillDir = join(dir, "skills", manual.id);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: ${manual.id}\ndescription: ${JSON.stringify(manual.description)}\n---\n\n${manual.body}\n`,
      "utf8",
    );
  }
  return {
    claudePluginDir: dir,
    ...(index !== undefined ? { index } : {}),
    mounted,
  };
}
