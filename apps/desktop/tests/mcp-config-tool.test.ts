/**
 * 工作台自配置工具纯模块单测（T9.1）：工具声明、入参解析、脱敏视图、结果渲染。
 *
 * 铁律 1 的两层守卫在此钉死（合同验收第一条）：
 * - schema 守卫：直读四个工具的 inputSchema，断言**物理不含任何密钥字段**；
 * - 脱敏守卫：sanitizeProvider 输出不含 apiKeyRef/key，只有 apiKeyConfigured 布尔。
 */

import type { AgentProfile, Provider } from "@ff-pane/shared";
import { CONFIG_TOOL_NAMES } from "@ff-pane/shared";
import { describe, expect, it } from "vitest";
import {
  CONFIG_PROFILE_DRAFT_FIELDS,
  CONFIG_PROVIDER_DRAFT_FIELDS,
  CONFIG_TOOLS,
  describeDraft,
  KEY_REFUSAL_NOTE,
  PRESET_FROM_GLOBAL_DEFAULT,
  parseProfileDraftArgs,
  parseProviderDraftArgs,
  renderDraftOutcome,
  renderProviderList,
  sanitizeProvider,
} from "../src/mcp/config-tool";

/** 密钥字样模式（与实现的拒收正则同口径，测试独立声明防实现改了测试跟着松）。 */
const SECRET_PATTERN = /key|secret|token|credential|password/i;

/** 递归收集一个 JSON Schema 里全部 properties 键名。 */
function collectPropertyKeys(schema: unknown, out: string[] = []): string[] {
  if (typeof schema !== "object" || schema === null) {
    return out;
  }
  const record = schema as Record<string, unknown>;
  const properties = record["properties"];
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      out.push(key);
      collectPropertyKeys(value, out);
    }
  }
  const items = record["items"];
  if (items !== undefined) {
    collectPropertyKeys(items, out);
  }
  return out;
}

const PROVIDER: Provider = {
  id: "provider-abc123" as Provider["id"],
  name: "DeepSeek",
  type: "openai_compatible",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyRef: "secret-ref-xyz" as NonNullable<Provider["apiKeyRef"]>,
  models: [
    { id: "deepseek-chat" as Provider["models"][number]["id"], displayName: "Chat", kind: "chat" },
  ],
  defaultModel: "deepseek-chat" as NonNullable<Provider["defaultModel"]>,
  enabled: true,
};

describe("铁律 1 —— 工具 schema 物理不含密钥字段（合同验收：读 schema 断言）", () => {
  it("四个工具全部声明且名称与 shared 常量一致", () => {
    expect(CONFIG_TOOLS.map((tool) => tool.name)).toEqual([...CONFIG_TOOL_NAMES]);
  });

  it("任何工具的 inputSchema 里没有一个键名带密钥字样（递归含嵌套子 schema）", () => {
    for (const tool of CONFIG_TOOLS) {
      const keys = collectPropertyKeys(tool.inputSchema);
      for (const key of keys) {
        expect(SECRET_PATTERN.test(key), `${tool.name} 的 schema 含密钥字样键：${key}`).toBe(false);
      }
    }
  });

  it("字段白名单同样不含密钥字样（解析器的第二道物理关口）", () => {
    for (const field of [...CONFIG_PROVIDER_DRAFT_FIELDS, ...CONFIG_PROFILE_DRAFT_FIELDS]) {
      expect(SECRET_PATTERN.test(field), `白名单含密钥字样字段：${field}`).toBe(false);
    }
  });

  it("四个工具的描述都写明不得向用户索要密钥（除 list_profiles——Profile 无密钥语境）", () => {
    for (const tool of CONFIG_TOOLS) {
      if (tool.name === "config_list_profiles") {
        continue;
      }
      expect(tool.description, `${tool.name} 描述缺拒收话术`).toContain(KEY_REFUSAL_NOTE);
    }
  });

  it("draft 工具的 schema 关闭 additionalProperties（未知键在协议层就进不来）", () => {
    for (const tool of CONFIG_TOOLS) {
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
    }
  });
});

