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

  it("removeProject 删条目", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ffpane-wb-layout-"));
    const file = join(tempRoot, "workbench-layouts.json");
    const store = createWorkbenchLayoutStore(file);
    await store.saveProject(sampleLayout("proj-a"));
    await store.removeProject("proj-a" as ProjectWorkbenchLayout["projectId"]);
    expect(await store.readAll()).toEqual({});
  });
});
