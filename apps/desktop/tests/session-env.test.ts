/**
 * T4.2 / T10.3 Run 级密钥注入映射单测。
 */

import type { Provider } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  resolveRuntimeConfigOverrides,
  resolveRuntimeEnv,
  runtimeApiKeyEnvVar,
} from "../src/main/session/env";

function provider(overrides: Partial<Record<keyof Provider, unknown>> = {}): Provider {
  return {
    id: "prov-1",
    name: "V",
    templateId: "openai-compatible",
    models: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as Provider;
}

describe("runtimeApiKeyEnvVar", () => {
  it("按 Runtime 取密钥变量名", () => {
    expect(runtimeApiKeyEnvVar("codex")).toBe("OPENAI_API_KEY");
    expect(runtimeApiKeyEnvVar("claude-code")).toBe("ANTHROPIC_API_KEY");
    expect(runtimeApiKeyEnvVar("gemini-cli")).toBe("GEMINI_API_KEY");
    expect(runtimeApiKeyEnvVar("qwen-code")).toBe("OPENAI_API_KEY");
    expect(runtimeApiKeyEnvVar("iflow")).toBe("IFLOW_API_KEY");
    expect(runtimeApiKeyEnvVar("opencode")).toBeUndefined();
    expect(runtimeApiKeyEnvVar("generic-exec")).toBeUndefined();
  });
});

describe("resolveRuntimeEnv", () => {
  it("anthropic-compatible 默认 AUTH_TOKEN", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({
        templateId: "anthropic-compatible",
        baseUrl: "https://relay.example",
      }),
      apiKeyPlaintext: "sk-x",
    });
    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-x",
      ANTHROPIC_BASE_URL: "https://relay.example",
    });
  });

  it("local-login 不注入密钥", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({ templateId: "local-login" }),
      apiKeyPlaintext: "sk-x",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("codex 密钥进 env，base_url 进 configOverrides 而非 env", () => {
    const env = resolveRuntimeEnv({
      runtime: "codex",
      provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
      apiKeyPlaintext: "k",
    });
    expect(env).toEqual({ OPENAI_API_KEY: "k" });
  });

  it("qwen-code 同走 OPENAI_API_KEY + OPENAI_BASE_URL（旧路径）", () => {
    const env = resolveRuntimeEnv({
      runtime: "qwen-code",
      provider: provider({
        templateId: "openai-compatible",
        baseUrl: "https://dashscope.example/compatible-mode/v1",
      }),
      apiKeyPlaintext: "sk-q",
    });
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-q",
      OPENAI_BASE_URL: "https://dashscope.example/compatible-mode/v1",
    });
  });

  it("iflow 走 IFLOW_API_KEY + IFLOW_BASE_URL（旧路径）", () => {
    const env = resolveRuntimeEnv({
      runtime: "iflow",
      provider: provider({ templateId: "openai-compatible", baseUrl: "https://apis.iflow.cn/v1" }),
      apiKeyPlaintext: "sk-i",
    });
    expect(env).toEqual({ IFLOW_API_KEY: "sk-i", IFLOW_BASE_URL: "https://apis.iflow.cn/v1" });
  });

  it("无明文时该密钥变量缺席（不塞空串）", () => {
    const env = resolveRuntimeEnv({
      runtime: "codex",
      provider: provider({ baseUrl: "https://x.test" }),
    });
    expect(env).toEqual({});
  });

  it("T9.11：本地 CLI 即使有密钥和网址也不注入", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({
        templateId: "openai-compatible",
        baseUrl: "https://hub.example/v1",
      }),
      apiKeyPlaintext: "sk-x",
      connectionMode: "local_cli",
    });
    expect(env).toEqual({});
  });

  it("T9.11：中转时 Claude / Gemini / Grok 注入各家网址变量", () => {
    expect(
      resolveRuntimeEnv({
        runtime: "claude-code",
        provider: provider({
          templateId: "openai-compatible",
          baseUrl: "https://hub.example/v1",
        }),
        apiKeyPlaintext: "sk-x",
        connectionMode: "relay",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://hub.example/v1" });
    expect(
      resolveRuntimeEnv({
        runtime: "gemini-cli",
        provider: provider({
          templateId: "openai-compatible",
          baseUrl: "https://hub.example/v1",
        }),
        apiKeyPlaintext: "sk-g",
        connectionMode: "relay",
      }),
    ).toEqual({ GEMINI_API_KEY: "sk-g", GEMINI_API_BASE: "https://hub.example/v1" });
    expect(
      resolveRuntimeEnv({
        runtime: "grok-build",
        provider: provider({
          templateId: "openai-compatible",
          baseUrl: "https://hub.example/v1",
        }),
        apiKeyPlaintext: "sk-z",
        connectionMode: "relay",
      }),
    ).toEqual({ XAI_API_KEY: "sk-z", XAI_BASE_URL: "https://hub.example/v1" });
  });
});

describe("resolveRuntimeConfigOverrides", () => {
  it("codex + openai-compatible + baseUrl → model_provider 路由", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({
        templateId: "openai-compatible",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
      }),
    });
    expect(overrides).toEqual({
      model_provider: "ffpane",
      "model_providers.ffpane.name": '"DeepSeek"',
      "model_providers.ffpane.base_url": '"https://api.deepseek.com/v1"',
      "model_providers.ffpane.env_key": '"OPENAI_API_KEY"',
    });
    expect(overrides["model_providers.ffpane.wire_api"]).toBeUndefined();
  });

  it("env_key 指向 OPENAI_API_KEY", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
    });
    expect(overrides["model_providers.ffpane.env_key"]).toBe(
      JSON.stringify(runtimeApiKeyEnvVar("codex")),
    );
  });

  it("name 缺省退化为 slug，特殊字符经 JSON.stringify 转义", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({
        templateId: "openai-compatible",
        name: 'A"B',
        baseUrl: "https://x.test",
      }),
    });
    expect(overrides["model_providers.ffpane.name"]).toBe('"A\\"B"');
  });

  it("非 codex 运行时不产生覆盖", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "claude-code",
        provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
      }),
    ).toEqual({});
  });

  it("codex + local-login 不产生路由", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ templateId: "local-login" }),
      }),
    ).toEqual({});
  });

  it("openai-compatible 但缺 baseUrl 不产生覆盖", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ templateId: "openai-compatible" }),
      }),
    ).toEqual({});
  });

  it("T9.4b：codex 显式 effort 并入 model_reasoning_effort", () => {
    const withRoute = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
      reasoningEffort: "high",
    });
    expect(withRoute["model_reasoning_effort"]).toBe('"high"');
    expect(withRoute["model_provider"]).toBe("ffpane");
    const cliLogin = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ templateId: "local-login" }),
      reasoningEffort: "high",
    });
    expect(cliLogin).toEqual({ model_reasoning_effort: '"high"' });
  });

  it("T9.11：本地 CLI 即使 Provider 带网址也不装配 codex 路由", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
        connectionMode: "local_cli",
      }),
    ).toEqual({});
  });

  it("T9.4b：gemini-cli 即使传入 effort 也不进 overrides", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "gemini-cli",
        provider: provider({ templateId: "openai-compatible", baseUrl: "https://x.test" }),
        reasoningEffort: "high",
      }),
    ).toEqual({});
  });
});
