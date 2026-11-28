import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectNamesOutsideScope, selectEffectiveProjectConfig } from "@ff-pane/shared";
import {
  createProjectConfigStore,
  createProjectSettingsStore,
  resolveGlobalLayout,
  resolveProjectLayout,
} from "@ff-pane/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  modelNotAllowedMessage,
  resolveProjectLaunchRoute,
} from "../src/main/workbench/resolve-config";

describe("项目配置选路", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("没绑定用默认；绑了就用那张；没配的一路明确失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "ff-pane-resolve-"));
    roots.push(root);
    const projectRoot = join(root, "proj");
    const configs = createProjectConfigStore(
      resolveGlobalLayout(join(root, ".aiworkbench")).configsFile,
    );
    const fallback = await configs.ensureDefaultConfig();
    const claudeOnly = await configs.createConfig({
      name: "只有 Claude",
      isDefault: false,
      claude: { connectionMode: "local_cli", model: "sonnet", reasoningEffort: "medium" },
    });
    await createProjectSettingsStore(resolveProjectLayout(projectRoot).projectFile).updateSettings({
      configId: claudeOnly.id,
    });

    const claude = await resolveProjectLaunchRoute({
      projectRoot,
      projectId: "proj-1",
      kind: "claude",
      configs,
      getProvider: async () => undefined,
    });
    expect(claude.ok).toBe(true);
    if (claude.ok) {
      expect(claude.route.connectionMode).toBe("local_cli");
      expect(claude.route.model).toBe("sonnet");
      expect(claude.route.reasoningEffort).toBe("medium");
      expect(claude.route.providerId).toBeUndefined();
      expect(claude.route.configId).toBe(claudeOnly.id);
    }

    const codex = await resolveProjectLaunchRoute({
      projectRoot,
      projectId: "proj-1",
      kind: "codex",
      configs,
      getProvider: async () => undefined,
    });
    expect(codex).toEqual({
      ok: false,
      error: "配置「只有 Claude」没有 Codex 这一路，不能开这个窗口。",
    });

    const deepseek = await resolveProjectLaunchRoute({
      projectRoot,
      projectId: "proj-1",
      kind: "deepseek",
      configs,
      getProvider: async () => undefined,
    });
    expect(deepseek).toEqual({
      ok: false,
      error: "配置「只有 Claude」没有 DeepSeek 这一路，不能开这个窗口。",
    });

    // T11.18：Cursor 这一路没填模型时用设置里的默认（auto），不再让 Cursor 用它自己记的默认。
    const cursor = await resolveProjectLaunchRoute({
      projectRoot,
      projectId: "proj-1",
      kind: "cursor",
      configs,
      getProvider: async () => undefined,
      cursorDefaultModel: "auto",
    });
    expect(cursor.ok && cursor.route.model).toBe("auto");
    const claudeIgnoresCursorDefault = await resolveProjectLaunchRoute({
      projectRoot,
      projectId: "proj-1",
      kind: "claude",
      configs,
      getProvider: async () => undefined,
      cursorDefaultModel: "auto",
    });
    expect(claudeIgnoresCursorDefault.ok && claudeIgnoresCursorDefault.route.model).toBe("sonnet");

    const unbound = await resolveProjectLaunchRoute({
      projectRoot: join(root, "other"),
      projectId: "proj-2",
      kind: "codex",
      configs,
      getProvider: async () => undefined,
    });
    expect(unbound.ok).toBe(true);
    if (unbound.ok) {
      expect(unbound.route.configId).toBe(fallback.id);
      expect(unbound.route.connectionMode).toBe("local_cli");
    }
  });

  it("范围外的绑定不拿来开窗口，收窄时点名名单外的项目", () => {
    const configs = [
      { id: "wide", isDefault: true },
      { id: "narrow", isDefault: false, projectIds: ["a"] },
    ];
    expect(selectEffectiveProjectConfig(configs, "narrow", "b")?.id).toBe("wide");
    expect(selectEffectiveProjectConfig(configs, "narrow", "a")?.id).toBe("narrow");
    const scopedDefault = [
      { id: "wide", isDefault: true, projectIds: ["a"] },
      { id: "narrow", isDefault: false, projectIds: ["a"] },
    ];
    expect(selectEffectiveProjectConfig(scopedDefault, undefined, "b")?.id).toBe("wide");
    expect(selectEffectiveProjectConfig(scopedDefault, "narrow", "b")?.id).toBe("wide");
    expect(
      projectNamesOutsideScope(
        [
          { id: "a", name: "甲" },
          { id: "b", name: "乙" },
        ],
        ["a"],
      ),
    ).toEqual(["乙"]);
    expect(projectNamesOutsideScope([{ id: "b", name: "乙" }], undefined)).toEqual([]);
  });
});

