/**
 * 工作台自配置工具的声明、入参解析、脱敏视图与结果渲染（T9.1，Phase 9）。
 *
 * 两条铁律（开发计划 Phase 9 章 T9.1，经用户 2026-09-06 批准）在本模块的落法：
 * 1. **API key 永不经过模型**：四个工具的输入 schema **物理上不含任何密钥字段**——
 *    不是校验拦截，而是字段不存在（{@link CONFIG_PROVIDER_DRAFT_FIELDS} 是白名单，
 *    apiKey / apiKeyRef 不在其中；解析器对白名单之外的键一律拒绝，键名像密钥时
 *    给出明确的拒收话术）。脱敏视图（{@link sanitizeProvider}）逐字段显式构造、
 *    绝不展开原对象，apiKeyRef 只折算为 apiKeyConfigured 布尔。
 * 2. **写操作强制用户确认**：本模块没有任何"落盘"能力——草案工具只产出一份要经
 *    信箱送去主进程、由用户在确认对话框裁决的草案。静默写在工具面上物理不存在
 *    （没有 delete 工具、没有跳过确认的参数）。
 *
 * 纯模块：不碰文件系统、不认识信箱路径，可完整快照单测（照 knowledge-tool.ts 款式）。
 */

import type {
  AgentProfile,
  AiOutputLanguage,
  ConfigToolOutcome,
  ConnectionMode,
  GenericExecProfileConfig,
  ModelId,
  PermissionEnvelope,
  ProjectConfig,
  ProjectConfigDraft,
  ProjectConfigRoute,
  ProjectId,
  Provider,
  ProviderId,
  ProviderModel,
  ProviderTemplateId,
  ReasoningEffortLevel,
  WorkbenchPermissionLevel,
} from "@ff-pane/shared";
import {
  CONFIG_TOOL_DRAFT_CONFIG,
  CONFIG_TOOL_DRAFT_PROFILE,
  CONFIG_TOOL_DRAFT_PROVIDER,
  CONFIG_TOOL_LIST_CONFIGS,
  CONFIG_TOOL_LIST_PROFILES,
  CONFIG_TOOL_LIST_PROVIDERS,
  CONNECTION_MODES,
  GENERIC_EXEC_DELIVERIES,
  isConnectionMode,
  isGenericExecDelivery,
  isProviderTemplateId,
  isShellPolicy,
  isWorkbenchPermissionLevel,
  MODEL_KINDS,
  PROVIDER_TEMPLATE_IDS,
  REASONING_EFFORT_LEVELS,
  SHELL_POLICIES,
  WORKBENCH_PERMISSION_LEVELS,
} from "@ff-pane/shared";
import type { McpToolDefinition } from "./protocol";

/** 密钥字样的键名模式：白名单之外撞上它时给出明确拒收话术（而不是笼统的"未知字段"）。 */
const SECRET_LIKE_KEY = /key|secret|token|credential|password/i;

/** 模型不得触碰密钥的拒收话术（工具描述与解析错误共用同一口径）。 */
export const KEY_REFUSAL_NOTE =
  "API keys are NEVER handled by this tool. Do not ask the user for a key and do not put a key " +
  "into any field; after the user confirms the draft, the workbench UI will guide them to enter " +
  "the key in a secure input that the model cannot see.";

const SECRET_VALUE = /^(?:sk[-_]|bearer\s)/i;

function isMisleadingCode(code: number): boolean {
  return (
    code <= 31 ||
    code === 127 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/** 展示用文本不得含会误导确认框的字符。换行、控制符、零宽字符、双向控制符都不收。 */
export function plainTextError(field: string, value: string): string | undefined {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isMisleadingCode(code)) {
      return `Field "${field}" cannot contain newlines, control characters, zero-width characters, or hidden direction marks.`;
    }
  }
  return undefined;
}

function rejectMisleading(field: string, value: string): string | undefined {
  return plainTextError(field, value);
}

function rejectSecretBagEntry(bag: string, key: string, value: string): string | undefined {
  const keyIsSecret = SECRET_LIKE_KEY.test(key);
  const valueIsSecret =
    SECRET_VALUE.test(value.trim()) || (bag === "extraEnv" && SECRET_LIKE_KEY.test(value));
  if (keyIsSecret || valueIsSecret) {
    return `${bag}.${key} is not accepted. ${KEY_REFUSAL_NOTE}`;
  }
  return rejectMisleading(`${bag}.${key}`, key) ?? rejectMisleading(`${bag}.${key}`, value);
}

/**
 * Provider 草案的字段白名单（= Provider 除 id / apiKeyRef 外的全部字段 + 可选 id 表示更新）。
 * **apiKey / apiKeyRef 不在此表**——这是铁律 1 的物理形态，单测直接读取断言。
 */
export const CONFIG_PROVIDER_DRAFT_FIELDS = [
  "id",
  "name",
  "templateId",
  "baseUrl",
  "models",
  "defaultModelId",
  "embeddingModel",
  "proxy",
  "timeoutS",
  "extraEnv",
  "options",
  "enabled",
] as const;

