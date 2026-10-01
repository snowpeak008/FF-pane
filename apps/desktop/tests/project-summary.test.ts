/**
 * 项目摘要：界面不再读旧计划 / 任务 / 会话。
 * 只回答「这个项目有没有 .workbench」。磁盘上的旧文件留着，也不去打开。
 */

import type { ProjectRegistryEntry } from "@ff-pane/shared";
import type { ProjectLayout } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";
import {
  type ProjectSummarySources,
  summarizeProject,
  summarizeProjects,
} from "../src/main/project-summary";

function layoutOf(rootPath: string): ProjectLayout {
  return { projectRootDir: rootPath, workbenchDir: `${rootPath}/.workbench` } as ProjectLayout;
}

function entry(overrides: Partial<Record<keyof ProjectRegistryEntry, unknown>> = {}) {
  return {
    id: "proj-1",
    name: "项目一",
    rootPath: "/tmp/p1",
    createdAt: 1,
    ...overrides,
  } as unknown as ProjectRegistryEntry;
}

function sources(
  workbenchPresent: ProjectSummarySources["workbenchPresent"],
): ProjectSummarySources {
  return {
    workbenchPresent,
    resolveLayout: layoutOf,
  };
}

describe("summarizeProject", () => {
  it("没有 .workbench 时如实标缺失", async () => {
    const summary = await summarizeProject(
      layoutOf("/tmp/p1"),
      sources(async () => false),
    );
    expect(summary.workbenchPresent).toBe(false);
    expect(summary.planVersion).toBeUndefined();
    expect(summary.activeTaskCount).toBe(0);
    expect(summary.unavailable).toEqual([]);
  });

  it("有 .workbench 时只报告目录在，不把旧计划当成当前工作", async () => {
    const summary = await summarizeProject(
      layoutOf("/tmp/p1"),
      sources(async () => true),
    );
    expect(summary).toMatchObject({
      workbenchPresent: true,
      activeTaskCount: 0,
      taskCount: 0,
      unavailable: [],
    });
    expect(summary.planVersion).toBeUndefined();
    expect(summary.lastActivityAt).toBeUndefined();
  });
});

describe("summarizeProjects", () => {
  it("一个项目路径解析失败不影响另一个", async () => {
    const views = await summarizeProjects(
      [entry({ id: "ok", rootPath: "/tmp/ok" }), entry({ id: "bad", rootPath: "/tmp/bad" })],
      {
        ...sources(async () => true),
        resolveLayout: (root) => {
          if (root.endsWith("/bad")) {
            throw new Error("disk");
          }
          return layoutOf(root);
        },
      },
    );
    expect(views[0]?.summary.workbenchPresent).toBe(true);
    expect(views[1]?.summary.unavailable).toEqual(["plan", "task", "run", "session"]);
  });
});