describe("本机登录来源限制模型（计划 docs/本机登录来源限制模型计划.md）", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const SOURCE = {
    id: "src-1",
    name: "agy---codex谷歌号",
    templateId: "local-login",
    enabled: true,
    models: [
      { id: "m-a", kind: "chat" as const },
      { id: "m-b", kind: "chat" as const },
      { id: "emb-1", kind: "embedding" as const },
    ],
  };

  async function setup(
    route: { model?: string; providerId?: string } | undefined,
  ): Promise<{ run: (source: unknown) => ReturnType<typeof resolveProjectLaunchRoute> }> {
    const root = await mkdtemp(join(tmpdir(), "ff-pane-source-"));
    roots.push(root);
    const configs = createProjectConfigStore(
      resolveGlobalLayout(join(root, ".aiworkbench")).configsFile,
    );
    await configs.createConfig({
      name: "默认",
      isDefault: true,
      gemini:
        route === undefined
          ? { connectionMode: "local_cli" }
          : { connectionMode: "local_cli", ...(route as object) },
    } as never);
    return {
      run: (source) =>
        resolveProjectLaunchRoute({
          projectRoot: join(root, "proj"),
          projectId: "proj-1",
          kind: "gemini",
          configs,
          getProvider: async () => source as never,
        }),
    };
  }

  it("不选来源：和以前一样，不限制，模型原样带上", async () => {
    const { run } = await setup({ model: "anything" });
    const result = await run(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.model).toBe("anything");
      expect(result.route.providerId).toBeUndefined();
      expect(result.route.allowedModels).toBeUndefined();
    }
  });

  it("选了来源：允许集合是来源里的对话模型（嵌入模型不算）；指定的在里面就通过", async () => {
    const { run } = await setup({ providerId: "src-1", model: "m-b" });
    const result = await run(SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.model).toBe("m-b");
      expect(result.route.providerId).toBe("src-1");
      expect(result.route.providerName).toBe("agy---codex谷歌号");
      expect(result.route.allowedModels).toEqual(["m-a", "m-b"]);
      expect(result.route.connectionMode).toBe("local_cli");
    }
  });

  it("指定了不在来源清单里的模型：拒绝，并说清楚允许哪些", async () => {
    const { run } = await setup({ providerId: "src-1", model: "other" });
    const result = await run(SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("other");
      expect(result.error).toContain("agy---codex谷歌号");
      expect(result.error).toContain("m-a");
      expect(result.error).toContain("m-b");
    }
  });

  it("没指定模型：用来源的默认模型；没默认就不传，让 CLI 自己用默认（不检查、不提示）", async () => {
    const withDefault = await setup({ providerId: "src-1" });
    const a = await withDefault.run({ ...SOURCE, defaultModelId: "m-a" });
    expect(a.ok && a.route.model).toBe("m-a");
    const noDefault = await setup({ providerId: "src-1" });
    const b = await noDefault.run(SOURCE);
    expect(b.ok).toBe(true);
    expect(b.ok && b.route.model).toBeUndefined();
    // 默认模型不在清单里（数据漂移）：不用它，也不报错
    const drift = await setup({ providerId: "src-1" });
    const c = await drift.run({ ...SOURCE, defaultModelId: "gone" });
    expect(c.ok).toBe(true);
    expect(c.ok && c.route.model).toBeUndefined();
  });

  it("清单为空 = 不限制：任何模型都能开，也不带 allowedModels", async () => {
    const { run } = await setup({ providerId: "src-1", model: "whatever" });
    const result = await run({ ...SOURCE, models: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.model).toBe("whatever");
      expect(result.route.allowedModels).toBeUndefined();
    }
  });

  it("来源不存在 / 停用 / 不是本机已登录类型：拒绝开窗，提示清楚", async () => {
    const missing = await setup({ providerId: "gone" });
    const a = await missing.run(undefined);
    expect(!a.ok && a.error).toContain("来源不存在");
    const disabled = await setup({ providerId: "src-1" });
    const b = await disabled.run({ ...SOURCE, enabled: false });
    expect(!b.ok && b.error).toContain("已停用");
    const wrongType = await setup({ providerId: "src-1" });
    const c = await wrongType.run({ ...SOURCE, templateId: "openai-compatible" });
    expect(!c.ok && c.error).toContain("本机已登录");
  });

  it("modelNotAllowedMessage：允许、不限制、没指定模型都返回 undefined", () => {
    const route = { allowedModels: ["m-a"], providerName: "S" };
    expect(modelNotAllowedMessage(route, "m-a")).toBeUndefined();
    expect(modelNotAllowedMessage(route, undefined)).toBeUndefined();
    expect(modelNotAllowedMessage(route, "  ")).toBeUndefined();
    expect(modelNotAllowedMessage({ providerName: "S" }, "x")).toBeUndefined();
    expect(modelNotAllowedMessage({ allowedModels: [] }, "x")).toBeUndefined();
    expect(modelNotAllowedMessage(route, "m-z")).toContain("m-a");
  });
});
