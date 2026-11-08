/**
 * 按窗口挂技能（T11.9 / 技能计划 §4.2）。
 *
 * - Claude：在 `<数据根>/skill-mounts/<窗口>/` 生成一个插件目录，`skills/<原名>` 是指向技能库的目录链接
 *   （junction），启动加 `--plugin-dir`。不复制，用户填的配置文件只有技能库里那一份。
 * - Codex、Grok：没有按会话挂技能的办法，把技能清单写进窗口说明，AI 用到时按路径读 SKILL.md。
 * - 关窗删挂载目录：先拆链接，再删目录，绝不顺着链接删到技能库里。
 */

import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WindowSkillsReport } from "../../shared-ipc/contracts";
import { composeSkillInstructions, type SkillMountPlan, type SkillRuntime } from "./skill-manifest";

/** Claude 插件名。窗口里的技能会显示成 `ffpane-skills:<原名>`。 */
export const CLAUDE_SKILL_PLUGIN_NAME = "ffpane-skills";

export interface PreparedSkillMount {
  /** Claude：`--plugin-dir` 的目录。 */
  readonly claudePluginDir?: string;
  /** Codex / Grok：追加到窗口说明末尾的技能清单。 */
  readonly instructions?: string;
  readonly report: WindowSkillsReport;
}

function safeWindowDirName(windowId: string): string {
  return windowId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 删一个挂载目录：先把里面的链接拆掉（只删链接本身），再删剩下的。 */
export async function removeMountDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    return;
  }
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of await readdir(skillsDir)) {
      const link = join(skillsDir, entry);
      const info = await lstat(link);
      if (info.isSymbolicLink()) {
        await unlink(link);
      }
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** 同上，同步版：退出时 will-quit 不等异步收尾，进程退出前要删完。 */
export function removeMountDirSync(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const link = join(skillsDir, entry);
      if (lstatSync(link).isSymbolicLink()) {
        unlinkSync(link);
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

export class SkillMountRegistry {
  private readonly byWindow = new Map<string, string>();

  constructor(private readonly mountsDir: string) {}

  /** 按计划给这个窗口准备挂载。之前的挂载先拆掉（重启窗口时会再来一次）。 */
  async prepare(
    windowId: string,
    runtime: SkillRuntime,
    plan: SkillMountPlan,
  ): Promise<PreparedSkillMount> {
    await this.release(windowId);
    const skipped: WindowSkillsReport["skipped"][number][] = [...plan.skipped];
    if (plan.mount.length === 0) {
      return { report: { mounted: [], skipped } };
    }
    if (runtime !== "claude-code") {
      const instructions = composeSkillInstructions(plan.mount);
      return {
        ...(instructions !== undefined ? { instructions } : {}),
        report: { mounted: plan.mount.map((skill) => skill.name), skipped },
      };
    }
    const dir = join(this.mountsDir, safeWindowDirName(windowId));
    await removeMountDir(dir);
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: CLAUDE_SKILL_PLUGIN_NAME,
          version: "1.0.0",
          description: "Skills enabled for this project in FF-pane",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    this.byWindow.set(windowId, dir);
    const mounted: string[] = [];
    for (const skill of plan.mount) {
      try {
        await symlink(skill.dir, join(dir, "skills", skill.name), "junction");
        mounted.push(skill.name);
      } catch {
        skipped.push({ name: skill.name, reason: "mount-failed" });
      }
    }
    if (mounted.length === 0) {
      await this.release(windowId);
      return { report: { mounted, skipped } };
    }
    return { claudePluginDir: dir, report: { mounted, skipped } };
  }

  async release(windowId: string): Promise<void> {
    const dir = this.byWindow.get(windowId);
    if (dir === undefined) {
      return;
    }
    this.byWindow.delete(windowId);
    await removeMountDir(dir);
  }

  /** 退出时用：同步删掉所有挂载目录，出错跳过。 */
  releaseAllSync(): void {
    for (const [windowId, dir] of [...this.byWindow.entries()]) {
      this.byWindow.delete(windowId);
      try {
        removeMountDirSync(dir);
      } catch {
        // 下次启动 cleanStale 再清
      }
    }
  }

  async releaseAll(): Promise<void> {
    for (const windowId of [...this.byWindow.keys()]) {
      await this.release(windowId);
    }
  }

  /** 启动时清掉上次没来得及删的挂载目录（崩溃、强退留下的）。 */
  async cleanStale(): Promise<void> {
    if (!existsSync(this.mountsDir)) {
      return;
    }
    for (const entry of await readdir(this.mountsDir)) {
      const dir = join(this.mountsDir, entry);
      if (![...this.byWindow.values()].includes(dir)) {
        await removeMountDir(dir);
      }
    }
  }
}
