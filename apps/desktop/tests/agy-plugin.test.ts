/**
 * agy 的 ffpane 工具插件：状态判断、添加/更新/卸载、自动更新的规矩（计划 §2、§3）。
 * 用内存里的假 agy 模拟 `agy plugin list/validate/install/uninstall`，不碰真实用户目录。
 */

import { describe, expect, it } from "vitest";
import {
  AGY_PLUGIN_NAME,
  AGY_PLUGIN_OWNER_FILE,
  type AgyPluginDeps,
  type AgyPluginFiles,
  agyPluginDigest,
  autoUpdateAgyPlugin,
  buildAgyPluginFiles,
  getAgyPluginStatus,
  hasOwnerMarker,
  installAgyPlugin,
  uninstallAgyPlugin,
} from "../src/main/user-mods/agy-plugin";
import { shouldAutoUpdateAgyPlugin } from "../src/main/user-mods/agy-plugin-main";
import {
  EMPTY_LEDGER,
  findEntry,
  parseLedger,
  type UserModsLedger,
} from "../src/main/user-mods/ledger";

const SPEC = { execPath: "C:\\Apps\\FF-pane\\FF-pane.exe", moduleDir: "C:\\Apps\\FF-pane\\out" };
const MOVED = { execPath: "D:\\New\\FF-pane.exe", moduleDir: "D:\\New\\out" };
const PLUGINS_DIR = "C:\\Users\\u\\.gemini\\config\\plugins";
const PLUGIN_DIR = `${PLUGINS_DIR}\\${AGY_PLUGIN_NAME}`;
const FOREIGN: AgyPluginFiles = { "plugin.json": "{}", "mcp_config.json": "{}" };

interface Fake {
  readonly deps: AgyPluginDeps;
  installed: { files: AgyPluginFiles; enabled: boolean } | undefined;
  ledger: UserModsLedger;
  windows: boolean;
  agyPresent: boolean;
  failInstall: boolean;
  failUninstall: boolean;
  readonly calls: string[];
  readonly removedDirs: string[];
}

function fake(): Fake {
  const state = {
    installed: undefined as Fake["installed"],
    ledger: EMPTY_LEDGER as UserModsLedger,
    windows: false,
    agyPresent: true,
    failInstall: false,
    failUninstall: false,
    calls: [] as string[],
    removedDirs: [] as string[],
  };
  let staged: AgyPluginFiles | undefined;
  const deps: AgyPluginDeps = {
    resolveAgy: () => (state.agyPresent ? "agy.exe" : undefined),
    runAgy: async (args) => {
      state.calls.push(args.join(" "));
      if (args[1] === "list") {
        return {
          code: 0,
          output: JSON.stringify(
            state.installed === undefined
              ? []
              : [{ name: AGY_PLUGIN_NAME, enabled: state.installed.enabled, path: PLUGIN_DIR }],
          ),
        };
      }
      if (args[1] === "validate") {
        return { code: 0, output: "ok" };
      }
      if (args[1] === "install") {
        if (state.failInstall) {
          return { code: 1, output: "locked" };
        }
        // 整体替换，保留用户禁用的状态（真实 agy 的行为，2026-11-28 实测）
        state.installed = { files: staged ?? {}, enabled: state.installed?.enabled ?? true };
        return { code: 0, output: "installed" };
      }
      if (args[1] === "uninstall") {
        if (state.failUninstall) {
          return { code: 1, output: "in use" };
        }
        state.installed = undefined;
        return { code: 0, output: "uninstalled" };
      }
      return { code: 2, output: "unknown" };
    },
    readInstalled: async () => state.installed?.files,
    writeStage: async (files) => {
      staged = files;
      return "C:\\ffpane\\stage";
    },
    removeDir: async (dir) => {
      state.removedDirs.push(dir);
      state.installed = undefined;
    },
    pluginsDir: () => PLUGINS_DIR,
    agyWindowsRunning: () => state.windows,
    readLedger: async () => state.ledger,
    writeLedger: async (next) => {
      state.ledger = next;
    },
    now: () => 1000,
    appVersion: "2.0.9",
  };
  return Object.assign(state, { deps }) as Fake;
}

