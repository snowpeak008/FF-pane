# Provider 模板说明（T10.3）

> 状态：随 T10.3 落地。权威合同见 `docs/Phase10-多窗口终端工作台计划.md` §3.4。

## 1. 一句话

加一条中转站 = 在设置里**选模板 → 填表**；加一种全新接入方式 = 在模板表里**加一条纯数据** + **i18n**；若注入形态与现有模板不同，再在注入映射表加一行。

## 2. 新 schema（`providers.json` version 2）

```ts
{
  id, name, templateId,
  baseUrl?, apiKeyRef?,
  models: [{ id, label?, contextWindowTokens?, kind? }],
  defaultModelId?, embeddingModel?,
  proxy?, extraEnv?, options?,
  timeoutS?, enabled,
  createdAt, updatedAt
}
```

产品决策（相对 Phase10 裸 schema 的最小增补）：

| 字段 | 原因 |
|---|---|
| `enabled` | 列表停用 / RAG 门槛 |
| `embeddingModel` + `models[].kind` | 知识库嵌入 |
| `timeoutS` | 探测与嵌入超时 |

旧 `version: 1` 文件在首次读取时自动迁移：写旁路备份 `providers.json.bak-v1`，幂等，损坏则保留原文件并报错。`apiKeyRef` 与密钥库不动；Profile 对 provider id 的引用保持有效。

### 迁移映射

| 旧 type | 新 templateId | 兼容 options |
|---|---|---|
| `openai_compatible` | `openai-official`（官方 origin）/ `openai-compatible` | 剥离废弃 `wire_api` |
| `anthropic` | `anthropic-official`（官方 origin）/ `anthropic-compatible` | 中转写入 `authHeaderStyle=api_key`（旧流程恒 `ANTHROPIC_API_KEY`） |
| `cli_login` | `local-login` | — |
| `custom` | 尽力：`anthropic-compatible`（URL 含 anthropic）或 `openai-compatible`；`requestTemplate` 进 `options` | → anthropic-compatible 时同样写 `authHeaderStyle=api_key` |

新建的 `anthropic-compatible` 仍默认 `AUTH_TOKEN`（Bearer）；仅**迁移**路径强制 `api_key` 以保持旧中转站可连。

## 3. 内置模板

定义位置：`packages/shared/src/domain/provider-templates.ts`（`BUILTIN_PROVIDER_TEMPLATES`）。

| templateId | 适用 CLI | 探测 | 要点 |
|---|---|---|---|
| `anthropic-official` | claude-code | anthropic | 默认 `https://api.anthropic.com`；密钥 → `ANTHROPIC_API_KEY` |
| `anthropic-compatible` | claude-code | anthropic | 必填地址；默认 `ANTHROPIC_AUTH_TOKEN`（Bearer），可选 `ANTHROPIC_API_KEY` |
| `openai-official` | codex（兼 claude-code） | openai | 默认 `https://api.openai.com/v1` |
| `openai-compatible` | codex（兼 claude-code） | openai | 必填地址；Codex 不写 `wire_api`（现行缺省 responses） |
| `local-login` | claude-code · codex | none | 不注入；宿主壳层密钥仍由 adapters 清洗 |

## 4. 注入解析器

- 位置：`packages/core/src/provider-injection/`（`PROVIDER_INJECTION_MAPPINGS` + `resolveProviderInjection`）
- Claude：环境变量（地址 / 密钥 / `ANTHROPIC_MODEL`）
- Codex：`-c model_provider=...` + `model_providers.<slug>.{name,base_url,env_key}`；**不写 `wire_api`**（与旧流程一致；现行 Codex 只认 responses，chat 已移除）；**密钥只进 env_key 指向的环境变量**，永不进 args / 落盘文件
- `extraEnv` 合并，但不得覆盖密钥变量；危险变量（`PATH` / `NODE_OPTIONS` / `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` 等）在**落盘校验**与注入时一律拒绝
- 旧会话流程 `apps/desktop/src/main/session/env.ts` 对 claude-code / codex 已改调本解析器；其它 Runtime（Grok 等）保留旧路径

## 5. 如何新增模板

**新增模板 = 模板数据 + i18n；若注入形态新，再加一行映射数据。**

1. `packages/shared/src/domain/provider.ts`：把新 id 加入 `PROVIDER_TEMPLATE_IDS`
2. `packages/shared/src/domain/provider-templates.ts`：在 `BUILTIN_PROVIDER_TEMPLATES` 追加一条（字段要求、默认 URL、probe、options、applicableClis）
3. `locales/zh-CN.json` + `locales/en-US.json`：补 `settings.providers.template.<id>.{name,description}`，以及新 options 的文案
4. **若注入形态与现有模板不同**：在 `packages/core/src/provider-injection/resolve.ts` 的 `PROVIDER_INJECTION_MAPPINGS` 为每个适用 CLI 加一行占位符映射（形态相同可复制改 id）
5. （可选）单测：在 `packages/core/tests/provider-injection.test.ts` 加一条快照

**不应改**：探测分发（按 `probe` kind）、存储校验（读模板声明）、编辑对话框（读模板卡片）、MCP draft schema（读 `PROVIDER_TEMPLATE_IDS`）。

## 6. 旧流程兼容

- Phase 10 期间后台会话流程保持可用（T10.11 才下线）
- Profile `connectionMode` 仍可显式指定；缺省时按 `templateId === local-login` 推断本地 CLI
- openai-* 模板对 claude-code 保留 ANTHROPIC_* 注入，以兼容旧「openai_compatible + Claude 中转」档案
- 从旧 `anthropic` / `custom→anthropic` 迁来的中转站带 `authHeaderStyle=api_key`，避免升级后认证失败
