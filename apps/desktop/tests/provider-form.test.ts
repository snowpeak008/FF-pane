import type { ApiKeyRef, Provider, ProviderId } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  buildProviderDraft,
  cleanModels,
  emptyProviderForm,
  formFromProvider,
  type ProviderFormState,
  supportsProbe,
  usesApiKey,
  usesBaseUrl,
  usesProxy,
} from "../src/renderer/src/pages/settings/providers/provider-form";

describe("字段显隐规则", () => {
  it("baseUrl：官方可选、兼容必填、local-login 隐藏", () => {
    expect(usesBaseUrl("openai-compatible")).toBe(true);
    expect(usesBaseUrl("anthropic-compatible")).toBe(true);
    expect(usesBaseUrl("openai-official")).toBe(true);
    expect(usesBaseUrl("local-login")).toBe(false);
  });

  it("apiKey：非 local-login 经手", () => {
    expect(usesApiKey("openai-compatible")).toBe(true);
    expect(usesApiKey("anthropic-official")).toBe(true);
    expect(usesApiKey("local-login")).toBe(false);
  });

  it("proxy：与 baseUrl 同域", () => {
    expect(usesProxy("openai-compatible")).toBe(true);
    expect(usesProxy("local-login")).toBe(false);
  });

  it("探测：openai/anthropic 族支持，local-login 不支持", () => {
    expect(supportsProbe("openai-compatible")).toBe(true);
    expect(supportsProbe("anthropic-compatible")).toBe(true);
    expect(supportsProbe("local-login")).toBe(false);
  });
});

describe("cleanModels", () => {
  it("裁剪空白、剔除空 id 行", () => {
    const rows = [
      { id: "  gpt-4  ", label: " GPT-4 ", kind: "chat" as const },
      { id: "   ", label: "空", kind: "chat" as const },
    ];
    expect(cleanModels(rows)).toEqual([{ id: "gpt-4", label: "GPT-4", kind: "chat" }]);
  });
});

describe("buildProviderDraft", () => {
  function form(overrides: Partial<ProviderFormState>): ProviderFormState {
    return { ...emptyProviderForm(), ...overrides };
  }

  it("openai-compatible：带 baseUrl、模型、默认模型", () => {
    const draft = buildProviderDraft(
      form({
        name: "  DeepSeek  ",
        templateId: "openai-compatible",
        baseUrl: " https://api.deepseek.com/v1 ",
        models: [{ id: "deepseek-chat", label: "DeepSeek Chat", kind: "chat" }],
        defaultModelId: "deepseek-chat",
      }),
    );
    expect(draft.name).toBe("DeepSeek");
    expect(draft.templateId).toBe("openai-compatible");
    expect(draft.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(draft.models).toEqual([{ id: "deepseek-chat", label: "DeepSeek Chat", kind: "chat" }]);
    expect(draft.defaultModelId).toBe("deepseek-chat");
    expect(draft.enabled).toBe(true);
    expect(draft.createdAt).toBeTypeOf("number");
    expect(draft.updatedAt).toBeTypeOf("number");
  });

  it("local-login：省略 baseUrl（即便表单里有残留值）", () => {
    const draft = buildProviderDraft(
      form({ name: "Claude CLI", templateId: "local-login", baseUrl: "https://leftover" }),
    );
    expect(draft.templateId).toBe("local-login");
    expect(draft.name).toBe("Claude CLI");
    expect("baseUrl" in draft).toBe(false);
  });

  it("defaultModelId 不在 models 中时省略", () => {
    const draft = buildProviderDraft(
      form({
        templateId: "openai-compatible",
        baseUrl: "https://x/v1",
        defaultModelId: "ghost",
      }),
    );
    expect("defaultModelId" in draft).toBe(false);
  });

  it("timeoutS 空串省略；有值写入", () => {
    expect("timeoutS" in buildProviderDraft(form({ templateId: "local-login" }))).toBe(false);
    const draft = buildProviderDraft(form({ templateId: "local-login", timeoutS: "60" }));
    expect(draft.timeoutS).toBe(60);
  });

  it("proxy：仅在适用模板写入", () => {
    const direct = buildProviderDraft(
      form({
        templateId: "openai-compatible",
        baseUrl: "https://x/v1",
        proxy: "http://127.0.0.1:7890",
      }),
    );
    expect(direct.proxy).toBe("http://127.0.0.1:7890");
    const cli = buildProviderDraft(
      form({ templateId: "local-login", proxy: "http://127.0.0.1:7890" }),
    );
    expect("proxy" in cli).toBe(false);
  });
});

describe("formFromProvider / 往返", () => {
  const sample: Provider = {
    id: "provider-1" as ProviderId,
    name: "DS",
    templateId: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyRef: "keyref-1" as ApiKeyRef,
    models: [{ id: "deepseek-chat", label: "DeepSeek Chat", kind: "chat" }],
    defaultModelId: "deepseek-chat",
    proxy: "http://127.0.0.1:7890",
    timeoutS: 90,
    enabled: true,
    createdAt: 100,
    updatedAt: 200,
  };

  it("读入既有 Provider 保留可选字段", () => {
    const form = formFromProvider(sample);
    expect(form.templateId).toBe("openai-compatible");
    expect(form.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(form.defaultModelId).toBe("deepseek-chat");
    expect(form.proxy).toBe("http://127.0.0.1:7890");
    expect(form.timeoutS).toBe("90");
    expect(form.createdAt).toBe(100);
  });

  it("local-login 往返不带 baseUrl", () => {
    const local: Provider = {
      id: "provider-2" as ProviderId,
      name: "Claude CLI",
      templateId: "local-login",
      models: [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const draft = buildProviderDraft(formFromProvider(local));
    expect(draft.templateId).toBe("local-login");
    expect("baseUrl" in draft).toBe(false);
  });
});
