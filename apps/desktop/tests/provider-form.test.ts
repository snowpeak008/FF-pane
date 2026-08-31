import { describe, expect, it } from "vitest";
import {
  buildProviderDraft,
  cleanModels,
  emptyProviderForm,
  type ProviderFormState,
  supportsProbe,
  usesApiKey,
  usesBaseUrl,
  usesProxy,
  usesRequestTemplate,
} from "../src/renderer/src/pages/settings/providers/provider-form";

describe("字段显隐规则", () => {
  it("baseUrl：openai/anthropic/custom 需要，cli_login 不需要", () => {
    expect(usesBaseUrl("openai_compatible")).toBe(true);
    expect(usesBaseUrl("anthropic")).toBe(true);
    expect(usesBaseUrl("custom")).toBe(true);
    expect(usesBaseUrl("cli_login")).toBe(false);
  });

  it("apiKey：仅 openai/anthropic 经手", () => {
    expect(usesApiKey("openai_compatible")).toBe(true);
    expect(usesApiKey("anthropic")).toBe(true);
    expect(usesApiKey("cli_login")).toBe(false);
    expect(usesApiKey("custom")).toBe(false);
  });

  it("proxy：与 baseUrl 同域——cli_login 的网络由 CLI 自管，不在工作台配代理", () => {
    expect(usesProxy("openai_compatible")).toBe(true);
    expect(usesProxy("anthropic")).toBe(true);
    expect(usesProxy("custom")).toBe(true);
    expect(usesProxy("cli_login")).toBe(false);
  });

  it("requestTemplate 仅 custom；探测仅 openai/anthropic", () => {
    expect(usesRequestTemplate("custom")).toBe(true);
    expect(usesRequestTemplate("openai_compatible")).toBe(false);
    expect(supportsProbe("openai_compatible")).toBe(true);
    expect(supportsProbe("cli_login")).toBe(false);
  });
});

describe("cleanModels", () => {
  it("裁剪空白、剔除空 id 行", () => {
    const rows = [
      { id: "  gpt-4  ", displayName: " GPT-4 ", kind: "chat" as const },
      { id: "   ", displayName: "空", kind: "chat" as const },
    ];
    expect(cleanModels(rows)).toEqual([{ id: "gpt-4", displayName: "GPT-4", kind: "chat" }]);
  });
});

describe("buildProviderDraft", () => {
  function form(overrides: Partial<ProviderFormState>): ProviderFormState {
    return { ...emptyProviderForm(), ...overrides };
  }

  it("openai：带 baseUrl、模型、默认模型；displayName 空回退为 id", () => {
    const draft = buildProviderDraft(
      form({
        name: "  DeepSeek  ",
        type: "openai_compatible",
        baseUrl: " https://api.deepseek.com/v1 ",
        models: [{ id: "deepseek-chat", displayName: "", kind: "chat" }],
        defaultModel: "deepseek-chat",
      }),
    );
    expect(draft).toEqual({
      name: "DeepSeek",
      type: "openai_compatible",
      enabled: true,
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat", displayName: "deepseek-chat", kind: "chat" }],
      defaultModel: "deepseek-chat",
    });
  });

  it("cli_login：省略 baseUrl（即便表单里有残留值）", () => {
    const draft = buildProviderDraft(
      form({ name: "Claude CLI", type: "cli_login", baseUrl: "https://leftover" }),
    );
    expect(draft).toEqual({ name: "Claude CLI", type: "cli_login", models: [], enabled: true });
    expect("baseUrl" in draft).toBe(false);
  });

  it("defaultModel 不在 models 中时省略（避免落库后校验失败）", () => {
    const draft = buildProviderDraft(
      form({ type: "openai_compatible", baseUrl: "https://x/v1", defaultModel: "ghost" }),
    );
    expect("defaultModel" in draft).toBe(false);
  });

  it("timeoutS 空串省略、有值转数字", () => {
    expect("timeoutS" in buildProviderDraft(form({ type: "cli_login" }))).toBe(false);
    const draft = buildProviderDraft(form({ type: "cli_login", timeoutS: "60" }));
    expect(draft.timeoutS).toBe(60);
  });

  it("proxy 空串省略、有值裁剪后带上；cli_login 一律省略", () => {
    const direct = buildProviderDraft(form({ type: "openai_compatible", baseUrl: "https://x/v1" }));
    expect("proxy" in direct).toBe(false);
    const proxied = buildProviderDraft(
      form({
        type: "openai_compatible",
        baseUrl: "https://x/v1",
        proxy: " http://127.0.0.1:7890 ",
      }),
    );
    expect(proxied.proxy).toBe("http://127.0.0.1:7890");
    const cli = buildProviderDraft(form({ type: "cli_login", proxy: "http://127.0.0.1:7890" }));
    expect("proxy" in cli).toBe(false);
  });

  it("custom：带 requestTemplate", () => {
    const draft = buildProviderDraft(form({ name: "X", type: "custom", requestTemplate: "{...}" }));
    expect(draft.requestTemplate).toBe("{...}");
  });
});
