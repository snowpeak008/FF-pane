/**
 * W1.5a 单测：Provider CRUD 与配置持久化，全部走 mkdtemp 临时目录真实读写。
 * 覆盖：四类型校验矩阵（合法/非法逐条）、CRUD round-trip（含中文 name）、
 * 首次使用空集、模型引用校验、删除保护钩子、W1.2a 损坏隔离语义的向上传递。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiKeyRef,
  ModelKind,
  ProviderId,
  ProviderModel,
  ProviderType,
} from "@ff-pane/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProviderStore,
  PROVIDERS_FILE_VERSION,
  type ProviderDraft,
  ProviderInUseError,
  ProviderNotFoundError,
  type ProviderStore,
  ProvidersFileInvalidError,
  ProviderValidationError,
  resolveGlobalLayout,
  StorageCorruptJsonError,
  validateProviderDraft,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;
let providersFile: string;
let store: ProviderStore;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-providers-"));
  // 走 W1.2a 布局的规范路径，验证与 resolveGlobalLayout 的接线方式
  providersFile = resolveGlobalLayout(join(tempRoot, ".aiworkbench")).providersFile;
  store = createProviderStore(providersFile);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const CHAT_MODEL: ProviderModel = {
  id: "deepseek-chat",
  displayName: "DeepSeek Chat",
  kind: "chat",
};
const EMBEDDING_MODEL: ProviderModel = {
  id: "text-embedding-v1",
  displayName: "嵌入模型",
  kind: "embedding",
};

function openAiDraft(): ProviderDraft {
  return {
    name: "我的 DeepSeek",
    type: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyRef: "keyref-deepseek-001" as ApiKeyRef,
    models: [CHAT_MODEL, EMBEDDING_MODEL],
    defaultModel: "deepseek-chat",
    embeddingModel: "text-embedding-v1",
    timeoutS: 120,
    enabled: true,
  };
}

function anthropicDraft(): ProviderDraft {
  return {
    name: "Anthropic 官方",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyRef: "keyref-anthropic-001" as ApiKeyRef,
    models: [{ id: "claude-sonnet", displayName: "Claude Sonnet", kind: "chat" }],
    defaultModel: "claude-sonnet",
    enabled: true,
  };
}

function cliLoginDraft(): ProviderDraft {
  return {
    name: "Claude 订阅登录",
    type: "cli_login",
    models: [],
    enabled: true,
  };
}

function customDraft(): ProviderDraft {
  return {
    name: "自定义服务",
    type: "custom",
    requestTemplate: '{ "method": "POST", "path": "/v1/chat" }',
    models: [CHAT_MODEL],
    defaultModel: "deepseek-chat",
    enabled: true,
  };
}

/** 断言草稿校验失败且违规字段名正确（typed error 带字段名）。 */
function expectViolation(draft: ProviderDraft, field: string): void {
  let thrown: unknown;
  try {
    validateProviderDraft(draft);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProviderValidationError);
  const violation = thrown as ProviderValidationError;
  expect(violation.code).toBe("provider-validation");
  expect(violation.field).toBe(field);
  expect(violation.message).toContain(field);
}

describe("首次使用与文件持久化", () => {
  it("文件不存在视为空集：list 返回 []、get 返回 undefined，不抛错", async () => {
    expect(await store.listProviders()).toEqual([]);
    expect(await store.getProvider("provider-000000000000" as ProviderId)).toBeUndefined();
  });

  it("首个 create 自动建档：落盘为 version 字段 + 条目数组", async () => {
    const created = await store.createProvider(openAiDraft());
    const raw = JSON.parse(await readFile(providersFile, "utf8")) as {
      version: number;
      providers: unknown[];
    };
    expect(raw.version).toBe(PROVIDERS_FILE_VERSION);
    expect(raw.providers).toHaveLength(1);
    expect(raw.providers[0]).toEqual(created);
  });

  it("JSON 语法损坏：沿用 W1.2a 隔离语义并向上传递 StorageCorruptJsonError，之后回到空集", async () => {
    // writeTextAtomic 自动补建父目录，模拟用户手改后损坏的 providers.json
    await writeTextAtomic(providersFile, '{ "version": 1, 坏掉了');
    await expect(store.listProviders()).rejects.toBeInstanceOf(StorageCorruptJsonError);
    // 原文件已被 W1.2a 隔离让位，下次读取走首次使用路径
    expect(await store.listProviders()).toEqual([]);
  });

  it("合法 JSON 但结构不符：顶层非对象 / version 不支持 / providers 非数组均抛 typed error", async () => {
    await writeJsonAtomic(providersFile, [1, 2, 3]);
    await expect(store.listProviders()).rejects.toBeInstanceOf(ProvidersFileInvalidError);

    await writeJsonAtomic(providersFile, { version: 999, providers: [] });
    await expect(store.listProviders()).rejects.toMatchObject({
      code: "providers-file-invalid",
      path: providersFile,
    });

    await writeJsonAtomic(providersFile, { version: 1, providers: "不是数组" });
    await expect(store.listProviders()).rejects.toBeInstanceOf(ProvidersFileInvalidError);
  });
});

