/**
 * T10.3 providers.json v1→v2 迁移单测。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAndMigrateProvidersFile,
  mapLegacyTypeToTemplateId,
  migrateProvidersFileInMemory,
  PROVIDERS_V1_BACKUP_SUFFIX,
  ProvidersFileInvalidError,
} from "../src/index.js";

const NOW = 1_700_000_000_000;

let tempRoot: string;
let providersFile: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-migrate-"));
  providersFile = join(tempRoot, "providers.json");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("mapLegacyTypeToTemplateId", () => {
  it("按旧 type 与 baseUrl 映射", () => {
    expect(mapLegacyTypeToTemplateId("cli_login", undefined)).toBe("local-login");
    expect(mapLegacyTypeToTemplateId("openai_compatible", "https://api.openai.com/v1")).toBe(
      "openai-official",
    );
    expect(mapLegacyTypeToTemplateId("openai_compatible", "https://api.deepseek.com/v1")).toBe(
      "openai-compatible",
    );
    expect(mapLegacyTypeToTemplateId("anthropic", "https://api.anthropic.com")).toBe(
      "anthropic-official",
    );
    expect(mapLegacyTypeToTemplateId("anthropic", "https://relay.example")).toBe(
      "anthropic-compatible",
    );
    expect(mapLegacyTypeToTemplateId("custom", "https://x.anthropic.proxy/v1")).toBe(
      "anthropic-compatible",
    );
    expect(mapLegacyTypeToTemplateId("custom", "https://other.example")).toBe("openai-compatible");
  });
});

describe("migrateProvidersFileInMemory", () => {
  it("迁移各旧类型并改写模型字段", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-a",
            name: "DS",
            type: "openai_compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyRef: "keyref-1",
            models: [{ id: "m1", displayName: "M1", kind: "chat" }],
            defaultModel: "m1",
            enabled: true,
          },
          {
            id: "provider-b",
            name: "Claude",
            type: "anthropic",
            baseUrl: "https://api.anthropic.com",
            apiKeyRef: "keyref-2",
            models: [],
            enabled: true,
          },
          {
            id: "provider-c",
            name: "Local",
            type: "cli_login",
            models: [],
            enabled: true,
          },
          {
            id: "provider-d",
            name: "Custom",
            type: "custom",
            requestTemplate: '{"x":1}',
            models: [],
            enabled: false,
          },
        ],
      },
      NOW,
    );
    expect(migrated.version).toBe(2);
    expect(migrated.providers[0]?.templateId).toBe("openai-compatible");
    expect(migrated.providers[0]?.defaultModelId).toBe("m1");
    expect(migrated.providers[0]?.models[0]?.label).toBe("M1");
    expect(migrated.providers[0]?.apiKeyRef).toBe("keyref-1");
    expect(migrated.providers[1]?.templateId).toBe("anthropic-official");
    expect(migrated.providers[2]?.templateId).toBe("local-login");
    expect(migrated.providers[3]?.templateId).toBe("openai-compatible");
    expect(migrated.providers[3]?.options?.requestTemplate).toBe('{"x":1}');
  });

  it("anthropic 中转迁移写入 authHeaderStyle=api_key；剥离 wire_api", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-relay",
            name: "Relay",
            type: "anthropic",
            baseUrl: "https://relay.example/anthropic",
            apiKeyRef: "keyref-r",
            models: [],
            enabled: true,
            options: { wire_api: "chat", keep: "yes" },
          },
          {
            id: "provider-custom-a",
            name: "CustomA",
            type: "custom",
            baseUrl: "https://x.anthropic.proxy/v1",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    expect(migrated.providers[0]?.templateId).toBe("anthropic-compatible");
    expect(migrated.providers[0]?.options).toEqual({
      keep: "yes",
      authHeaderStyle: "api_key",
    });
    expect(migrated.providers[0]?.options?.wire_api).toBeUndefined();
    expect(migrated.providers[1]?.templateId).toBe("anthropic-compatible");
    expect(migrated.providers[1]?.options?.authHeaderStyle).toBe("api_key");
  });

  it("v2 幂等", () => {
    const once = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-a",
            name: "Local",
            type: "cli_login",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    const twice = migrateProvidersFileInMemory(once, NOW);
    expect(twice.providers).toEqual(once.providers);
  });
});

describe("loadAndMigrateProvidersFile", () => {
  it("写备份并升 v2，再次读取幂等", async () => {
    await writeFile(
      providersFile,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "provider-x",
            name: "X",
            type: "cli_login",
            models: [],
            enabled: true,
          },
        ],
      }),
      "utf8",
    );
    const first = await loadAndMigrateProvidersFile(providersFile, NOW);
    expect(first.migrated).toBe(true);
    expect(first.backupPath).toBe(`${providersFile}${PROVIDERS_V1_BACKUP_SUFFIX}`);
    const backupPath = first.backupPath;
    expect(backupPath).toBeDefined();
    const backup = JSON.parse(await readFile(backupPath as string, "utf8")) as { version: number };
    expect(backup.version).toBe(1);
    const disk = JSON.parse(await readFile(providersFile, "utf8")) as { version: number };
    expect(disk.version).toBe(2);

    const second = await loadAndMigrateProvidersFile(providersFile, NOW);
    expect(second.migrated).toBe(false);
    expect(second.providers[0]?.templateId).toBe("local-login");
  });

  it("损坏文件保留原文并报错", async () => {
    const broken = JSON.stringify({
      version: 1,
      providers: [{ id: "bad", name: "", type: "openai_compatible" }],
    });
    await writeFile(providersFile, broken, "utf8");
    await expect(loadAndMigrateProvidersFile(providersFile, NOW)).rejects.toBeInstanceOf(
      ProvidersFileInvalidError,
    );
    expect(await readFile(providersFile, "utf8")).toBe(broken);
    await expect(
      readFile(`${providersFile}${PROVIDERS_V1_BACKUP_SUFFIX}`, "utf8"),
    ).rejects.toThrow();
  });
});