/** Profile 草案的字段白名单（= AgentProfile 除 id 外的全部字段 + 可选 id 表示更新）。 */
export const CONFIG_PROFILE_DRAFT_FIELDS = [
  "id",
  "name",
  "runtime",
  "providerId",
  "model",
  "defaultRole",
  "permissionPreset",
  "outputLanguage",
  "genericExec",
  "reasoningEffort",
  "connectionMode",
] as const;

/** Provider 草案（AI 可填的全部字段）：**类型层面就没有 apiKeyRef**。 */
export type ConfigProviderDraft = Omit<Provider, "id" | "apiKeyRef">;

/** Profile 草案（AI 可填的全部字段；Profile 本就无密钥字段）。 */
export type ConfigProfileDraft = Omit<AgentProfile, "id">;

/** 解析后的一份草案：kind 判别 + 可选 id（带 id 即更新）。 */
export type ParsedConfigDraft =
  | { readonly kind: "provider"; readonly id?: string; readonly draft: ConfigProviderDraft }
  | { readonly kind: "profile"; readonly id?: string; readonly draft: ConfigProfileDraft }
  | { readonly kind: "config"; readonly id?: string; readonly draft: ProjectConfigDraft };

/** 解析结果判别联合（照 knowledge-tool 的 ParseToolArgsResult 款式）。 */
export type ParseDraftResult =
  | { readonly ok: true; readonly parsed: ParsedConfigDraft }
  | { readonly ok: false; readonly error: string };

// ── 工具声明（四个；schema 是铁律 1 的物理证据，单测逐字段核对） ─────────────────

export const CONFIG_LIST_PROVIDERS_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_LIST_PROVIDERS,
  description:
    "List the workbench's configured model providers (sanitized view: id, name, templateId, base URL, " +
    "models, default models, enabled state, and whether an API key is configured as a boolean). " +
    `The API key itself is never returned. ${KEY_REFUSAL_NOTE}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const CONFIG_LIST_PROFILES_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_LIST_PROFILES,
  description:
    "List the workbench's agent profiles (id, name, runtime, provider, model, default role, " +
    "permission preset, output language). Use it to see what already exists before drafting.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** Provider 模型条目的子 schema。 */
const PROVIDER_MODEL_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Model ID as defined by the provider." },
    label: { type: "string", description: "Human-readable model name." },
    kind: { type: "string", enum: [...MODEL_KINDS], description: "chat or embedding." },
    contextWindowSize: {
      type: "integer",
      minimum: 1,
      description: "Optional context window size in tokens (maps to contextWindowTokens).",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

export const CONFIG_DRAFT_PROVIDER_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_DRAFT_PROVIDER,
  description:
    "Submit a draft to create or update a model provider from a built-in template. The draft is " +
    "validated by the workbench and then shown to the user in a confirmation dialog; NOTHING is " +
    "saved until the user explicitly confirms. Pass `id` to update an existing provider; omit it " +
    `to create a new one. ${KEY_REFUSAL_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Existing provider id to update; omit to create a new provider.",
      },
      name: { type: "string", description: "Display name." },
      templateId: {
        type: "string",
        enum: [...PROVIDER_TEMPLATE_IDS],
        description: "Built-in provider template id.",
      },
      baseUrl: {
        type: "string",
        description: "API base URL (http/https). Required for compatible relay templates.",
      },
      models: {
        type: "array",
        items: PROVIDER_MODEL_SCHEMA,
        description: "Model list.",
      },
      defaultModelId: {
        type: "string",
        description: "Default chat model id (must exist in models with kind=chat).",
      },
      embeddingModel: {
        type: "string",
        description: "Default embedding model id (must exist in models with kind=embedding).",
      },
      proxy: { type: "string", description: "Optional proxy URL." },
      timeoutS: { type: "integer", minimum: 1, description: "Request timeout in seconds." },
      extraEnv: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Non-secret extra environment variables.",
      },
      options: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Template option values (e.g. authHeaderStyle).",
      },
      enabled: { type: "boolean", description: "Whether the provider is enabled." },
    },
    required: ["name", "templateId", "models"],
    additionalProperties: false,
  },
};

/** 权限信封的子 schema（dangerousOpsRequireApproval 恒为 true，模型给 false 也会被纠正）。 */
const PERMISSION_PRESET_SCHEMA = {
  type: "object",
  properties: {
    readPaths: { type: "array", items: { type: "string" } },
    writePaths: { type: "array", items: { type: "string" } },
    shell: { type: "string", enum: [...SHELL_POLICIES] },
    network: { type: "boolean" },
    dangerousOpsRequireApproval: {
      type: "boolean",
      const: true,
      description: "Always true; cannot be disabled.",
    },
  },
  required: ["readPaths", "writePaths", "shell", "network", "dangerousOpsRequireApproval"],
  additionalProperties: false,
} as const;

