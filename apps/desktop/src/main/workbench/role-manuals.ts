/**
 * 角色说明书读取、覆盖副本与 Claude 临时提示文件（T10.6）。
 * 覆盖副本优先；none 合成时只要 base。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeWorkbenchSystemPrompt } from "@ff-pane/core";
import {
  isWorkbenchRoleManualId,
  WORKBENCH_ROLE_MANUAL_IDS,
  type WorkbenchRole,
  type WorkbenchRoleManualId,
} from "@ff-pane/shared";
import { writeTextAtomic } from "@ff-pane/storage";

/** 覆盖副本上限（留出 Codex -c 与其它参数的命令行余量）。 */
export const MAX_ROLE_MANUAL_OVERRIDE_CHARS = 8 * 1024;

const ROLE_PROMPT_DIR_NAME = "ffpane-workbench-role-prompts";

export interface RoleManualView {
  readonly id: WorkbenchRoleManualId;
  readonly content: string;
  readonly defaultContent: string;
  readonly source: "override" | "default";
  readonly path: string;
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function bundledPath(resourcesDir: string, id: WorkbenchRoleManualId): string {
  return join(resourcesDir, `${id}.md`);
}

function overridePath(overridesDir: string, id: WorkbenchRoleManualId): string {
  return join(overridesDir, `${id}.md`);
}

/** 非空覆盖副本优先，否则用打包资源。返回实际采用的绝对路径与正文。 */
export async function resolveRoleManual(
  resourcesDir: string,
  overridesDir: string,
  id: WorkbenchRoleManualId,
): Promise<{
  readonly content: string;
  readonly path: string;
  readonly source: "override" | "default";
}> {
  const bundled = bundledPath(resourcesDir, id);
  const override = overridePath(overridesDir, id);
  const overrideText = await readTextIfPresent(override);
  if (overrideText !== undefined && overrideText.trim().length > 0) {
    return { content: overrideText, path: override, source: "override" };
  }
  const bundledText = await readTextIfPresent(bundled);
  if (bundledText === undefined) {
    throw new Error(`workbench role manual missing: ${bundled}`);
  }
  return { content: bundledText, path: bundled, source: "default" };
}

export async function listRoleManuals(
  resourcesDir: string,
  overridesDir: string,
): Promise<readonly RoleManualView[]> {
  const views: RoleManualView[] = [];
  for (const id of WORKBENCH_ROLE_MANUAL_IDS) {
    const resolved = await resolveRoleManual(resourcesDir, overridesDir, id);
    const bundled = await readTextIfPresent(bundledPath(resourcesDir, id));
    views.push({
      id,
      content: resolved.content,
      defaultContent: bundled ?? "",
      source: resolved.source,
      path: resolved.path,
    });
  }
  return views;
}

export async function saveRoleManualOverride(
  overridesDir: string,
  id: WorkbenchRoleManualId,
  content: string,
): Promise<void> {
  if (!isWorkbenchRoleManualId(id)) {
    throw new Error("unknown role manual");
  }
  if (content.trim().length === 0) {
    throw new Error("role manual override is empty");
  }
  if (content.length > MAX_ROLE_MANUAL_OVERRIDE_CHARS) {
    throw new Error(`role manual override exceeds ${MAX_ROLE_MANUAL_OVERRIDE_CHARS} characters`);
  }
  const normalized = content.replace(/\r\n/g, "\n");
  await writeTextAtomic(
    overridePath(overridesDir, id),
    normalized.endsWith("\n") ? normalized : `${normalized}\n`,
  );
}

export async function resetRoleManualOverride(
  overridesDir: string,
  id: WorkbenchRoleManualId,
): Promise<void> {
  await rm(overridePath(overridesDir, id), { force: true });
}

/** 运行中改角色时，让 AI 去读的那份说明书绝对路径。none 读 base。 */
export async function resolveRoleSwitchManualPath(
  resourcesDir: string,
  overridesDir: string,
  role: WorkbenchRole,
): Promise<string> {
  const id: WorkbenchRoleManualId = role === "none" ? "base" : role;
  const resolved = await resolveRoleManual(resourcesDir, overridesDir, id);
  return resolved.path;
}

/** 系统提示 = base + 角色说明书（none 只有 base）。覆盖副本优先。 */
export async function composeWindowRolePrompt(
  resourcesDir: string,
  overridesDir: string,
  role: WorkbenchRole,
): Promise<string> {
  const base = await resolveRoleManual(resourcesDir, overridesDir, "base");
  if (role === "none") {
    return composeWorkbenchSystemPrompt({ base: base.content, role });
  }
  const manual = await resolveRoleManual(resourcesDir, overridesDir, role);
  return composeWorkbenchSystemPrompt({
    base: base.content,
    role,
    roleManual: manual.content,
  });
}

export function rolePromptTempDir(): string {
  return join(tmpdir(), ROLE_PROMPT_DIR_NAME);
}

/** Claude `--append-system-prompt-file` 用的按窗口临时文件。无密钥。 */
export function writeClaudeRolePromptFile(windowId: string, text: string): string {
  const dir = rolePromptTempDir();
  mkdirSync(dir, { recursive: true });
  const safe = windowId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(dir, `${safe}.md`);
  const body = text.replace(/\r\n/g, "\n");
  writeFileSync(filePath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return filePath;
}

export class RolePromptTempRegistry {
  private readonly byWindow = new Map<string, string>();

  track(windowId: string, filePath: string): void {
    this.byWindow.set(windowId, filePath);
  }

  async release(windowId: string): Promise<void> {
    const filePath = this.byWindow.get(windowId);
    if (filePath === undefined) {
      return;
    }
    this.byWindow.delete(windowId);
    await rm(filePath, { force: true });
  }

  async releaseAll(): Promise<void> {
    const ids = [...this.byWindow.keys()];
    for (const id of ids) {
      await this.release(id);
    }
  }
}

export const WORKBENCH_ROLE_LABEL: Readonly<Record<WorkbenchRole, string>> = {
  manager: "管理者",
  planner: "规划",
  worker: "执行",
  reviewer: "检查",
  supervisor: "监管者",
  none: "普通",
};

/** 运行中切换角色时写入 PTY 的一行（不含换行）。 */
export function buildRoleSwitchLine(role: WorkbenchRole, manualPath: string): string {
  const line = `[FF-pane] 你的角色已设为${WORKBENCH_ROLE_LABEL[role]}，请先阅读 ${manualPath} 并按其行事`;
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error("role switch line must not contain newlines");
  }
  return line;
}
