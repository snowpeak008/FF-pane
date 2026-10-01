/**
 * 工作台布局持久化单测（T10.2）。
 */

import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWorkbenchLayout } from "@ff-pane/shared";
import {
  createWorkbenchLayoutStore,
  parseWorkbenchLayoutsFileStrict,
  stripRuntimeFields,
  WORKBENCH_LAYOUTS_FILE_VERSION,
} from "@ff-pane/storage";
import { afterEach, describe, expect, it } from "vitest";

let tempRoot: string;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function sampleLayout(projectId: string): ProjectWorkbenchLayout {
  return {
    projectId: projectId as ProjectWorkbenchLayout["projectId"],
    tabs: [
      {
        id: "tab-1",
        title: "Tab 1",
        root: { type: "leaf", windowId: "win-1" },
      },
    ],
    activeTabId: "tab-1",
    windows: {
      "win-1": {
        id: "win-1",
        projectId: projectId as ProjectWorkbenchLayout["projectId"],
        title: "Shell 1",
        kind: "shell",
        cwd: "C:\\proj",
        terminalId: "pty-should-strip",
        createdAt: 1,
      },
    },
    maximizedWindowId: null,
    focusedWindowId: "win-1",
  };
}

describe("workbench layout store", () => {
  it("原子写入并剥离 terminalId", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    const store = createWorkbenchLayoutStore(file);
    await store.saveProject(sampleLayout("proj-a"));
    const read = await store.readProject("proj-a" as ProjectWorkbenchLayout["projectId"]);
    expect(read?.windows["win-1"]?.terminalId).toBeUndefined();
    expect(stripRuntimeFields(sampleLayout("proj-a")).windows["win-1"]?.terminalId).toBeUndefined();
  });

  it("损坏 JSON 回退空表", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    await writeFile(file, "{not-json", "utf8");
    const store = createWorkbenchLayoutStore(file);
    expect(await store.readAll()).toEqual({});
  });

  it("严格解析拒绝坏 version", () => {
    expect(() => parseWorkbenchLayoutsFileStrict("x", { version: 99, layouts: {} })).toThrow(
      /version/,
    );
    expect(
      parseWorkbenchLayoutsFileStrict("x", {
        version: WORKBENCH_LAYOUTS_FILE_VERSION,
        layouts: {},
      }).layouts,
    ).toEqual({});
  });

  it("读取 v1 shell 布局并写出为 v2；接受 claude/codex 字段", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        layouts: {
          "proj-a": {
            projectId: "proj-a",
            tabs: [{ id: "tab-1", title: "Tab 1", root: { type: "leaf", windowId: "win-1" } }],
            activeTabId: "tab-1",
            windows: {
              "win-1": {
                id: "win-1",
                projectId: "proj-a",
                title: "Shell 1",
                kind: "shell",
                cwd: "C:\\proj",
                createdAt: 1,
              },
            },
            maximizedWindowId: null,
            focusedWindowId: "win-1",
          },
        },
      }),
      "utf8",
    );
    const store = createWorkbenchLayoutStore(file);
    const all = await store.readAll();
    expect(all["proj-a"]?.windows["win-1"]?.kind).toBe("shell");

    await store.saveProject({
      projectId: "proj-a" as ProjectWorkbenchLayout["projectId"],
      tabs: [{ id: "tab-1", title: "Tab 1", root: { type: "leaf", windowId: "win-2" } }],
      activeTabId: "tab-1",
      windows: {
        "win-2": {
          id: "win-2",
          projectId: "proj-a" as ProjectWorkbenchLayout["projectId"],
          title: "Claude 1",
          kind: "claude",
          cwd: "C:\\proj",
          createdAt: 2,
          profileId: "prof-1",
          nativeSessionId: "11111111-1111-4111-8111-111111111111",
          conversations: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              startedAt: 2,
              lastActiveAt: 3,
            },
          ],
        },
      },
      maximizedWindowId: null,
      focusedWindowId: "win-2",
    });
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")) as {
      version: number;
      layouts: Record<string, ProjectWorkbenchLayout>;
    };
    expect(raw.version).toBe(WORKBENCH_LAYOUTS_FILE_VERSION);
    expect(raw.layouts["proj-a"]?.windows["win-2"]?.profileId).toBeUndefined();
    expect(raw.layouts["proj-a"]?.windows["win-2"]?.nativeSessionId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(raw.layouts["proj-a"]?.windows["win-2"]?.conversations).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: 2,
        lastActiveAt: 3,
      },
    ]);
  });

  it("v3 无 role 或非法 role 仍能读出窗口", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        layouts: {
          "proj-a": {
            projectId: "proj-a",
            tabs: [{ id: "tab-1", title: "Tab 1", root: { type: "leaf", windowId: "win-1" } }],
            activeTabId: "tab-1",
            windows: {
              "win-1": {
                id: "win-1",
                projectId: "proj-a",
                title: "Claude",
                kind: "claude",
                cwd: "C:\\proj",
                createdAt: 1,
                profileId: "prof-1",
                permission: "edit",
                openedBy: "user",
              },
              "win-2": {
                id: "win-2",
                projectId: "proj-a",
                title: "Bad role",
                kind: "codex",
                cwd: "C:\\proj",
                createdAt: 2,
                profileId: "prof-2",
                role: "boss",
              },
            },
            maximizedWindowId: null,
            focusedWindowId: "win-1",
          },
        },
      }),
      "utf8",
    );
    const store = createWorkbenchLayoutStore(file);
    const all = await store.readAll();
    expect(all["proj-a"]?.windows["win-1"]?.role).toBeUndefined();
    expect(all["proj-a"]?.windows["win-1"]?.profileId).toBeUndefined();
    expect(all["proj-a"]?.windows["win-2"]?.kind).toBe("codex");
    expect(all["proj-a"]?.windows["win-2"]?.role).toBeUndefined();
    expect(all["proj-a"]?.windows["win-2"]?.profileId).toBeUndefined();
  });

  it("removeProject 删条目", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    const store = createWorkbenchLayoutStore(file);
    await store.saveProject(sampleLayout("proj-a"));
    await store.removeProject("proj-a" as ProjectWorkbenchLayout["projectId"]);
    expect(await store.readAll()).toEqual({});
  });
});