export const CONFIG_DRAFT_PROFILE_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_DRAFT_PROFILE,
  description:
    "Submit a draft to create or update an agent profile (runtime + provider + model + default " +
    "role + permission preset). The draft is validated and then shown to the user for " +
    "confirmation; NOTHING is saved until the user explicitly confirms. Pass `id` to update. " +
    "If permissionPreset is omitted the workbench default preset is used. " +
    `${KEY_REFUSAL_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Existing profile id to update; omit to create a new profile.",
      },
      name: { type: "string", description: "Display name." },
      runtime: {
        type: "string",
        description: 'Adapter runtime id (e.g. "codex", "claude-code").',
      },
      providerId: { type: "string", description: "Provider id (must exist)." },
      model: {
        type: "string",
        description: "Model id; omit to use the provider's default model.",
      },
      defaultRole: {
        type: "string",
        description: 'Built-in role ("planner" / "worker" / "reviewer") or a custom role id.',
      },
      permissionPreset: PERMISSION_PRESET_SCHEMA,
      outputLanguage: {
        type: "string",
        description: "AI output language override; omit to follow the global setting.",
      },
      genericExec: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          taskDelivery: { type: "string", enum: [...GENERIC_EXEC_DELIVERIES] },
        },
        required: ["command", "args", "taskDelivery"],
        additionalProperties: false,
        description: "Command config (generic-exec runtime only).",
      },
      reasoningEffort: {
        type: "string",
        description:
          "Canonical reasoning effort (none/minimal/low/medium/high/xhigh/max). " +
          "Omit to follow the CLI / local config. Only valid for codex, claude-code, grok-build, opencode.",
      },
    },
    required: ["name", "runtime", "providerId", "defaultRole"],
    additionalProperties: false,
  },
};

export const CONFIG_LIST_CONFIGS_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_LIST_CONFIGS,
  description:
    "List workbench configs (name, whether it is the default, optional project scope, optional default " +
    "permission, and the Claude / Codex / Grok route). A route is local login or a relay provider id, plus optional " +
    "model and reasoning effort. No secrets are included. " +
    `To create or update one, submit a draft via config_draft_config (the user must confirm). ${KEY_REFUSAL_NOTE}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const CONFIG_ROUTE_SCHEMA = {
  type: "object",
  properties: {
    connectionMode: {
      type: "string",
      enum: [...CONNECTION_MODES],
      description:
        "local_cli uses the machine login. relay uses an existing or newly drafted provider.",
    },
    providerId: {
      type: "string",
      description: "Required when connectionMode is relay. Ignored for local_cli.",
    },
    model: {
      type: "string",
      description: "Optional model id. Omit to use the CLI default.",
    },
    reasoningEffort: {
      type: "string",
      enum: [...REASONING_EFFORT_LEVELS],
      description: "Optional reasoning effort. Omit to use the CLI default.",
    },
  },
  required: ["connectionMode"],
  additionalProperties: false,
} as const;

/** 配置草案字段白名单。没有密钥字段。 */
export const CONFIG_CONFIG_DRAFT_FIELDS = [
  "id",
  "name",
  "isDefault",
  "projectIds",
  "defaultPermission",
  "claude",
  "codex",
  "grok",
] as const;

/** 自配置 sidecar 用来识别调用者角色的环境变量。只有 manager 能调用。 */
export const ENV_CONFIG_CALLER_ROLE = "FF_PANE_CONFIG_CALLER_ROLE";

export const CONFIG_TOOL_MANAGER_ONLY_MESSAGE = "只有管理者可以使用自配置工具。";

/** 非空且不是 manager（含未展开的占位符）一律拒绝。未设置则保持旧行为。 */
export function isConfigToolCallerDenied(role: string | undefined): boolean {
  if (role === undefined) {
    return false;
  }
  const trimmed = role.trim();
  return trimmed.length > 0 && trimmed !== "manager";
}

/** 一路的字段白名单。 */
export const CONFIG_ROUTE_DRAFT_FIELDS = [
  "connectionMode",
  "providerId",
  "model",
  "reasoningEffort",
] as const;