describe("铁律 1 —— 脱敏视图（list 工具的输出）", () => {
  it("key 折算为 apiKeyConfigured 布尔，引用与本体都不出现", () => {
    const view = sanitizeProvider(PROVIDER);
    expect(view.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-ref-xyz");
    expect("apiKeyRef" in view).toBe(false);
  });

  it("未配置密钥 → apiKeyConfigured=false", () => {
    const { apiKeyRef: _dropped, ...rest } = PROVIDER;
    expect(sanitizeProvider(rest as Provider).apiKeyConfigured).toBe(false);
  });

  it("renderProviderList 的整段文本不含密钥引用，且明示 key 永不返回", () => {
    const text = renderProviderList([PROVIDER]);
    expect(text).not.toContain("secret-ref-xyz");
    expect(text).toContain("apiKeyConfigured");
    expect(text).toContain("API keys are never included");
  });
});

describe("parseProviderDraftArgs（严进白名单）", () => {
  const VALID = {
    name: "DeepSeek",
    type: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: [{ id: "deepseek-chat", displayName: "Chat", kind: "chat" }],
    defaultModel: "deepseek-chat",
  };

  it("合法入参 → 解析成功，enabled 缺省补 true", () => {
    const result = parseProviderDraftArgs(VALID);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.kind === "provider") {
      expect(result.parsed.id).toBeUndefined();
      expect(result.parsed.draft.enabled).toBe(true);
      expect(result.parsed.draft.name).toBe("DeepSeek");
    } else {
      expect.unreachable("解析应产出 provider 草案");
    }
  });

  it("带 id 即更新语义", () => {
    const result = parseProviderDraftArgs({ ...VALID, id: "provider-abc123" });
    expect(result.ok && result.parsed.id === "provider-abc123").toBe(true);
  });

  it("密钥字样的键给出明确拒收话术（铁律 1 的第三道关口：运行期兜住绕过 schema 的客户端）", () => {
    const result = parseProviderDraftArgs({ ...VALID, apiKey: "sk-123" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(KEY_REFUSAL_NOTE);
    }
  });

  it("apiKeyRef 同样拒收", () => {
    const result = parseProviderDraftArgs({ ...VALID, apiKeyRef: "ref-1" });
    expect(result.ok).toBe(false);
  });

  it("普通未知键给出白名单指引", () => {
    const result = parseProviderDraftArgs({ ...VALID, colour: "red" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown field");
      expect(result.error).toContain("colour");
    }
  });

  it("必填缺失 / models 结构不符 → 指向字段的错误", () => {
    expect(parseProviderDraftArgs({ type: "custom", models: [] }).ok).toBe(false);
    const bad = parseProviderDraftArgs({ ...VALID, models: [{ id: "m" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("models[0]");
    }
  });
});

describe("parseProfileDraftArgs", () => {
  const VALID = {
    name: "Worker",
    runtime: "codex",
    providerId: "provider-abc123",
    defaultRole: "worker",
  };

  it("permissionPreset 缺省 → 以哨兵表达（主进程替换为全局默认）", () => {
    const result = parseProfileDraftArgs(VALID);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.kind === "profile") {
      expect(result.parsed.draft.permissionPreset).toBe(PRESET_FROM_GLOBAL_DEFAULT);
    }
  });

  it("哨兵语义是最保守一侧：空写权限 + 禁 shell + 禁网络 + 危险操作恒确认", () => {
    expect(PRESET_FROM_GLOBAL_DEFAULT.writePaths).toEqual([]);
    expect(PRESET_FROM_GLOBAL_DEFAULT.shell).toBe("forbidden");
    expect(PRESET_FROM_GLOBAL_DEFAULT.network).toBe(false);
    expect(PRESET_FROM_GLOBAL_DEFAULT.dangerousOpsRequireApproval).toBe(true);
  });

  it("显式 preset 里 dangerousOpsRequireApproval 给 false 也被纠正为 true（§7 第 5 项恒真）", () => {
    const result = parseProfileDraftArgs({
      ...VALID,
      permissionPreset: {
        readPaths: ["**"],
        writePaths: [],
        shell: "forbidden",
        network: false,
        dangerousOpsRequireApproval: false,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.kind === "profile") {
      expect(result.parsed.draft.permissionPreset.dangerousOpsRequireApproval).toBe(true);
    }
  });

  it("密钥字样键拒收（Profile 面同样把关）", () => {
    expect(parseProfileDraftArgs({ ...VALID, token: "x" }).ok).toBe(false);
  });

  it("T9.4b reasoningEffort 非空进草稿，空串省略", () => {
    const withEffort = parseProfileDraftArgs({ ...VALID, reasoningEffort: "high" });
    expect(withEffort.ok).toBe(true);
    if (withEffort.ok && withEffort.parsed.kind === "profile") {
      expect(withEffort.parsed.draft.reasoningEffort).toBe("high");
    }
    const empty = parseProfileDraftArgs({ ...VALID, reasoningEffort: "  " });
    expect(empty.ok).toBe(true);
    if (empty.ok && empty.parsed.kind === "profile") {
      expect("reasoningEffort" in empty.parsed.draft).toBe(false);
    }
  });

  it("genericExec 子对象结构校验", () => {
    const bad = parseProfileDraftArgs({ ...VALID, genericExec: { command: "" } });
    expect(bad.ok).toBe(false);
    const good = parseProfileDraftArgs({
      ...VALID,
      genericExec: { command: "mytool", args: ["{task}"], taskDelivery: "argv" },
    });
    expect(good.ok).toBe(true);
  });
});

describe("结果渲染（回给模型的文本）", () => {
  it("describeDraft：create/update × kind × 名称", () => {
    const parsed = parseProviderDraftArgs({
      name: "X",
      type: "cli_login",
      models: [{ id: "m", displayName: "M", kind: "chat" }],
    });
    expect(parsed.ok && describeDraft(parsed.parsed)).toBe('create provider "X"');
  });

  it("confirmed 提到密钥由 UI 引导补填、模型不得经手", () => {
    const text = renderDraftOutcome({ id: "d1", outcome: "confirmed", resultId: "provider-1" });
    expect(text).toContain("provider-1");
    expect(text).toContain("must not");
  });

  it("rejected 带原因并劝阻原样重交；timeout 说明未保存；invalid 给校验原文", () => {
    expect(
      renderDraftOutcome({ id: "d", outcome: "rejected", message: "wrong base url" }),
    ).toContain("wrong base url");
    expect(renderDraftOutcome({ id: "d", outcome: "timeout" })).toContain("Nothing was saved");
    expect(
      renderDraftOutcome({ id: "d", outcome: "invalid", message: "baseUrl required" }),
    ).toContain("baseUrl required");
  });
});

/** T9.1 类型守卫：ConfigProfileDraft 与 AgentProfile 除 id 外同构（编译期断言，运行期恒过）。 */
it("Profile 草案形状与领域 Profile 对齐（除 id）", () => {
  const draft: Omit<AgentProfile, "id"> = {
    name: "n",
    runtime: "codex" as AgentProfile["runtime"],
    providerId: "provider-1" as AgentProfile["providerId"],
    defaultRole: "worker",
    permissionPreset: PRESET_FROM_GLOBAL_DEFAULT,
  };
  expect(draft.name).toBe("n");
});
