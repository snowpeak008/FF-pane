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
import { resolveProjectLaunchRoute } from "../src/main/workbench/resolve-config";

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
