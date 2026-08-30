/**
 * T4.2 Run 级密钥注入映射单测（§4.3）：按 Runtime 取环境变量名、cli_login 不注入、
 * 无明文不塞空串、codex 注入 base_url。纯逻辑。
 */

import type { Provider } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import { resolveRuntimeEnv, runtimeApiKeyEnvVar } from "../src/main/session/env";

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

  it("无明文时该密钥变量缺席（不塞空串）", () => {
    const env = resolveRuntimeEnv({ runtime: "codex", provider: provider() });
    expect(env).toEqual({});
  });
});
