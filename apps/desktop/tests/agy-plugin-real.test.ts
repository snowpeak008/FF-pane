/**
 * agy 工具插件对真实 agy 的整条流程（添加 → 过期 → 自动更新 → 卸载）。
 * 把 agy 的用户目录指到临时目录（USERPROFILE/HOME），绝不碰真正的 `~/.gemini`。
 * 本机没装 agy 就跳过。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGY_PLUGIN_NAME,
  getAgyPluginStatus,
  installAgyPlugin,
  uninstallAgyPlugin,
} from "../src/main/user-mods/agy-plugin";
import { createAgyPluginDeps, runAgyPluginAutoUpdate } from "../src/main/user-mods/agy-plugin-main";
import { readLedger, USER_MODS_FILE_NAME } from "../src/main/user-mods/ledger";
import { resolveAgyTarget } from "../src/main/workbench/agy-cli";

const hasAgy = resolveAgyTarget(process.env) !== undefined;
const realPlugins = join(homedir(), ".gemini", "config", "plugins");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listReal(): string[] {
  return existsSync(realPlugins) ? readdirSync(realPlugins).sort() : [];
}

describe.skipIf(!hasAgy)("真实 agy：添加 → 过期 → 自动更新 → 卸载", () => {
  it("整条流程，并且不动真实用户目录", async () => {
    const before = listReal();
    const root = mkdtempSync(join(tmpdir(), "ffpane-agyplug-"));
    dirs.push(root);
    const fakeHome = join(root, "home");
    const globalRoot = join(root, "data");
    let windows = false;
    const make = (execPath: string) => {
      const options = {
        spec: { execPath, moduleDir: join(root, "app") },
        appVersion: "9.9.9",
        globalRoot,
        agyWindowsRunning: () => windows,
        env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
        home: fakeHome,
      };
      return { options, deps: createAgyPluginDeps(options) };
    };
    const v1 = make("C:\\Apps\\one\\FF-pane.exe");
    const v2 = make("D:\\Apps\\two\\FF-pane.exe");

    // 没添加：状态是没装，自动更新不补装
    expect((await getAgyPluginStatus(v1.deps, v1.options.spec)).state).toBe("not-installed");
    expect(await runAgyPluginAutoUpdate(v1.options)).toContain("不补装");
    expect((await getAgyPluginStatus(v1.deps, v1.options.spec)).state).toBe("not-installed");

    // 添加
    const added = await installAgyPlugin(v1.deps, v1.options.spec);
    expect(added.ok, added.ok ? "" : added.error).toBe(true);
    expect(await getAgyPluginStatus(v1.deps, v1.options.spec)).toMatchObject({
      state: "installed",
      current: true,
    });
    expect(existsSync(join(fakeHome, ".gemini", "config", "plugins", AGY_PLUGIN_NAME))).toBe(true);
    const ledger = await readLedger(join(globalRoot, USER_MODS_FILE_NAME));
    expect(ledger.entries[0]?.writtenBy).toBe("9.9.9");

    // 安装位置变了 → 过期；有 agy 窗口开着时推迟
    expect(await getAgyPluginStatus(v2.deps, v2.options.spec)).toMatchObject({
      state: "installed",
      current: false,
    });
    windows = true;
    expect(await runAgyPluginAutoUpdate(v2.options)).toContain("推迟");
    expect(await getAgyPluginStatus(v2.deps, v2.options.spec)).toMatchObject({ current: false });

    // 窗口关了 → 自动更新
    windows = false;
    expect(await runAgyPluginAutoUpdate(v2.options)).toContain("已自动更新");
    expect(await getAgyPluginStatus(v2.deps, v2.options.spec)).toMatchObject({
      state: "installed",
      current: true,
    });

    // 卸载
    const removed = await uninstallAgyPlugin(v2.deps, v2.options.spec);
    expect(removed.ok, removed.ok ? "" : removed.error).toBe(true);
    expect((await getAgyPluginStatus(v2.deps, v2.options.spec)).state).toBe("not-installed");
    expect((await readLedger(join(globalRoot, USER_MODS_FILE_NAME))).entries).toHaveLength(0);

    // 卸载后再启动：不补装
    expect(await runAgyPluginAutoUpdate(v2.options)).toContain("不补装");
    expect((await getAgyPluginStatus(v2.deps, v2.options.spec)).state).toBe("not-installed");

    // 真实用户目录一点没动
    expect(listReal()).toEqual(before);
  }, 120_000);
});