describe("生成的插件内容", () => {
  it("带归属标记；内容只取决于安装位置，不带 FF-pane 版本", () => {
    const files = buildAgyPluginFiles(SPEC);
    expect(hasOwnerMarker(files)).toBe(true);
    const mcp = JSON.parse(files["mcp_config.json"] ?? "{}") as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
    };
    expect(mcp.mcpServers["ffpane-workbench"]?.command).toBe(SPEC.execPath);
    expect(mcp.mcpServers["ffpane-workbench"]?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    // 令牌和管道名不写进文件
    expect(files["mcp_config.json"]).not.toMatch(/TOKEN|PIPE|Bearer/i);
    expect(agyPluginDigest(files)).toBe(agyPluginDigest(buildAgyPluginFiles(SPEC)));
    expect(agyPluginDigest(files)).not.toBe(agyPluginDigest(buildAgyPluginFiles(MOVED)));
  });

  it('标记文件里 owner 单独一行写成 "owner": "ff-pane"（安装包卸载钩子用 findstr 认它）', () => {
    const marker = buildAgyPluginFiles(SPEC)[AGY_PLUGIN_OWNER_FILE] ?? "";
    expect(marker.split(/\r?\n/).some((line) => /owner.*ff-pane/.test(line))).toBe(true);
    // 别人的标记不能被同一条规则认成我们的
    expect(/owner.*ff-pane/.test('{"owner":"someone"}')).toBe(false);
  });

  it("没有标记就不算我们的", () => {
    expect(hasOwnerMarker(undefined)).toBe(false);
    expect(hasOwnerMarker({ [AGY_PLUGIN_OWNER_FILE]: '{"owner":"someone"}' })).toBe(false);
    expect(hasOwnerMarker({ [AGY_PLUGIN_OWNER_FILE]: "not json" })).toBe(false);
  });
});

describe("状态", () => {
  it("没装 agy / 没添加 / 已添加且最新 / 过期 / 同名别人的", async () => {
    const f = fake();
    f.agyPresent = false;
    expect((await getAgyPluginStatus(f.deps, SPEC)).state).toBe("agy-missing");
    f.agyPresent = true;
    expect((await getAgyPluginStatus(f.deps, SPEC)).state).toBe("not-installed");

    f.installed = { files: buildAgyPluginFiles(SPEC), enabled: true };
    expect(await getAgyPluginStatus(f.deps, SPEC)).toMatchObject({
      state: "installed",
      current: true,
      enabled: true,
    });
    // 安装位置变了 → 过期
    expect(await getAgyPluginStatus(f.deps, MOVED)).toMatchObject({
      state: "installed",
      current: false,
    });

    f.installed = { files: FOREIGN, enabled: true };
    expect((await getAgyPluginStatus(f.deps, SPEC)).state).toBe("foreign");
  });

  it("比较内容不受缩进和键顺序影响", async () => {
    const f = fake();
    const files = buildAgyPluginFiles(SPEC);
    const compact = Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, JSON.stringify(JSON.parse(text))]),
    );
    f.installed = { files: compact, enabled: true };
    expect(await getAgyPluginStatus(f.deps, SPEC)).toMatchObject({ current: true });
  });
});

describe("添加 / 更新 / 卸载", () => {
  it("添加：先校验再安装，写台账，状态变成已装最新", async () => {
    const f = fake();
    const result = await installAgyPlugin(f.deps, SPEC);
    expect(result.ok).toBe(true);
    const verbs = f.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(verbs.indexOf("plugin validate")).toBeLessThan(verbs.indexOf("plugin install"));
    const entry = findEntry(f.ledger, "agy-plugin", AGY_PLUGIN_NAME);
    expect(entry?.writtenBy).toBe("2.0.9");
    expect(entry?.digest).toBe(agyPluginDigest(buildAgyPluginFiles(SPEC)));
  });

  it("同名但不是我们装的：添加和卸载都不动它", async () => {
    const f = fake();
    f.installed = { files: FOREIGN, enabled: true };
    expect((await installAgyPlugin(f.deps, SPEC)).ok).toBe(false);
    expect((await uninstallAgyPlugin(f.deps, SPEC)).ok).toBe(false);
    expect(f.installed).toBeDefined();
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
    expect(f.calls.some((c) => c.startsWith("plugin uninstall"))).toBe(false);
  });

  it("没装 agy：给人话提示", async () => {
    const f = fake();
    f.agyPresent = false;
    const result = await installAgyPlugin(f.deps, SPEC);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("agy");
  });

  it("卸载：插件和台账都清掉；agy 卸不掉时兜底删目录（已确认有标记）", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.failUninstall = true;
    const result = await uninstallAgyPlugin(f.deps, SPEC);
    expect(result.ok).toBe(true);
    expect(f.removedDirs).toEqual([PLUGIN_DIR]);
    expect(findEntry(f.ledger, "agy-plugin", AGY_PLUGIN_NAME)).toBeUndefined();
  });

  it("本来就没装（用户在 agy 里自己卸了）：卸载也算成功，并清掉台账残留", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.installed = undefined;
    expect((await uninstallAgyPlugin(f.deps, SPEC)).ok).toBe(true);
    expect(f.ledger.entries).toHaveLength(0);
  });
});

