import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfigId, ProjectId, ProviderId } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultProjectConfigDraft,
  configReferencesProvider,
  createProjectConfigStore,
  DEFAULT_PROJECT_CONFIG_NAME,
  ProjectConfigDefaultRequiredError,
  ProjectConfigDraftInvalidError,
  ProjectConfigLastError,
  type ProjectConfigStore,
  resolveGlobalLayout,
} from "../src/index.js";

let tempRoot: string;
let store: ProjectConfigStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-configs-"));
  store = createProjectConfigStore(resolveGlobalLayout(join(tempRoot, ".aiworkbench")).configsFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("project configs", () => {
  it("首次 ensure 写出两边本机登录、模型强度权限都空、所有项目可用", async () => {
    const created = await store.ensureDefaultConfig();
    expect(created.name).toBe(DEFAULT_PROJECT_CONFIG_NAME);
    expect(created.isDefault).toBe(true);
    expect(created.projectIds).toBeUndefined();
    expect(created.defaultPermission).toBeUndefined();
    expect(created.claude).toEqual({ connectionMode: "local_cli" });
    expect(created.codex).toEqual({ connectionMode: "local_cli" });
    expect(buildDefaultProjectConfigDraft().claude).toEqual({ connectionMode: "local_cli" });
    const again = await store.ensureDefaultConfig();
    expect(again.id).toBe(created.id);
    expect(await store.listConfigs()).toHaveLength(1);
  });

  it("可以只配一路，本机登录不保存来源", async () => {
    const created = await store.createConfig({
      name: "只开 Claude",
      isDefault: true,
      claude: { connectionMode: "local_cli", providerId: "prov" as ProviderId, model: "  " },
    });
    expect(created.codex).toBeUndefined();
    expect(created.claude).toEqual({ connectionMode: "local_cli" });
  });

  it("删默认必须换默认，最后一张不能删", async () => {
    const first = await store.ensureDefaultConfig();
    const second = await store.createConfig({
      name: "第二张",
      isDefault: false,
      codex: { connectionMode: "local_cli" },
    });
    await expect(store.deleteConfig(first.id)).rejects.toBeInstanceOf(
      ProjectConfigDefaultRequiredError,
    );
    await store.deleteConfig(first.id, second.id);
    const left = await store.listConfigs();
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(second.id);
    expect(left[0]?.isDefault).toBe(true);
    await expect(store.deleteConfig(second.id)).rejects.toBeInstanceOf(ProjectConfigLastError);
  });

  it("空名和两路都空会被拒绝且不落盘", async () => {
    await expect(
      store.createConfig({ name: "  ", isDefault: true, claude: { connectionMode: "local_cli" } }),
    ).rejects.toBeInstanceOf(ProjectConfigDraftInvalidError);
    await expect(store.createConfig({ name: "空", isDefault: true })).rejects.toBeInstanceOf(
      ProjectConfigDraftInvalidError,
    );
    expect(await store.listConfigs()).toHaveLength(0);
  });

  it("中转来源引用可被删除保护看到", async () => {
    const created = await store.createConfig({
      name: "中转",
      isDefault: true,
      codex: { connectionMode: "relay", providerId: "prov-1" as ProviderId },
    });
    expect(configReferencesProvider([created], "prov-1" as ProviderId)).toBe(true);
    expect(configReferencesProvider([created], "other" as ProviderId)).toBe(false);
    const file = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).configsFile;
    const raw = JSON.parse(await readFile(file, "utf8")) as { configs: { id: string }[] };
    expect(raw.configs[0]?.id).toBe(created.id);
    expect(created.id.startsWith("config-")).toBe(true);
    void (created.projectIds as readonly ProjectId[] | undefined);
    void (created.id as ProjectConfigId);
  });

  it("只有 DeepSeek 引用的来源也算还在用，不能当成没人用", async () => {
    const created = await store.createConfig({
      name: "只有 DeepSeek",
      isDefault: true,
      deepseek: {
        connectionMode: "relay",
        providerId: "prov-ds" as ProviderId,
        model: "deepseek-flash",
      },
    });
    expect(configReferencesProvider([created], "prov-ds" as ProviderId)).toBe(true);
    expect(configReferencesProvider([created], "other" as ProviderId)).toBe(false);
  });

  it("默认配置不能带范围；设为默认或接替默认时清空范围", async () => {
    const first = await store.ensureDefaultConfig();
    await expect(
      store.updateConfig(first.id, {
        name: first.name,
        isDefault: true,
        projectIds: ["proj-a" as ProjectId],
        claude: { connectionMode: "local_cli" },
      }),
    ).rejects.toBeInstanceOf(ProjectConfigDraftInvalidError);
    expect((await store.getConfig(first.id))?.projectIds).toBeUndefined();

    await expect(
      store.createConfig({
        name: "带范围的默认",
        isDefault: true,
        projectIds: ["proj-a" as ProjectId],
        claude: { connectionMode: "local_cli" },
      }),
    ).rejects.toBeInstanceOf(ProjectConfigDraftInvalidError);

    const narrow = await store.createConfig({
      name: "窄",
      isDefault: false,
      projectIds: ["proj-a" as ProjectId],
      codex: { connectionMode: "local_cli" },
    });
    expect(narrow.projectIds).toEqual(["proj-a"]);

    const promoted = await store.setDefaultConfig(narrow.id);
    expect(promoted.isDefault).toBe(true);
    expect(promoted.projectIds).toBeUndefined();
    expect((await store.getConfig(first.id))?.isDefault).toBe(false);

    const again = await store.createConfig({
      name: "再窄",
      isDefault: false,
      projectIds: ["proj-b" as ProjectId],
      claude: { connectionMode: "local_cli" },
    });
    await store.deleteConfig(promoted.id, again.id);
    const left = await store.listConfigs();
    const successor = left.find((item) => item.id === again.id);
    expect(successor?.isDefault).toBe(true);
    expect(successor?.projectIds).toBeUndefined();
  });
});