export const CONFIG_DRAFT_CONFIG_TOOL: McpToolDefinition = {
  name: CONFIG_TOOL_DRAFT_CONFIG,
  description:
    "Submit a draft to create or update a workbench config (name, Claude route, Codex route, Grok route, optional " +
    "default permission, optional project scope). The draft is shown to the user; NOTHING is saved until " +
    "the user confirms. Pass id to update. The default config is open to every project and cannot be narrowed. " +
    "A relay route needs a provider id; draft a provider first when none exists. " +
    `${KEY_REFUSAL_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Existing config id to update; omit to create." },
      name: { type: "string", description: "Display name." },
      isDefault: {
        type: "boolean",
        description: "Make this the default config. A default config cannot set projectIds.",
      },
      projectIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Projects allowed to use this config. Omit or empty = every project. Ignored when isDefault.",
      },
      defaultPermission: {
        type: "string",
        enum: [...WORKBENCH_PERMISSION_LEVELS],
        description:
          "Optional initial permission for new windows. Omit to use the global workbench default.",
      },
      claude: {
        ...CONFIG_ROUTE_SCHEMA,
        description: "Claude route. Omit to leave Claude unavailable.",
      },
      codex: {
        ...CONFIG_ROUTE_SCHEMA,
        description: "Codex route. Omit to leave Codex unavailable.",
      },
      grok: {
        ...CONFIG_ROUTE_SCHEMA,
        description:
          "Grok route. Omit to leave Grok unavailable. Relay uses a Grok-compatible provider.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/** 全部工具声明（tools/list 顺序）。档案工具不再注册。 */
export const CONFIG_TOOLS: readonly McpToolDefinition[] = [
  CONFIG_LIST_PROVIDERS_TOOL,
  CONFIG_LIST_CONFIGS_TOOL,
  CONFIG_DRAFT_PROVIDER_TOOL,
  CONFIG_DRAFT_CONFIG_TOOL,
];

// ── 入参解析（白名单严进：未知键拒绝，密钥字样的键给明确拒收话术） ─────────────────

/** 白名单核查：返回违规错误文本；无违规返回 undefined。 */
function rejectUnknownKeys(
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  for (const key of Object.keys(args)) {
    if (allowed.includes(key)) {
      continue;
    }
    if (SECRET_LIKE_KEY.test(key)) {
      return `Field "${key}" is not accepted. ${KEY_REFUSAL_NOTE}`;
    }
    return `Unknown field "${key}". Allowed fields: ${allowed.join(", ")}.`;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** models 数组解析：结构不符给出指向具体条目的错误。 */
function parseModels(
  value: unknown,
): { readonly ok: true; readonly models: readonly ProviderModel[] } | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: 'Field "models" must be an array of { id, label?, kind? }.' };
  }
  const models: ProviderModel[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `models[${index}] must be an object.` };
    }
    const record = item as Record<string, unknown>;
    const id = nonEmptyString(record["id"]);
    if (id === undefined) {
      return { error: `models[${index}] needs non-empty "id".` };
    }
    const idText = rejectMisleading(`models[${index}].id`, id);
    if (idText !== undefined) {
      return { error: idText };
    }
    const label = nonEmptyString(record["label"]) ?? nonEmptyString(record["displayName"]);
    if (label !== undefined) {
      const labelText = rejectMisleading(`models[${index}].label`, label);
      if (labelText !== undefined) {
        return { error: labelText };
      }
    }
    const kind = record["kind"];
    if (kind !== undefined && kind !== "chat" && kind !== "embedding") {
      return { error: `models[${index}].kind must be "chat" or "embedding".` };
    }
    const contextWindowTokens = record["contextWindowTokens"] ?? record["contextWindowSize"];
    if (
      contextWindowTokens !== undefined &&
      (typeof contextWindowTokens !== "number" ||
        !Number.isInteger(contextWindowTokens) ||
        contextWindowTokens <= 0)
    ) {
      return { error: `models[${index}].contextWindowTokens must be a positive integer.` };
    }
    models.push({
      id: id as ModelId,
      ...(label !== undefined ? { label } : {}),
      ...(kind === "chat" || kind === "embedding" ? { kind } : {}),
      ...(typeof contextWindowTokens === "number" ? { contextWindowTokens } : {}),
    });
  }
  return { ok: true, models };
}

/**
 * 解析 config_draft_provider 的入参。
 */
export function parseProviderDraftArgs(args: Readonly<Record<string, unknown>>): ParseDraftResult {
  const unknown = rejectUnknownKeys(args, CONFIG_PROVIDER_DRAFT_FIELDS);
  if (unknown !== undefined) {
    return { ok: false, error: unknown };
  }
  const name = nonEmptyString(args["name"]);
  if (name === undefined) {
    return { ok: false, error: 'Field "name" is required and must be a non-empty string.' };
  }
  const nameText = rejectMisleading("name", name);
  if (nameText !== undefined) {
    return { ok: false, error: nameText };
  }
  const templateId = args["templateId"];
  if (!isProviderTemplateId(templateId)) {
    return {
      ok: false,
      error: `Field "templateId" must be one of: ${PROVIDER_TEMPLATE_IDS.join(", ")}.`,
    };
  }
  const modelsResult = parseModels(args["models"]);
  if (!("ok" in modelsResult)) {
    return { ok: false, error: modelsResult.error };
  }
  const timeoutS = args["timeoutS"];
  if (timeoutS !== undefined && (typeof timeoutS !== "number" || !Number.isInteger(timeoutS))) {
    return { ok: false, error: 'Field "timeoutS" must be an integer (seconds).' };
  }
  const enabled = args["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { ok: false, error: 'Field "enabled" must be a boolean.' };
  }
  const baseUrl = nonEmptyString(args["baseUrl"]);
  const defaultModelId = nonEmptyString(args["defaultModelId"]);
  const embeddingModel = nonEmptyString(args["embeddingModel"]);
  const proxy = nonEmptyString(args["proxy"]);
  const id = nonEmptyString(args["id"]);
  for (const [field, value] of [
    ["baseUrl", baseUrl],
    ["defaultModelId", defaultModelId],
    ["embeddingModel", embeddingModel],
    ["proxy", proxy],
    ["id", id],
  ] as const) {
    if (value !== undefined) {
      const text = rejectMisleading(field, value);
      if (text !== undefined) {
        return { ok: false, error: text };
      }
    }
  }
  const now = Date.now();

  let extraEnv: Record<string, string> | undefined;
  if (args["extraEnv"] !== undefined) {
    if (
      typeof args["extraEnv"] !== "object" ||
      args["extraEnv"] === null ||
      Array.isArray(args["extraEnv"])
    ) {
      return { ok: false, error: 'Field "extraEnv" must be an object of string values.' };
    }
    extraEnv = {};
    for (const [k, v] of Object.entries(args["extraEnv"] as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { ok: false, error: `extraEnv.${k} must be a string.` };
      }
      const secret = rejectSecretBagEntry("extraEnv", k, v);
      if (secret !== undefined) {
        return { ok: false, error: secret };
      }
      extraEnv[k] = v;
    }
  }

  let options: Record<string, string> | undefined;
  if (args["options"] !== undefined) {
    if (
      typeof args["options"] !== "object" ||
      args["options"] === null ||
      Array.isArray(args["options"])
    ) {
      return { ok: false, error: 'Field "options" must be an object of string values.' };
    }
    options = {};
    for (const [k, v] of Object.entries(args["options"] as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { ok: false, error: `options.${k} must be a string.` };
      }
      const secret = rejectSecretBagEntry("options", k, v);
      if (secret !== undefined) {
        return { ok: false, error: secret };
      }
      options[k] = v;
    }
  }

  const draft: ConfigProviderDraft = {
    name,
    templateId: templateId as ProviderTemplateId,
    models: modelsResult.models,
    enabled: enabled ?? true,
    createdAt: now,
    updatedAt: now,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(defaultModelId !== undefined ? { defaultModelId: defaultModelId as ModelId } : {}),
    ...(embeddingModel !== undefined ? { embeddingModel: embeddingModel as ModelId } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(typeof timeoutS === "number" ? { timeoutS } : {}),
    ...(extraEnv !== undefined ? { extraEnv } : {}),
    ...(options !== undefined ? { options } : {}),
  };
  return { ok: true, parsed: { kind: "provider", ...(id !== undefined ? { id } : {}), draft } };
}

/** permissionPreset 子对象解析（dangerousOpsRequireApproval 无条件纠正为 true）。 */
function parsePermissionPreset(
  value: unknown,
): { readonly ok: true; readonly preset: PermissionEnvelope } | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'Field "permissionPreset" must be an object.' };
  }
  const record = value as Record<string, unknown>;
  const readPaths = record["readPaths"];
  const writePaths = record["writePaths"];
  if (
    !Array.isArray(readPaths) ||
    !readPaths.every((p): p is string => typeof p === "string") ||
    !Array.isArray(writePaths) ||
    !writePaths.every((p): p is string => typeof p === "string")
  ) {
    return { error: '"permissionPreset.readPaths" / "writePaths" must be string arrays.' };
  }
  const shell = record["shell"];
  if (!isShellPolicy(shell)) {
    return { error: `"permissionPreset.shell" must be one of: ${SHELL_POLICIES.join(", ")}.` };
  }
  const network = record["network"];
  if (typeof network !== "boolean") {
    return { error: '"permissionPreset.network" must be a boolean.' };
  }
  return {
    ok: true,
    preset: {
      readPaths,
      writePaths,
      shell,
      network,
      // §7 第 5 项恒真：模型给什么都不采信
      dangerousOpsRequireApproval: true,
    },
  };
}

/** genericExec 子对象解析。 */
function parseGenericExec(
  value: unknown,
): { readonly ok: true; readonly config: GenericExecProfileConfig } | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'Field "genericExec" must be an object.' };
  }
  const record = value as Record<string, unknown>;
  const command = nonEmptyString(record["command"]);
  const args = record["args"];
  const taskDelivery = record["taskDelivery"];
  if (command === undefined) {
    return { error: '"genericExec.command" is required.' };
  }
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) {
    return { error: '"genericExec.args" must be a string array.' };
  }
  if (!isGenericExecDelivery(taskDelivery)) {
    return {
      error: `"genericExec.taskDelivery" must be one of: ${GENERIC_EXEC_DELIVERIES.join(", ")}.`,
    };
  }
  return { ok: true, config: { command, args, taskDelivery } };
}

/**
 * 解析 config_draft_profile 的入参（严进规则同 provider）。
 * permissionPreset 缺省时不在此填默认——由主进程用全局 defaultPermissionPreset 补
 * （那是它的事实源）；outputLanguage / defaultRole 的合法性归 validateProfileDraft。
 */
export function parseProfileDraftArgs(
  args: Readonly<Record<string, unknown>>,
): ParseDraftResult | { readonly ok: false; readonly error: string } {
  const unknown = rejectUnknownKeys(args, CONFIG_PROFILE_DRAFT_FIELDS);
  if (unknown !== undefined) {
    return { ok: false, error: unknown };
  }
  const name = nonEmptyString(args["name"]);
  const runtime = nonEmptyString(args["runtime"]);
  const providerId = nonEmptyString(args["providerId"]);
  const defaultRole = nonEmptyString(args["defaultRole"]);
  if (name === undefined || runtime === undefined || providerId === undefined) {
    return {
      ok: false,
      error: 'Fields "name", "runtime" and "providerId" are required non-empty strings.',
    };
  }
  if (defaultRole === undefined) {
    return { ok: false, error: 'Field "defaultRole" is required (planner/worker/reviewer/…).' };
  }
  let preset: PermissionEnvelope | undefined;
  if (args["permissionPreset"] !== undefined) {
    const parsed = parsePermissionPreset(args["permissionPreset"]);
    if (!("ok" in parsed)) {
      return { ok: false, error: parsed.error };
    }
    preset = parsed.preset;
  }
  let genericExec: GenericExecProfileConfig | undefined;
  if (args["genericExec"] !== undefined) {
    const parsed = parseGenericExec(args["genericExec"]);
    if (!("ok" in parsed)) {
      return { ok: false, error: parsed.error };
    }
    genericExec = parsed.config;
  }
  const model = nonEmptyString(args["model"]);
  const outputLanguage = nonEmptyString(args["outputLanguage"]);
  const reasoningEffort = nonEmptyString(args["reasoningEffort"]);
  const connectionModeRaw = nonEmptyString(args["connectionMode"]);
  if (connectionModeRaw !== undefined && !isConnectionMode(connectionModeRaw)) {
    return { ok: false, error: '"connectionMode" must be local_cli or relay.' };
  }
  const id = nonEmptyString(args["id"]);

  // preset 缺省在此以占位表达：主进程收到后用全局 defaultPermissionPreset 补齐再校验。
  // 用哨兵而不是把类型放宽为 optional：ConfigProfileDraft 与 AgentProfile 除 id 外同构，
  // 放宽会让"必填缺失"在类型上不可见。
  const draft: ConfigProfileDraft = {
    name,
    runtime: runtime as ConfigProfileDraft["runtime"],
    providerId: providerId as ConfigProfileDraft["providerId"],
    defaultRole: defaultRole as ConfigProfileDraft["defaultRole"],
    permissionPreset: preset ?? PRESET_FROM_GLOBAL_DEFAULT,
    ...(model !== undefined ? { model: model as ModelId } : {}),
    ...(outputLanguage !== undefined ? { outputLanguage: outputLanguage as AiOutputLanguage } : {}),
    ...(genericExec !== undefined ? { genericExec } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(connectionModeRaw !== undefined && isConnectionMode(connectionModeRaw)
      ? { connectionMode: connectionModeRaw }
      : {}),
  };
  return { ok: true, parsed: { kind: "profile", ...(id !== undefined ? { id } : {}), draft } };
}

/**
 * permissionPreset 缺省的哨兵值：主进程识别到（引用相等）即替换为全局
 * defaultPermissionPreset。空写权限 + 禁 shell + 禁网络——即便主进程漏替换，
 * 兜底语义也是最保守的一侧。
 */
export const PRESET_FROM_GLOBAL_DEFAULT: PermissionEnvelope = {
  readPaths: [],
  writePaths: [],
  shell: "forbidden",
  network: false,
  dangerousOpsRequireApproval: true,
};

function parseConfigRoute(
  value: unknown,
  label: string,
): { readonly ok: true; readonly route: ProjectConfigRoute } | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `Field "${label}" must be an object.` };
  }
  const record = value as Record<string, unknown>;
  const unknown = rejectUnknownKeys(record, CONFIG_ROUTE_DRAFT_FIELDS);
  if (unknown !== undefined) {
    return { error: `${label}: ${unknown}` };
  }
  if (!isConnectionMode(record["connectionMode"])) {
    return {
      error: `Field "${label}.connectionMode" must be one of: ${CONNECTION_MODES.join(", ")}.`,
    };
  }
  const providerId = nonEmptyString(record["providerId"]);
  const model = nonEmptyString(record["model"]);
  const effort = nonEmptyString(record["reasoningEffort"]);
  for (const [field, value] of [
    [`${label}.providerId`, providerId],
    [`${label}.model`, model],
    [`${label}.reasoningEffort`, effort],
  ] as const) {
    if (value !== undefined) {
      const text = rejectMisleading(field, value);
      if (text !== undefined) {
        return { error: text };
      }
    }
  }
  const route: ProjectConfigRoute = {
    connectionMode: record["connectionMode"] as ConnectionMode,
    ...(providerId !== undefined ? { providerId: providerId as ProviderId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort as ReasoningEffortLevel } : {}),
  };
  return { ok: true, route };
}

/**
 * 解析 config_draft_config 的入参。形状检查在此；默认范围、来源是否存在等与设置页相同的规则在主进程。
 */
export function parseConfigDraftArgs(args: Readonly<Record<string, unknown>>): ParseDraftResult {
  const unknown = rejectUnknownKeys(args, CONFIG_CONFIG_DRAFT_FIELDS);
  if (unknown !== undefined) {
    return { ok: false, error: unknown };
  }
  const name = nonEmptyString(args["name"]);
  if (name === undefined) {
    return { ok: false, error: 'Field "name" is required and must be a non-empty string.' };
  }
  const nameText = rejectMisleading("name", name);
  if (nameText !== undefined) {
    return { ok: false, error: nameText };
  }
  if (args["isDefault"] !== undefined && typeof args["isDefault"] !== "boolean") {
    return { ok: false, error: 'Field "isDefault" must be a boolean.' };
  }
  let projectIds: string[] | undefined;
  if (args["projectIds"] !== undefined) {
    if (
      !Array.isArray(args["projectIds"]) ||
      !args["projectIds"].every((item): item is string => typeof item === "string")
    ) {
      return { ok: false, error: 'Field "projectIds" must be an array of strings.' };
    }
    projectIds = args["projectIds"];
    for (const [index, projectId] of projectIds.entries()) {
      const text = rejectMisleading(`projectIds[${index}]`, projectId);
      if (text !== undefined) {
        return { ok: false, error: text };
      }
    }
  }
  if (
    args["defaultPermission"] !== undefined &&
    !isWorkbenchPermissionLevel(args["defaultPermission"])
  ) {
    return {
      ok: false,
      error: `Field "defaultPermission" must be one of: ${WORKBENCH_PERMISSION_LEVELS.join(", ")}.`,
    };
  }
  let claude: ProjectConfigRoute | undefined;
  if (args["claude"] !== undefined) {
    const parsed = parseConfigRoute(args["claude"], "claude");
    if (!("ok" in parsed)) {
      return { ok: false, error: parsed.error };
    }
    claude = parsed.route;
  }
  let codex: ProjectConfigRoute | undefined;
  if (args["codex"] !== undefined) {
    const parsed = parseConfigRoute(args["codex"], "codex");
    if (!("ok" in parsed)) {
      return { ok: false, error: parsed.error };
    }
    codex = parsed.route;
  }
  let grok: ProjectConfigRoute | undefined;
  if (args["grok"] !== undefined) {
    const parsed = parseConfigRoute(args["grok"], "grok");
    if (!("ok" in parsed)) {
      return { ok: false, error: parsed.error };
    }
    grok = parsed.route;
  }
  const id = nonEmptyString(args["id"]);
  const draft: ProjectConfigDraft = {
    name,
    isDefault: args["isDefault"] === true,
    ...(projectIds !== undefined && projectIds.length > 0
      ? { projectIds: projectIds as unknown as ProjectId[] }
      : {}),
    ...(isWorkbenchPermissionLevel(args["defaultPermission"])
      ? { defaultPermission: args["defaultPermission"] as WorkbenchPermissionLevel }
      : {}),
    ...(claude !== undefined ? { claude } : {}),
    ...(codex !== undefined ? { codex } : {}),
    ...(grok !== undefined ? { grok } : {}),
  };
  return { ok: true, parsed: { kind: "config", ...(id !== undefined ? { id } : {}), draft } };
}

// ── 脱敏视图（list 工具的输出；铁律 1 的第二层证据） ─────────────────────────────

/** Provider 的脱敏视图：逐字段显式构造，**永不展开原对象**，key 折算为布尔。 */
export interface SanitizedProviderView {
  readonly id: string;
  readonly name: string;
  readonly templateId: ProviderTemplateId;
  readonly baseUrl?: string;
  readonly models: readonly ProviderModel[];
  readonly defaultModelId?: string;
  readonly embeddingModel?: string;
  readonly proxy?: string;
  readonly timeoutS?: number;
  readonly enabled: boolean;
  /** 是否已配置密钥（**只有这一位**；引用与本体都不出现）。 */
  readonly apiKeyConfigured: boolean;
}

/** 折算一条 Provider 的脱敏视图。 */
export function sanitizeProvider(provider: Provider): SanitizedProviderView {
  return {
    id: provider.id,
    name: provider.name,
    templateId: provider.templateId,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    models: provider.models,
    ...(provider.defaultModelId !== undefined ? { defaultModelId: provider.defaultModelId } : {}),
    ...(provider.embeddingModel !== undefined ? { embeddingModel: provider.embeddingModel } : {}),
    ...(provider.proxy !== undefined ? { proxy: provider.proxy } : {}),
    ...(provider.timeoutS !== undefined ? { timeoutS: provider.timeoutS } : {}),
    enabled: provider.enabled,
    apiKeyConfigured: provider.apiKeyRef !== undefined && provider.apiKeyRef.length > 0,
  };
}

/** 渲染 list 工具回给模型的文本（JSON + 使用指引）。 */
export function renderProviderList(providers: readonly Provider[]): string {
  const views = providers.map(sanitizeProvider);
  return [
    `${views.length} provider(s) configured. API keys are never included; "apiKeyConfigured" tells whether one is stored.`,
    "To create or update one, submit a draft via config_draft_provider (the user must confirm).",
    "",
    JSON.stringify(views, null, 2),
  ].join("\n");
}

function sanitizeRoute(route: ProjectConfigRoute): ProjectConfigRoute {
  return {
    connectionMode: route.connectionMode,
    ...(route.providerId !== undefined ? { providerId: route.providerId } : {}),
    ...(route.model !== undefined ? { model: route.model } : {}),
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
  };
}

/** 配置的只读视图：只抄已知字段，调用方多出来的密钥字段不会出现。 */
export function sanitizeProjectConfig(config: ProjectConfig): {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly projectIds?: readonly string[];
  readonly defaultPermission?: WorkbenchPermissionLevel;
  readonly claude?: ProjectConfigRoute;
  readonly codex?: ProjectConfigRoute;
  readonly grok?: ProjectConfigRoute;
} {
  return {
    id: config.id,
    name: config.name,
    isDefault: config.isDefault === true,
    ...(config.projectIds !== undefined && config.projectIds.length > 0
      ? { projectIds: [...config.projectIds] }
      : {}),
    ...(config.defaultPermission !== undefined
      ? { defaultPermission: config.defaultPermission }
      : {}),
    ...(config.claude !== undefined ? { claude: sanitizeRoute(config.claude) } : {}),
    ...(config.codex !== undefined ? { codex: sanitizeRoute(config.codex) } : {}),
    ...(config.grok !== undefined ? { grok: sanitizeRoute(config.grok) } : {}),
  };
}

/** 渲染配置列表。 */
export function renderConfigList(configs: readonly ProjectConfig[]): string {
  const views = configs.map((config) => sanitizeProjectConfig(config));
  return [
    `${views.length} config(s). Secrets are never included.`,
    "To create or update one, submit a draft via config_draft_config (the user must confirm).",
    "A relay route needs a provider. Draft one with config_draft_provider when it does not exist yet.",
    "",
    JSON.stringify(views, null, 2),
  ].join("\n");
}

/** 渲染 Profile 列表（Profile 无密钥字段，原样序列化即安全）。 */
export function renderProfileList(profiles: readonly AgentProfile[]): string {
  return [
    `${profiles.length} agent profile(s) configured.`,
    "To create or update one, submit a draft via config_draft_profile (the user must confirm).",
    "",
    JSON.stringify(profiles, null, 2),
  ].join("\n");
}

// ── 信箱线格式（sidecar ↔ 主进程；文件即通道，零端口零网络，理由见 config-server.ts） ──

/** 请求文件（`<mailbox>/requests/<id>.json`）。 */
export interface ConfigDraftRequestFile {
  /** 草案 ID（sidecar 生成的 UUID；响应文件同名关联）。 */
  readonly id: string;
  /** 工具名（CONFIG_TOOL_DRAFT_* 之一）。 */
  readonly tool: string;
  /** 工具原始入参（主进程做权威解析与校验；本文件不落任何解析结果）。 */
  readonly args: Readonly<Record<string, unknown>>;
  /** 提交时刻（epoch 毫秒）。 */
  readonly at: number;
}

/** 响应文件（`<mailbox>/responses/<id>.json`，主进程写、sidecar 轮询读）。 */
export interface ConfigDraftResponseFile {
  readonly id: string;
  /** 去向：invalid（校验失败）/ confirmed / rejected / timeout / error。 */
  readonly outcome: ConfigToolOutcome;
  /** 说明（校验失败原文 / 拒绝原因 / 错误原文；confirmed 时缺省）。 */
  readonly message?: string;
  /** confirmed 时落盘条目的 ID（新建为新 ID，更新为原 ID）。 */
  readonly resultId?: string;
}

/** 一条草案的调用摘要（进审计与确认对话框标题；永不含密钥——草案里物理没有）。 */
export function describeDraft(parsed: ParsedConfigDraft): string {
  const action = parsed.id !== undefined ? "update" : "create";
  return `${action} ${parsed.kind} "${parsed.draft.name}"`;
}

/** 渲染草案工具回给模型的结果文本（三态 + 校验失败）。 */
export function renderDraftOutcome(response: ConfigDraftResponseFile): string {
  switch (response.outcome) {
    case "confirmed":
      return `The user confirmed the draft. It has been saved${
        response.resultId !== undefined ? ` (id: ${response.resultId})` : ""
      }. If this configuration requires an API key, the workbench UI is now guiding the user to enter it securely; you do not need to (and must not) handle the key.`;
    case "rejected":
      return `The user rejected the draft${
        response.message !== undefined && response.message.length > 0
          ? `: ${response.message}`
          : "."
      } Do not resubmit the same draft unchanged; ask the user what to adjust.`;
    case "timeout":
      return "The confirmation request timed out (no user decision within the waiting window). Nothing was saved. You may ask the user to watch for the confirmation dialog and try again.";
    case "invalid":
      return `The draft failed validation and was NOT shown to the user: ${
        response.message ?? "unknown validation error"
      } Fix the draft and submit again.`;
    default:
      return `The draft could not be processed: ${response.message ?? "unknown error"}`;
  }
}