describe("自动更新：只更新已装的，没装的绝不补装", () => {
  it("没添加：什么都不做，也不调 install", async () => {
    const f = fake();
    expect(await autoUpdateAgyPlugin(f.deps, SPEC)).toMatchObject({ action: "none" });
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
    expect(f.installed).toBeUndefined();
  });

  it("用户自己在 agy 里卸了：只清台账，不补装", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.installed = undefined;
    f.calls.length = 0;
    expect(await autoUpdateAgyPlugin(f.deps, SPEC)).toMatchObject({ action: "none" });
    expect(f.ledger.entries).toHaveLength(0);
    expect(f.installed).toBeUndefined();
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
  });

  it("已装且最新：不动", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.calls.length = 0;
    expect(await autoUpdateAgyPlugin(f.deps, SPEC)).toMatchObject({ action: "none" });
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
  });

  it("已装但过期：自动更新，用户禁用的状态保留", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    if (f.installed !== undefined) {
      f.installed.enabled = false;
    }
    expect(await autoUpdateAgyPlugin(f.deps, MOVED)).toEqual({ action: "updated" });
    expect(await getAgyPluginStatus(f.deps, MOVED)).toMatchObject({
      state: "installed",
      current: true,
      enabled: false,
    });
  });

  it("有 agy 窗口开着：推迟，不动", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.windows = true;
    f.calls.length = 0;
    expect(await autoUpdateAgyPlugin(f.deps, MOVED)).toMatchObject({ action: "deferred" });
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
  });

  it("更新失败：旧内容保留、记下原因；下次成功后清掉原因", async () => {
    const f = fake();
    await installAgyPlugin(f.deps, SPEC);
    f.failInstall = true;
    expect(await autoUpdateAgyPlugin(f.deps, MOVED)).toMatchObject({ action: "failed" });
    expect(findEntry(f.ledger, "agy-plugin", AGY_PLUGIN_NAME)?.lastError).toContain("locked");
    expect(findEntry(f.ledger, "agy-plugin", AGY_PLUGIN_NAME)?.digest).toBe(
      agyPluginDigest(buildAgyPluginFiles(SPEC)),
    );
    f.failInstall = false;
    expect(await autoUpdateAgyPlugin(f.deps, MOVED)).toEqual({ action: "updated" });
    expect(findEntry(f.ledger, "agy-plugin", AGY_PLUGIN_NAME)?.lastError).toBeUndefined();
  });

  it("没装 agy：跳过", async () => {
    const f = fake();
    f.agyPresent = false;
    expect(await autoUpdateAgyPlugin(f.deps, SPEC)).toMatchObject({ action: "none" });
  });

  it("同名别人的：不碰", async () => {
    const f = fake();
    f.installed = { files: FOREIGN, enabled: true };
    expect(await autoUpdateAgyPlugin(f.deps, SPEC)).toMatchObject({ action: "none" });
    expect(f.calls.some((c) => c.startsWith("plugin install"))).toBe(false);
  });
});

describe("台账解析", () => {
  it("缺失、损坏、有看不懂的条目都不抛，只留看得懂的", () => {
    expect(parseLedger(undefined).entries).toHaveLength(0);
    expect(parseLedger("not json").entries).toHaveLength(0);
    expect(parseLedger('{"entries":"x"}').entries).toHaveLength(0);
    const ok = {
      kind: "agy-plugin",
      name: "ffpane-workbench",
      path: "p",
      digest: "d",
      writtenBy: "2.0.9",
      installedAt: 1,
      updatedAt: 2,
    };
    expect(parseLedger(JSON.stringify({ entries: [ok, { kind: "x" }, 5] })).entries).toEqual([ok]);
  });
});

describe("启动时自动更新只在安装版里做", () => {
  it("开发构建、自动化测试都不动用户真实的插件", () => {
    expect(shouldAutoUpdateAgyPlugin({ isPackaged: true, automatedTest: false })).toBe(true);
    expect(shouldAutoUpdateAgyPlugin({ isPackaged: false, automatedTest: false })).toBe(false);
    expect(shouldAutoUpdateAgyPlugin({ isPackaged: true, automatedTest: true })).toBe(false);
    expect(shouldAutoUpdateAgyPlugin({ isPackaged: false, automatedTest: true })).toBe(false);
  });
});
