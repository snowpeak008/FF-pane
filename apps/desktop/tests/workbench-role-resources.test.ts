/**
 * T10.6：角色说明书资源路径、覆盖副本优先、打包 extraResources。
 */

import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKBENCH_ROLE_MANUAL_IDS } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeWindowRolePrompt,
  resolveRoleManual,
  saveRoleManualOverride,
} from "../src/main/workbench/role-manuals";
import { resolveWorkbenchRoleResourcesDir } from "../src/main/workbench/role-resources";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const resourcesDir = join(desktopDir, "resources", "workbench-roles");

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("workbench role manuals", () => {
  it("五份说明书存在、LF、且不超过约 2KB", () => {
    const names = readdirSync(resourcesDir).sort();
    expect(names).toEqual(["base.md", "manager.md", "planner.md", "reviewer.md", "worker.md"]);
    for (const name of names) {
      const bytes = readFileSync(join(resourcesDir, name));
      expect(bytes.includes(13), name).toBe(false);
      expect(bytes.length, name).toBeLessThanOrEqual(2048);
    }
  });

  it("electron-builder 把 workbench-roles 打进 extraResources", () => {
    const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
    expect(yml).toContain("from: resources/workbench-roles");
    expect(yml).toContain("to: workbench-roles");
  });

  it("开发态走 appPath/resources，打包后走 resourcesPath", () => {
    expect(
      resolveWorkbenchRoleResourcesDir({
        isPackaged: false,
        resourcesPath: "C:\\unused",
        appPath: "D:\\app",
      }),
    ).toBe(join("D:\\app", "resources", "workbench-roles"));
    expect(
      resolveWorkbenchRoleResourcesDir({
        isPackaged: true,
        resourcesPath: "C:\\resources",
        appPath: "D:\\app",
      }),
    ).toBe(join("C:\\resources", "workbench-roles"));
  });

  it("覆盖副本优先；none 合成只有 base", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-role-override-"));
    const marker = "OVERRIDE-WORKER-MARKER";
    await saveRoleManualOverride(tempRoot, "worker", marker);
    const worker = await resolveRoleManual(resourcesDir, tempRoot, "worker");
    expect(worker.source).toBe("override");
    expect(worker.content).toContain(marker);
    const bundled = await resolveRoleManual(resourcesDir, join(tempRoot, "missing"), "worker");
    expect(bundled.source).toBe("default");
    expect(bundled.content).toContain("只改 brief 范围内的文件");

    const none = await composeWindowRolePrompt(resourcesDir, tempRoot, "none");
    expect(none).toContain("ffpane_read_inbox");
    expect(none).not.toContain(marker);
    expect(none).not.toContain("只改 brief 范围内的文件");

    const composed = await composeWindowRolePrompt(resourcesDir, tempRoot, "worker");
    expect(composed).toContain("ffpane_read_inbox");
    expect(composed).toContain(marker);
    expect(WORKBENCH_ROLE_MANUAL_IDS).toContain("worker");
  });
});
