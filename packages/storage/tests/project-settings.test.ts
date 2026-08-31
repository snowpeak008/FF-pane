/**
 * 项目级 project.json store 单测（T6.6）：走 mkdtemp 临时目录真实读写。
 * 覆盖：缺文件补缺省、首次 update 建档、非破坏性合并（保留未知键）、
 * 坏类型按缺省处理、结构不符抛错、与 resolveProjectLayout 接线一致。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectSettingsStore,
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_SETTINGS_FILE_VERSION,
  ProjectSettingsFileInvalidError,
  type ProjectSettingsStore,
  resolveProjectLayout,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let projectFile: string;
let store: ProjectSettingsStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-project-settings-"));
  projectFile = resolveProjectLayout(tempRoot).projectFile;
  store = createProjectSettingsStore(projectFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ProjectSettingsStore", () => {
  it("首次使用：文件不存在时读出缺省（工具关闭），不建档", async () => {
    expect(await store.readSettings()).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(DEFAULT_PROJECT_SETTINGS.knowledgeToolEnabled).toBe(false);
    await expect(readFile(projectFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("update：首次写入即建档，读回合并结果", async () => {
    const merged = await store.updateSettings({ knowledgeToolEnabled: true });
    expect(merged.knowledgeToolEnabled).toBe(true);
    expect(await store.readSettings()).toEqual({ knowledgeToolEnabled: true });
  });

  it("落盘形状为 { version, project }", async () => {
    await store.updateSettings({ knowledgeToolEnabled: true });
    const raw = JSON.parse(await readFile(projectFile, "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe(PROJECT_SETTINGS_FILE_VERSION);
    expect(raw["project"]).toMatchObject({ knowledgeToolEnabled: true });
  });

  it("非破坏性：写入不抹掉别的工单写进 project 的未知字段", async () => {
    // 模拟别的工单（角色绑定 / 权限策略）已经写过 project.json
    await writeJsonAtomic(projectFile, {
      version: PROJECT_SETTINGS_FILE_VERSION,
      project: {
        id: "proj-1",
        name: "示例项目",
        roleBindings: { planner: "p1", worker: "p2" },
        outputLanguage: "en-US",
      },
    });

    await store.updateSettings({ knowledgeToolEnabled: true });

    const raw = JSON.parse(await readFile(projectFile, "utf8")) as {
      project: Record<string, unknown>;
    };
    expect(raw.project).toEqual({
      id: "proj-1",
      name: "示例项目",
      roleBindings: { planner: "p1", worker: "p2" },
      outputLanguage: "en-US",
      knowledgeToolEnabled: true,
    });
  });

  it("反复开关不累积破坏：未知字段在多次写入后依然完整", async () => {
    await writeJsonAtomic(projectFile, {
      version: PROJECT_SETTINGS_FILE_VERSION,
      project: { roleBindings: { planner: "p1", worker: "p2" } },
    });
    await store.updateSettings({ knowledgeToolEnabled: true });
    await store.updateSettings({ knowledgeToolEnabled: false });
    await store.updateSettings({ knowledgeToolEnabled: true });

    const raw = JSON.parse(await readFile(projectFile, "utf8")) as {
      project: Record<string, unknown>;
    };
    expect(raw.project["roleBindings"]).toEqual({ planner: "p1", worker: "p2" });
    expect(raw.project["knowledgeToolEnabled"]).toBe(true);
  });

  it("字段类型不符按缺省处理（不抛错）：开关手改坏了不该让项目打不开", async () => {
    await writeJsonAtomic(projectFile, {
      version: PROJECT_SETTINGS_FILE_VERSION,
      project: { knowledgeToolEnabled: "yes" },
    });
    expect(await store.readSettings()).toEqual({ knowledgeToolEnabled: false });
  });

  it("结构不符抛 ProjectSettingsFileInvalidError：顶层非对象", async () => {
    await writeTextAtomic(projectFile, "[]");
    await expect(store.readSettings()).rejects.toBeInstanceOf(ProjectSettingsFileInvalidError);
  });

  it("结构不符抛 ProjectSettingsFileInvalidError：version 不支持", async () => {
    await writeJsonAtomic(projectFile, { version: 99, project: {} });
    await expect(store.readSettings()).rejects.toBeInstanceOf(ProjectSettingsFileInvalidError);
  });

  it("结构不符抛 ProjectSettingsFileInvalidError：project 非对象", async () => {
    await writeJsonAtomic(projectFile, { version: PROJECT_SETTINGS_FILE_VERSION, project: 1 });
    await expect(store.readSettings()).rejects.toBeInstanceOf(ProjectSettingsFileInvalidError);
  });

  it("JSON 语法损坏由 fs 层隔离并上抛", async () => {
    await writeTextAtomic(projectFile, "{ 坏掉的 json");
    await expect(store.readSettings()).rejects.toMatchObject({ code: "corrupt-json" });
  });
});
