/**
 * T10.3 修复：迁移前后对 claude-code / codex 的注入结果与旧流程等价。
 * 旧流程语义按 HEAD env.ts：claude 恒 ANTHROPIC_API_KEY；codex 路由不写 wire_api。
 */

import {
  CLAUDE_API_KEY_ENV,
  CLAUDE_AUTH_TOKEN_ENV,
  CLAUDE_BASE_URL_ENV,
  CODEX_API_KEY_ENV,
  resolveProviderInjection,
} from "@ff-pane/core";
import type { Provider } from "@ff-pane/shared";
import { migrateProvidersFileInMemory } from "@ff-pane/storage";
import { describe, expect, it } from "vitest";

const SECRET = "sk-legacy-parity";
const NOW = 1_700_000_000_000;

function firstProvider(providers: readonly Provider[]): Provider {
  const provider = providers[0];
  expect(provider).toBeDefined();
  if (provider === undefined) {
    throw new Error("expected migrated provider");
  }
  return provider;
}

describe("迁移后注入 ≡ 旧流程", () => {
  it("anthropic 中转 → anthropic-compatible：claude-code 仍注 ANTHROPIC_API_KEY", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-a",
            name: "Relay",
            type: "anthropic",
            baseUrl: "https://relay.example/v1",
            apiKeyRef: "ref-a",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    const provider = firstProvider(migrated.providers);
    expect(provider.templateId).toBe("anthropic-compatible");
    expect(provider.options?.["authHeaderStyle"]).toBe("api_key");

    const injection = resolveProviderInjection({
      provider,
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env).toEqual({
      [CLAUDE_API_KEY_ENV]: SECRET,
      [CLAUDE_BASE_URL_ENV]: "https://relay.example/v1",
    });
    expect(injection.env[CLAUDE_AUTH_TOKEN_ENV]).toBeUndefined();
    expect(injection.configOverrides).toEqual({});
  });

  it("openai_compatible 中转 → openai-compatible：codex 无 wire_api", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-b",
            name: "DeepSeek",
            type: "openai_compatible",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyRef: "ref-b",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    const provider = firstProvider(migrated.providers);
    expect(provider.templateId).toBe("openai-compatible");

    const injection = resolveProviderInjection({
      provider,
      cli: "codex",
      secret: SECRET,
    });
    expect(injection.env).toEqual({ [CODEX_API_KEY_ENV]: SECRET });
    expect(injection.configOverrides).toEqual({
      model_provider: "ffpane",
      "model_providers.ffpane.name": '"DeepSeek"',
      "model_providers.ffpane.base_url": '"https://api.deepseek.com/v1"',
      "model_providers.ffpane.env_key": '"OPENAI_API_KEY"',
    });
    expect(injection.configOverrides["model_providers.ffpane.wire_api"]).toBeUndefined();
  });

  it("openai_compatible → openai-compatible × claude-code：ANTHROPIC_*", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-c",
            name: "Hub",
            type: "openai_compatible",
            baseUrl: "https://hub.example/v1",
            apiKeyRef: "ref-c",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    const injection = resolveProviderInjection({
      provider: firstProvider(migrated.providers),
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env).toEqual({
      [CLAUDE_API_KEY_ENV]: SECRET,
      [CLAUDE_BASE_URL_ENV]: "https://hub.example/v1",
    });
  });

  it("cli_login → local-login：空注入", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 1,
        providers: [
          {
            id: "provider-d",
            name: "Local",
            type: "cli_login",
            models: [],
            enabled: true,
          },
        ],
      },
      NOW,
    );
    const provider = firstProvider(migrated.providers);
    for (const cli of ["claude-code", "codex"] as const) {
      const injection = resolveProviderInjection({
        provider,
        cli,
        secret: SECRET,
      });
      expect(injection.env).toEqual({});
      expect(injection.configOverrides).toEqual({});
    }
  });

  it("新建 anthropic-compatible 仍默认 AUTH_TOKEN（与迁移路径区分）", () => {
    const migrated = migrateProvidersFileInMemory(
      {
        version: 2,
        providers: [
          {
            id: "provider-new",
            name: "NewRelay",
            templateId: "anthropic-compatible",
            baseUrl: "https://new.relay/v1",
            apiKeyRef: "ref-n",
            models: [],
            enabled: true,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
      NOW,
    );
    const provider = firstProvider(migrated.providers);
    expect(provider.options?.["authHeaderStyle"]).toBeUndefined();
    const injection = resolveProviderInjection({
      provider,
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env[CLAUDE_AUTH_TOKEN_ENV]).toBe(SECRET);
    expect(injection.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
  });
});
