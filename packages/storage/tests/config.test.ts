/**
 * 全局 config store 单测（W3.2b）：走 mkdtemp 临时目录真实读写。
 * 覆盖：缺文件补默认、update 建档、部分补丁浅合并、缺字段补默认、
 * 结构不符抛错、与 resolveGlobalLayout 接线一致。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GLOBAL_CONFIG } from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_VERSION,
  ConfigFileInvalidError,
  type ConfigStore,
  createConfigStore,
  resolveGlobalLayout,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let configFile: string;
let store: ConfigStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-config-"));
  configFile = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).configFile;
  store = createConfigStore(configFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ConfigStore", () => {
  it("首次使用：文件不存在时读出出厂默认，不建档", async () => {
    expect(await store.readConfig()).toEqual(DEFAULT_GLOBAL_CONFIG);
    await expect(readFile(configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("update：写入部分补丁后建档、读回合并结果", async () => {
    const merged = await store.updateConfig({ aiOutputLanguage: "en-US" });
    expect(merged.aiOutputLanguage).toBe("en-US");
    // 未涉及字段保留默认
    expect(merged.defaultPermissionPreset).toEqual(DEFAULT_GLOBAL_CONFIG.defaultPermissionPreset);

    const onDisk = JSON.parse(await readFile(configFile, "utf8")) as unknown;
    expect(onDisk).toEqual({ version: CONFIG_FILE_VERSION, config: merged });
  });

  it("update：多次补丁叠加浅合并", async () => {
    await store.updateConfig({ aiOutputLanguage: "en-US" });
    const merged = await store.updateConfig({
      defaultPermissionPreset: {
        readPaths: [],
        writePaths: ["src/**"],
        shell: "allowed",
        network: true,
        dangerousOpsRequireApproval: true,
      },
    });
    expect(merged.aiOutputLanguage).toBe("en-US");
    expect(merged.defaultPermissionPreset.shell).toBe("allowed");
  });

  it("缺字段补默认：只存了一个字段时读出完整设置", async () => {
    await writeTextAtomic(
      configFile,
      JSON.stringify({ version: CONFIG_FILE_VERSION, config: { aiOutputLanguage: "en-US" } }),
    );
    const config = await store.readConfig();
    expect(config.aiOutputLanguage).toBe("en-US");
    expect(config.defaultPermissionPreset).toEqual(DEFAULT_GLOBAL_CONFIG.defaultPermissionPreset);
  });

  it("版本不支持：抛 ConfigFileInvalidError", async () => {
    await writeTextAtomic(configFile, JSON.stringify({ version: 999, config: {} }));
    await expect(store.readConfig()).rejects.toThrow(ConfigFileInvalidError);
  });

  it("顶层非对象：抛 ConfigFileInvalidError", async () => {
    await writeTextAtomic(configFile, JSON.stringify([1, 2, 3]));
    await expect(store.readConfig()).rejects.toThrow(ConfigFileInvalidError);
  });
});
