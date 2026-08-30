/**
 * 项目注册表单测（W3.3 后端）：走 mkdtemp 临时目录真实读写。
 * 覆盖：首次使用空集、add round-trip（含中文 name）、rootPath 去重、
 * remove 返回被移条目 + not-found、restore 幂等、W1.2a 损坏隔离语义的向上传递、
 * 与 resolveGlobalLayout 的接线路径一致性。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpochMillis, ProjectId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectRegistry,
  PROJECTS_FILE_VERSION,
  ProjectAlreadyRegisteredError,
  ProjectNotFoundError,
  type ProjectRegistry,
  ProjectsFileInvalidError,
  resolveGlobalLayout,
  StorageCorruptJsonError,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let projectsFile: string;
let registry: ProjectRegistry;
/** 递增假时钟：让 createdAt 断言确定，且保证登记顺序稳定。 */
let clock: EpochMillis;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-projects-"));
  // 走 W1.2a 布局的规范路径，验证与 resolveGlobalLayout 的接线方式
  projectsFile = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).projectsFile;
  clock = 1_000;
  registry = createProjectRegistry(projectsFile, () => {
    clock += 1;
    return clock;
  });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
  it("首次使用：文件不存在时 list 返回空集，不建档", async () => {
    expect(await registry.listProjects()).toEqual([]);
    await expect(readFile(projectsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("add：登记新项目，id 由本层生成、createdAt 走注入时钟、落盘可读回", async () => {
    const created = await registry.addProject({ name: "示例项目", rootPath: "/repos/demo" });
    expect(created.id).toMatch(/^project-[0-9a-f]{12}$/);
    expect(created.name).toBe("示例项目");
    expect(created.rootPath).toBe("/repos/demo");
    expect(created.createdAt).toBe(1_001);

    const listed = await registry.listProjects();
    expect(listed).toEqual([created]);

    const onDisk = JSON.parse(await readFile(projectsFile, "utf8")) as unknown;
    expect(onDisk).toEqual({ version: PROJECTS_FILE_VERSION, projects: [created] });
  });

  it("add：同一 rootPath 重复登记抛 ProjectAlreadyRegisteredError，且不改动文件", async () => {
    await registry.addProject({ name: "first", rootPath: "/repos/demo" });
    const before = await readFile(projectsFile, "utf8");
    await expect(registry.addProject({ name: "dup", rootPath: "/repos/demo" })).rejects.toThrow(
      ProjectAlreadyRegisteredError,
    );
    expect(await readFile(projectsFile, "utf8")).toBe(before);
  });

  it("add：多个项目按登记顺序累积，id 互不相同", async () => {
    const a = await registry.addProject({ name: "a", rootPath: "/repos/a" });
    const b = await registry.addProject({ name: "b", rootPath: "/repos/b" });
    const listed = await registry.listProjects();
    expect(listed.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it("remove：返回被移除条目、后续 list 不含它", async () => {
    const a = await registry.addProject({ name: "a", rootPath: "/repos/a" });
    const b = await registry.addProject({ name: "b", rootPath: "/repos/b" });
    const removed = await registry.removeProject(a.id);
    expect(removed).toEqual(a);
    expect(await registry.listProjects()).toEqual([b]);
  });

  it("remove：id 不存在抛 ProjectNotFoundError", async () => {
    await expect(registry.removeProject("project-deadbeef0000" as ProjectId)).rejects.toThrow(
      ProjectNotFoundError,
    );
  });

  it("restore：把被移除条目原样放回（保留 id 与 createdAt）", async () => {
    const a = await registry.addProject({ name: "a", rootPath: "/repos/a" });
    await registry.removeProject(a.id);
    const restored = await registry.restoreProject(a);
    expect(restored).toEqual(a);
    expect(await registry.listProjects()).toEqual([a]);
  });

  it("restore：幂等——id 或 rootPath 已存在时不重复插入", async () => {
    const a = await registry.addProject({ name: "a", rootPath: "/repos/a" });
    const restored = await registry.restoreProject(a);
    expect(restored).toEqual(a);
    expect(await registry.listProjects()).toEqual([a]);
  });

  it("结构不符：projects 非数组时抛 ProjectsFileInvalidError", async () => {
    await writeTextAtomic(
      projectsFile,
      JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: {} }),
    );
    await expect(registry.listProjects()).rejects.toThrow(ProjectsFileInvalidError);
  });

  it("版本不支持：抛 ProjectsFileInvalidError", async () => {
    await writeTextAtomic(projectsFile, JSON.stringify({ version: 999, projects: [] }));
    await expect(registry.listProjects()).rejects.toThrow(ProjectsFileInvalidError);
  });

  it("JSON 语法损坏：向上传递 W1.2a 的 StorageCorruptJsonError（并隔离原文件）", async () => {
    await writeTextAtomic(projectsFile, "{ not valid json");
    await expect(registry.listProjects()).rejects.toThrow(StorageCorruptJsonError);
  });
});
