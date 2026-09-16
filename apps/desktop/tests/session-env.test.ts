/**
 * T4.2 Run 级密钥注入映射单测（§4.3）：按 Runtime 取环境变量名、cli_login 不注入、
 * 无明文不塞空串、codex 注入 base_url。纯逻辑。
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
    type: "openai_compatible",
    models: [],
    enabled: true,
    ...overrides,
  } as unknown as Provider;
}

describe("runtimeApiKeyEnvVar", () => {
  it("按 Runtime 取密钥变量名", () => {
    expect(runtimeApiKeyEnvVar("codex")).toBe("OPENAI_API_KEY");
    expect(runtimeApiKeyEnvVar("claude-code")).toBe("ANTHROPIC_API_KEY");
    expect(runtimeApiKeyEnvVar("gemini-cli")).toBe("GEMINI_API_KEY");
    // qwen-code 走 --auth-type openai 兼容协议（qwen-code.md §6）
    expect(runtimeApiKeyEnvVar("qwen-code")).toBe("OPENAI_API_KEY");
    // iflow 的 openai-compatible 三件套必须 IFLOW_ 前缀（iflow.md §5.3——
    // CLI 错误提示里的裸 apiKey 写法是坑）
    expect(runtimeApiKeyEnvVar("iflow")).toBe("IFLOW_API_KEY");
    expect(runtimeApiKeyEnvVar("opencode")).toBeUndefined();
    expect(runtimeApiKeyEnvVar("generic-exec")).toBeUndefined();
  });
});

describe("resolveRuntimeEnv", () => {
  it("按 Runtime 变量名注入密钥", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({ type: "anthropic" }),
      apiKeyPlaintext: "sk-x",
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-x" });
  });

  it("cli_login 不注入密钥（凭证由 CLI 自管）", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({ type: "cli_login" }),
      apiKeyPlaintext: "sk-x",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("codex 附带注入 base_url", () => {
    const env = resolveRuntimeEnv({
      runtime: "codex",
      provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
      apiKeyPlaintext: "k",
    });
    expect(env).toEqual({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://x.test" });
  });

  it("qwen-code 同走 OPENAI_API_KEY + OPENAI_BASE_URL（openai 兼容协议）", () => {
    const env = resolveRuntimeEnv({
      runtime: "qwen-code",
      provider: provider({
        type: "openai_compatible",
        baseUrl: "https://dashscope.example/compatible-mode/v1",
      }),
      apiKeyPlaintext: "sk-q",
    });
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-q",
      OPENAI_BASE_URL: "https://dashscope.example/compatible-mode/v1",
    });
  });

  it("iflow 走 IFLOW_API_KEY + IFLOW_BASE_URL（openai-compatible 的 IFLOW_ 前缀形态）", () => {
    const env = resolveRuntimeEnv({
      runtime: "iflow",
      provider: provider({ type: "openai_compatible", baseUrl: "https://apis.iflow.cn/v1" }),
      apiKeyPlaintext: "sk-i",
    });
    expect(env).toEqual({ IFLOW_API_KEY: "sk-i", IFLOW_BASE_URL: "https://apis.iflow.cn/v1" });
  });

  it("无明文时该密钥变量缺席（不塞空串）", () => {
    const env = resolveRuntimeEnv({ runtime: "codex", provider: provider() });
    expect(env).toEqual({});
  });

  it("T9.11：本地 CLI 即使有密钥和网址也不注入", () => {
    const env = resolveRuntimeEnv({
      runtime: "claude-code",
      provider: provider({
        type: "openai_compatible",
        baseUrl: "https://hub.example/v1",
      }),
      apiKeyPlaintext: "sk-x",
      connectionMode: "local_cli",
    });
    expect(env).toEqual({});
  });

  it("T9.11：中转时 Claude / Gemini / Grok 注入各家网址变量", () => {
    const relay = {
      type: "openai_compatible" as const,
      baseUrl: "https://hub.example/v1",
    };
    expect(
      resolveRuntimeEnv({
        runtime: "claude-code",
        provider: provider(relay),
        apiKeyPlaintext: "sk-x",
        connectionMode: "relay",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "https://hub.example/v1" });
    expect(
      resolveRuntimeEnv({
        runtime: "gemini-cli",
        provider: provider(relay),
        apiKeyPlaintext: "sk-g",
        connectionMode: "relay",
      }),
    ).toEqual({ GEMINI_API_KEY: "sk-g", GEMINI_API_BASE: "https://hub.example/v1" });
    expect(
      resolveRuntimeEnv({
        runtime: "grok-build",
        provider: provider(relay),
        apiKeyPlaintext: "sk-z",
        connectionMode: "relay",
      }),
    ).toEqual({ XAI_API_KEY: "sk-z", XAI_BASE_URL: "https://hub.example/v1" });
  });
});

describe("resolveRuntimeConfigOverrides", () => {
  it("codex + openai_compatible + baseUrl → 装配 model_provider 路由（TOML 值）", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({
        type: "openai_compatible",
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
  });

  it("env_key 指向与 resolveRuntimeEnv 一致的 OPENAI_API_KEY", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
    });
    expect(overrides["model_providers.ffpane.env_key"]).toBe(
      JSON.stringify(runtimeApiKeyEnvVar("codex")),
    );
  });

  it("name 缺省退化为 slug，特殊字符经 JSON.stringify 转义为合法 TOML 串", () => {
    const overrides = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ type: "openai_compatible", name: 'A"B', baseUrl: "https://x.test" }),
    });
    expect(overrides["model_providers.ffpane.name"]).toBe('"A\\"B"');
  });

  it("非 codex 运行时不产生覆盖", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "claude-code",
        provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
      }),
    ).toEqual({});
  });

  it("codex 但非 openai_compatible（如 cli_login）不产生覆盖", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ type: "cli_login" }),
      }),
    ).toEqual({});
  });

  it("openai_compatible 但缺 baseUrl 不产生覆盖（无从路由）", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ type: "openai_compatible" }),
      }),
    ).toEqual({});
  });

  it("T9.4b：codex 显式 effort 并入 model_reasoning_effort（TOML 字符串）", () => {
    const withRoute = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
      reasoningEffort: "high",
    });
    expect(withRoute["model_reasoning_effort"]).toBe('"high"');
    expect(withRoute["model_provider"]).toBe("ffpane");
    const cliLogin = resolveRuntimeConfigOverrides({
      runtime: "codex",
      provider: provider({ type: "cli_login" }),
      reasoningEffort: "high",
    });
    expect(cliLogin).toEqual({ model_reasoning_effort: '"high"' });
  });

  it("T9.11：本地 CLI 即使 Provider 带网址也不装配 codex 路由", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "codex",
        provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
        connectionMode: "local_cli",
      }),
    ).toEqual({});
  });

  it("T9.4b：gemini-cli 即使传入 effort 也不进 overrides", () => {
    expect(
      resolveRuntimeConfigOverrides({
        runtime: "gemini-cli",
        provider: provider({ type: "openai_compatible", baseUrl: "https://x.test" }),
        reasoningEffort: "high",
      }),
    ).toEqual({});
  });
});