describe("CRUD round-trip", () => {
  it("create → get / list 全字段保真（含中文 name、可选字段）", async () => {
    const created = await store.createProvider(openAiDraft());
    expect(created.name).toBe("我的 DeepSeek");

    const fetched = await store.getProvider(created.id);
    expect(fetched).toEqual(created);
    expect(await store.listProviders()).toEqual([created]);
  });

  it("id 策略：provider- 前缀 + 12 位十六进制随机段，多次创建互不相同", async () => {
    const first = await store.createProvider(openAiDraft());
    const second = await store.createProvider(anthropicDraft());
    const third = await store.createProvider(cliLoginDraft());
    const ids = [first.id, second.id, third.id];
    for (const id of ids) {
      expect(id).toMatch(/^provider-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("name 允许重复，id 保持唯一", async () => {
    const a = await store.createProvider(openAiDraft());
    const b = await store.createProvider(openAiDraft());
    expect(a.name).toBe(b.name);
    expect(a.id).not.toBe(b.id);
    expect(await store.listProviders()).toHaveLength(2);
  });

  it("update 全量替换（id 不变），可清除可选字段以切换类型", async () => {
    const created = await store.createProvider(openAiDraft());
    const updated = await store.updateProvider(created.id, cliLoginDraft());
    expect(updated.id).toBe(created.id);
    expect(updated.type).toBe("cli_login");
    expect(updated.baseUrl).toBeUndefined();
    expect(updated.apiKeyRef).toBeUndefined();

    const fetched = await store.getProvider(created.id);
    expect(fetched).toEqual(updated);
    expect(await store.listProviders()).toHaveLength(1);
  });

  it("update 校验失败：抛错且不落盘（原数据保持不变）", async () => {
    const created = await store.createProvider(openAiDraft());
    const invalid: ProviderDraft = { ...openAiDraft(), timeoutS: -1 };
    await expect(store.updateProvider(created.id, invalid)).rejects.toBeInstanceOf(
      ProviderValidationError,
    );
    expect(await store.getProvider(created.id)).toEqual(created);
  });

  it("update / delete 不存在的 id 抛 ProviderNotFoundError", async () => {
    const missing = "provider-ffffffffffff" as ProviderId;
    await expect(store.updateProvider(missing, openAiDraft())).rejects.toMatchObject({
      code: "provider-not-found",
      providerId: missing,
    });
    await expect(store.deleteProvider(missing)).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it("delete 后条目移除，其余条目保留", async () => {
    const keep = await store.createProvider(openAiDraft());
    const drop = await store.createProvider(anthropicDraft());
    await store.deleteProvider(drop.id);
    expect(await store.listProviders()).toEqual([keep]);
    expect(await store.getProvider(drop.id)).toBeUndefined();
  });
});

describe("四类型校验矩阵（设计文档 §4.2）", () => {
  it("openai_compatible / anthropic 合法草稿通过", () => {
    expect(() => validateProviderDraft(openAiDraft())).not.toThrow();
    expect(() => validateProviderDraft(anthropicDraft())).not.toThrow();
  });

  it("openai_compatible / anthropic：缺 baseUrl 拒绝", () => {
    const { baseUrl: _baseUrl, ...withoutBaseUrl } = openAiDraft();
    expectViolation(withoutBaseUrl, "baseUrl");
    const { baseUrl: _anthropicBaseUrl, ...anthropicWithout } = anthropicDraft();
    expectViolation(anthropicWithout, "baseUrl");
  });

  it("openai_compatible：baseUrl 非 URL 形式 / 非 http(s) 协议拒绝", () => {
    expectViolation({ ...openAiDraft(), baseUrl: "不是 URL" }, "baseUrl");
    expectViolation({ ...openAiDraft(), baseUrl: "ftp://example.com" }, "baseUrl");
    expectViolation({ ...openAiDraft(), baseUrl: "" }, "baseUrl");
  });

  it("openai_compatible / anthropic：缺 apiKeyRef 或空引用拒绝", () => {
    const { apiKeyRef: _apiKeyRef, ...withoutKeyRef } = openAiDraft();
    expectViolation(withoutKeyRef, "apiKeyRef");
    expectViolation({ ...anthropicDraft(), apiKeyRef: "" as ApiKeyRef }, "apiKeyRef");
  });

  it("cli_login：无 baseUrl / apiKeyRef 的合法草稿通过", () => {
    expect(() => validateProviderDraft(cliLoginDraft())).not.toThrow();
  });

  it("cli_login：设置了 baseUrl 或 apiKeyRef 拒绝（必须无，§4.2）", () => {
    expectViolation({ ...cliLoginDraft(), baseUrl: "https://api.example.com" }, "baseUrl");
    expectViolation({ ...cliLoginDraft(), apiKeyRef: "keyref-x" as ApiKeyRef }, "apiKeyRef");
  });

  it("custom：带 requestTemplate 通过，可选搭配合法 baseUrl 与 apiKeyRef", () => {
    expect(() => validateProviderDraft(customDraft())).not.toThrow();
    expect(() =>
      validateProviderDraft({
        ...customDraft(),
        baseUrl: "https://special.example.com",
        apiKeyRef: "keyref-custom" as ApiKeyRef,
      }),
    ).not.toThrow();
  });

  it("custom：缺 requestTemplate 或空模板拒绝；baseUrl 若设置必须是 http(s) URL", () => {
    const { requestTemplate: _requestTemplate, ...withoutTemplate } = customDraft();
    expectViolation(withoutTemplate, "requestTemplate");
    expectViolation({ ...customDraft(), requestTemplate: "" }, "requestTemplate");
    expectViolation({ ...customDraft(), baseUrl: "无效地址" }, "baseUrl");
  });

  it("未知 Provider 类型拒绝（IPC / JSON 边界防线）", () => {
    expectViolation({ ...openAiDraft(), type: "grpc_magic" as ProviderType }, "type");
  });

  it("create / update 均强制执行校验（store 接线验证）", async () => {
    await expect(
      store.createProvider({ ...cliLoginDraft(), baseUrl: "https://x.example.com" }),
    ).rejects.toBeInstanceOf(ProviderValidationError);
    expect(await store.listProviders()).toEqual([]);

    const created = await store.createProvider(customDraft());
    await expect(
      store.updateProvider(created.id, { ...customDraft(), requestTemplate: "" }),
    ).rejects.toMatchObject({ code: "provider-validation", field: "requestTemplate" });
  });
});

describe("通用校验（设计文档 §4.1）", () => {
  it("models 内 id 重复拒绝，id 为空拒绝，kind 非法拒绝", () => {
    expectViolation({ ...openAiDraft(), models: [CHAT_MODEL, CHAT_MODEL] }, "models");
    expectViolation(
      { ...openAiDraft(), models: [{ id: "", displayName: "空 id", kind: "chat" }] },
      "models",
    );
    expectViolation(
      {
        ...openAiDraft(),
        models: [{ id: "vision-x", displayName: "越界", kind: "vision" as ModelKind }],
      },
      "models",
    );
  });

  it("defaultModel 不在 models 中拒绝；指向 embedding 模型（kind 不匹配）拒绝", () => {
    expectViolation({ ...openAiDraft(), defaultModel: "不存在的模型" }, "defaultModel");
    expectViolation({ ...openAiDraft(), defaultModel: EMBEDDING_MODEL.id }, "defaultModel");
  });

  it("embeddingModel 不在 models 中拒绝；指向 chat 模型（kind 不匹配）拒绝", () => {
    expectViolation({ ...openAiDraft(), embeddingModel: "不存在的模型" }, "embeddingModel");
    expectViolation({ ...openAiDraft(), embeddingModel: CHAT_MODEL.id }, "embeddingModel");
  });

  it("timeoutS 必须是正整数：0 / 负数 / 小数拒绝，正整数通过", () => {
    expectViolation({ ...openAiDraft(), timeoutS: 0 }, "timeoutS");
    expectViolation({ ...openAiDraft(), timeoutS: -5 }, "timeoutS");
    expectViolation({ ...openAiDraft(), timeoutS: 1.5 }, "timeoutS");
    expect(() => validateProviderDraft({ ...openAiDraft(), timeoutS: 300 })).not.toThrow();
  });
});

describe("删除保护钩子（Profile 引用检查归 W1.6）", () => {
  it("isInUse 判定被引用：抛 ProviderInUseError 且条目保留", async () => {
    const created = await store.createProvider(openAiDraft());
    await expect(store.deleteProvider(created.id, () => true)).rejects.toMatchObject({
      code: "provider-in-use",
      providerId: created.id,
    });
    expect(await store.getProvider(created.id)).toEqual(created);
  });

  it("异步 isInUse 回调同样生效，且收到被删条目的 id", async () => {
    const created = await store.createProvider(anthropicDraft());
    const receivedIds: ProviderId[] = [];
    await expect(
      store.deleteProvider(created.id, async (id) => {
        receivedIds.push(id);
        return true;
      }),
    ).rejects.toBeInstanceOf(ProviderInUseError);
    expect(receivedIds).toEqual([created.id]);
  });

  it("isInUse 判定未被引用或未传钩子：正常删除", async () => {
    const a = await store.createProvider(openAiDraft());
    const b = await store.createProvider(cliLoginDraft());
    await store.deleteProvider(a.id, () => false);
    await store.deleteProvider(b.id);
    expect(await store.listProviders()).toEqual([]);
  });
});
