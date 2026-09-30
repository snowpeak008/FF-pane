/**
 * T10.3 Provider 注入解析器单测：模板 × CLI 快照、密钥不进 args、危险 extraEnv、不适用 CLI。
 */

import type { Provider } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  assertSecretNotInOverrides,
  CLAUDE_API_KEY_ENV,
  CLAUDE_AUTH_TOKEN_ENV,
  CLAUDE_BASE_URL_ENV,
  CODEX_API_KEY_ENV,
  ProviderInjectionError,
  resolveProviderInjection,
} from "../src/provider-injection/index.js";

const SECRET = "sk-secret-never-in-args";

function provider(partial: Partial<Provider> & Pick<Provider, "templateId">): Provider {
  const now = 1_700_000_000_000;
  return {
    id: "provider-test" as Provider["id"],
    name: "Test",
    models: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("resolveProviderInjection", () => {
  it("anthropic-official × claude-code：API_KEY + 可选 baseUrl/model", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "anthropic-official",
        baseUrl: "https://api.anthropic.com",
      }),
      cli: "claude-code",
      secret: SECRET,
      model: "claude-sonnet",
    });
    expect(injection.env).toEqual({
      [CLAUDE_API_KEY_ENV]: SECRET,
      [CLAUDE_BASE_URL_ENV]: "https://api.anthropic.com",
      ANTHROPIC_MODEL: "claude-sonnet",
    });
    expect(injection.configOverrides).toEqual({});
    assertSecretNotInOverrides(injection, SECRET);
  });

  it("anthropic-compatible × claude-code：默认 AUTH_TOKEN", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "anthropic-compatible",
        baseUrl: "https://relay.example/anthropic",
      }),
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env[CLAUDE_AUTH_TOKEN_ENV]).toBe(SECRET);
    expect(injection.env[CLAUDE_API_KEY_ENV]).toBeUndefined();
    expect(injection.env[CLAUDE_BASE_URL_ENV]).toBe("https://relay.example/anthropic");
    assertSecretNotInOverrides(injection, SECRET);
  });

  it("anthropic-compatible × claude-code：options.authHeaderStyle=api_key", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "anthropic-compatible",
        baseUrl: "https://relay.example",
        options: { authHeaderStyle: "api_key" },
      }),
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env[CLAUDE_API_KEY_ENV]).toBe(SECRET);
    expect(injection.env[CLAUDE_AUTH_TOKEN_ENV]).toBeUndefined();
  });

  it("openai-compatible × codex：密钥仅在 env，overrides 不含 wire_api", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "openai-compatible",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
      }),
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
    assertSecretNotInOverrides(injection, SECRET);
    for (const value of Object.values(injection.configOverrides)) {
      expect(value.includes(SECRET)).toBe(false);
    }
  });

  it("extraEnv 拒绝 LD_PRELOAD / NODE_OPTIONS 等", () => {
    expect(() =>
      resolveProviderInjection({
        provider: provider({
          templateId: "local-login",
          extraEnv: { LD_PRELOAD: "/evil.so" },
        }),
        cli: "claude-code",
      }),
    ).toThrow(/危险变量/);
    expect(() =>
      resolveProviderInjection({
        provider: provider({
          templateId: "local-login",
          extraEnv: { NODE_OPTIONS: "--require evil" },
        }),
        cli: "codex",
      }),
    ).toThrow(ProviderInjectionError);
  });

  it("openai-official × codex：无 baseUrl 时只注入密钥", () => {
    const injection = resolveProviderInjection({
      provider: provider({ templateId: "openai-official" }),
      cli: "codex",
      secret: SECRET,
    });
    expect(injection.env).toEqual({ [CODEX_API_KEY_ENV]: SECRET });
    expect(injection.configOverrides).toEqual({});
  });

  it("openai-compatible × claude-code：旧流程兼容，注入 ANTHROPIC_*", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "openai-compatible",
        baseUrl: "https://hub.example/v1",
      }),
      cli: "claude-code",
      secret: SECRET,
    });
    expect(injection.env).toEqual({
      [CLAUDE_API_KEY_ENV]: SECRET,
      [CLAUDE_BASE_URL_ENV]: "https://hub.example/v1",
    });
  });

  it("local-login：不注入密钥/地址", () => {
    const injection = resolveProviderInjection({
      provider: provider({ templateId: "local-login" }),
      cli: "codex",
      secret: SECRET,
    });
    expect(injection.env).toEqual({});
    expect(injection.configOverrides).toEqual({});
    expect(injection.secretEnvKeys).toEqual([]);
  });

  it("extraEnv 合并且不得覆盖密钥变量", () => {
    const injection = resolveProviderInjection({
      provider: provider({
        templateId: "openai-compatible",
        baseUrl: "https://x.test/v1",
        extraEnv: { FOO: "1", [CODEX_API_KEY_ENV]: "hijack" },
      }),
      cli: "codex",
      secret: SECRET,
    });
    expect(injection.env[CODEX_API_KEY_ENV]).toBe(SECRET);
    expect(injection.env["FOO"]).toBe("1");
  });

  it("extraEnv 危险变量被拒", () => {
    expect(() =>
      resolveProviderInjection({
        provider: provider({
          templateId: "local-login",
          extraEnv: { PATH: "/evil" },
        }),
        cli: "claude-code",
      }),
    ).toThrow(ProviderInjectionError);
    try {
      resolveProviderInjection({
        provider: provider({
          templateId: "local-login",
          extraEnv: { ComSpec: "cmd.exe" },
        }),
        cli: "codex",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderInjectionError);
      expect((error as ProviderInjectionError).code).toBe("dangerous-extra-env");
    }
  });

  it("不适用的 CLI 报错", () => {
    expect(() =>
      resolveProviderInjection({
        provider: provider({
          templateId: "anthropic-official",
          baseUrl: "https://api.anthropic.com",
        }),
        cli: "codex",
        secret: SECRET,
      }),
    ).toThrow(/不适用于 CLI codex/);
  });

  it("anthropic-compatible 缺 baseUrl 报错", () => {
    expect(() =>
      resolveProviderInjection({
        provider: provider({ templateId: "anthropic-compatible" }),
        cli: "claude-code",
        secret: SECRET,
      }),
    ).toThrow(ProviderInjectionError);
  });
});
