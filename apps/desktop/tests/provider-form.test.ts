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

/**
 * 读入侧与往返闭合：providers:update 是整表单替换，故 formFromProvider 漏读任何
 * 可选字段 = 用户编辑一次就静默丢值（proxy 曾经就是这样丢的）。这里把闭合钉住。
 */
describe("formFromProvider 与 provider → 表单态 → draft 往返", () => {
  const FULL: Provider = {
    id: "prv_1" as ProviderId,
    name: "DeepSeek",
    type: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyRef: "key_1" as ApiKeyRef,
    models: [
      { id: "deepseek-chat", displayName: "DeepSeek Chat", kind: "chat" },
      { id: "bge-m3", displayName: "BGE M3", kind: "embedding" },
    ],
    defaultModel: "deepseek-chat",
    embeddingModel: "bge-m3",
    proxy: "http://127.0.0.1:7890",
    timeoutS: 60,
    enabled: false,
  };

  it("全字段往返恒等：draft 等于 Provider 去掉 id 与 apiKeyRef", () => {
    const draft = buildProviderDraft(formFromProvider(FULL));
    const { id: _id, apiKeyRef: _ref, ...expected } = FULL;
    expect(draft).toEqual(expected);
  });

  it("proxy 逐字往返，timeoutS 数字 → 字符串 → 数字不失真", () => {
    const state = formFromProvider(FULL);
    expect(state.proxy).toBe("http://127.0.0.1:7890");
    expect(state.timeoutS).toBe("60");
    const draft = buildProviderDraft(state);
    expect(draft.proxy).toBe("http://127.0.0.1:7890");
    expect(draft.timeoutS).toBe(60);
  });

  it("缺省的可选字段读为空串，写出时仍省略（不凭空造字段）", () => {
    const minimal: Provider = {
      id: "prv_2" as ProviderId,
      name: "Claude CLI",
      type: "cli_login",
      models: [],
      enabled: true,
    };
    const state = formFromProvider(minimal);
    expect(state.baseUrl).toBe("");
    expect(state.proxy).toBe("");
    expect(state.timeoutS).toBe("");
    expect(state.requestTemplate).toBe("");
    const draft = buildProviderDraft(state);
    expect(draft).toEqual({ name: "Claude CLI", type: "cli_login", models: [], enabled: true });
  });

  it("cli_login 的 proxy 按既有口径刻意丢弃（其网络由 CLI 自管）", () => {
    const cli: Provider = {
      id: "prv_3" as ProviderId,
      name: "Claude CLI",
      type: "cli_login",
      models: [],
      proxy: "http://127.0.0.1:7890",
      enabled: true,
    };
    expect(formFromProvider(cli).proxy).toBe("http://127.0.0.1:7890");
    expect("proxy" in buildProviderDraft(formFromProvider(cli))).toBe(false);
  });

  it("读入侧覆盖表单态全部键（新增字段忘了读入即在此变红）", () => {
    expect(Object.keys(formFromProvider(FULL)).sort()).toEqual(
      Object.keys(emptyProviderForm()).sort(),
    );
  });
});
