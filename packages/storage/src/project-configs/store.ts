/**
 * configs.json：项目配置列表。整文件原子读写。
 * 文件不存在视为空集；首次 ensureDefaultConfig 写入一张两边本机登录的默认配置。
 * 不读取、不合并 profiles.json。
 */

import { randomBytes } from "node:crypto";
import type {
  ConnectionMode,
  ProjectConfig,
  ProjectConfigDraft,
  ProjectConfigId,
  ProjectId,
  ProviderId,
  ReasoningEffortLevel,
} from "@ff-pane/shared";
import {
  isConnectionMode,
  isProjectConfigScopeOpen,
  isWorkbenchPermissionLevel,
  normalizeReasoningEffort,
} from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import {
  ProjectConfigDefaultRequiredError,
  ProjectConfigDraftInvalidError,
  ProjectConfigLastError,
  ProjectConfigNotFoundError,
  ProjectConfigsFileInvalidError,
} from "./errors.js";

export const PROJECT_CONFIGS_FILE_VERSION = 1;

export const DEFAULT_PROJECT_CONFIG_NAME = "默认配置";

const CONFIG_ID_PREFIX = "config";
const CONFIG_ID_RANDOM_BYTES = 6;

export interface ProjectConfigsFile {
  readonly version: typeof PROJECT_CONFIGS_FILE_VERSION;
  readonly configs: readonly ProjectConfig[];
}

export type ProjectConfigDraftValidator = (draft: ProjectConfigDraft) => void | Promise<void>;

export interface ProjectConfigStore {
  listConfigs(): Promise<readonly ProjectConfig[]>;
  getConfig(id: ProjectConfigId): Promise<ProjectConfig | undefined>;
  /** 没有任何配置时写入默认配置；已有则保证恰好一张 isDefault。 */
  ensureDefaultConfig(): Promise<ProjectConfig>;
  createConfig(
    draft: ProjectConfigDraft,
    validateDraft?: ProjectConfigDraftValidator,
  ): Promise<ProjectConfig>;
  updateConfig(
    id: ProjectConfigId,
    draft: ProjectConfigDraft,
    validateDraft?: ProjectConfigDraftValidator,
  ): Promise<ProjectConfig>;
  setDefaultConfig(id: ProjectConfigId): Promise<ProjectConfig>;
  /**
   * 删除。只剩一张时拒绝。删的是默认配置时必须给出另一张的 id，并把它标成默认。
   */
  deleteConfig(id: ProjectConfigId, newDefaultId?: ProjectConfigId): Promise<void>;
}

/** 中转路是否引用了这个来源。 */
export function configReferencesProvider(
  configs: readonly ProjectConfig[],
  providerId: ProviderId,
): boolean {
  return configs.some(
    (config) => config.claude?.providerId === providerId || config.codex?.providerId === providerId,
  );
}

export function buildDefaultProjectConfigDraft(): ProjectConfigDraft {
  return {
    name: DEFAULT_PROJECT_CONFIG_NAME,
    isDefault: true,
    claude: { connectionMode: "local_cli" },
    codex: { connectionMode: "local_cli" },
  };
}

function generateConfigId(existingIds: ReadonlySet<string>): ProjectConfigId {
  let id: string;
  do {
    id = `${CONFIG_ID_PREFIX}-${randomBytes(CONFIG_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as ProjectConfigId;
}

function pickRoute(value: unknown): ProjectConfig["claude"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (!isConnectionMode(raw["connectionMode"])) {
    return undefined;
  }
  const model =
    typeof raw["model"] === "string" && raw["model"].trim() !== ""
      ? raw["model"].trim()
      : undefined;
  const effort =
    typeof raw["reasoningEffort"] === "string"
      ? normalizeReasoningEffort(raw["reasoningEffort"])
      : undefined;
  const extras = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  };
  if (raw["connectionMode"] === "relay") {
    if (typeof raw["providerId"] !== "string" || raw["providerId"].trim() === "") {
      return undefined;
    }
    return {
      connectionMode: "relay",
      providerId: raw["providerId"] as ProviderId,
      ...extras,
    };
  }
  return { connectionMode: "local_cli", ...extras };
}

function pickConfig(value: unknown): ProjectConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
    return undefined;
  }
  if (typeof raw["name"] !== "string" || raw["name"].trim() === "") {
    return undefined;
  }
  const projectIds = Array.isArray(raw["projectIds"])
    ? raw["projectIds"].filter(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      )
    : [];
  const permission = raw["defaultPermission"];
  const claude = pickRoute(raw["claude"]);
  const codex = pickRoute(raw["codex"]);
  const isDefault = raw["isDefault"] === true;
  return {
    id: raw["id"] as ProjectConfigId,
    name: raw["name"].trim(),
    isDefault,
    ...(!isDefault && projectIds.length > 0 ? { projectIds: projectIds as ProjectId[] } : {}),
    ...(isWorkbenchPermissionLevel(permission) ? { defaultPermission: permission } : {}),
    ...(claude !== undefined ? { claude } : {}),
    ...(codex !== undefined ? { codex } : {}),
  };
}

function normalizeRoute(
  route: ProjectConfigDraft["claude"],
  label: string,
): ProjectConfig["claude"] {
  if (route === undefined) {
    return undefined;
  }
  if (!isConnectionMode(route.connectionMode)) {
    throw new ProjectConfigDraftInvalidError(`${label} 的连法无效`);
  }
  const model = route.model?.trim() ?? "";
  let effort: ReasoningEffortLevel | undefined;
  if (route.reasoningEffort !== undefined && route.reasoningEffort.trim() !== "") {
    effort = normalizeReasoningEffort(route.reasoningEffort);
    if (effort === undefined) {
      throw new ProjectConfigDraftInvalidError(`${label} 的思考强度无效`);
    }
  }
  const extras = {
    ...(model !== "" ? { model } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  };
  if (route.connectionMode === "local_cli") {
    return { connectionMode: "local_cli" as ConnectionMode, ...extras };
  }
  const providerId = route.providerId?.trim() ?? "";
  if (providerId === "") {
    throw new ProjectConfigDraftInvalidError(`${label} 走中转时必须选择来源`);
  }
  return {
    connectionMode: "relay",
    providerId: providerId as ProviderId,
    ...extras,
  };
}

export function normalizeProjectConfigDraft(draft: ProjectConfigDraft): ProjectConfigDraft {
  const name = draft.name.trim();
  if (name === "") {
    throw new ProjectConfigDraftInvalidError("配置名称不能为空");
  }
  const claude = normalizeRoute(draft.claude, "Claude");
  const codex = normalizeRoute(draft.codex, "Codex");
  if (claude === undefined && codex === undefined) {
    throw new ProjectConfigDraftInvalidError("至少配置 Claude 或 Codex 一路");
  }
  if (
    draft.defaultPermission !== undefined &&
    !isWorkbenchPermissionLevel(draft.defaultPermission)
  ) {
    throw new ProjectConfigDraftInvalidError("默认权限无效");
  }
  const projectIds = (draft.projectIds ?? []).map((id) => id.trim()).filter((id) => id !== "");
  const unique = [...new Set(projectIds)] as ProjectId[];
  return {
    name,
    isDefault: draft.isDefault === true,
    ...(isProjectConfigScopeOpen(unique) ? {} : { projectIds: unique }),
    ...(draft.defaultPermission !== undefined
      ? { defaultPermission: draft.defaultPermission }
      : {}),
    ...(claude !== undefined ? { claude } : {}),
    ...(codex !== undefined ? { codex } : {}),
  };
}

async function loadConfigs(configsFile: string): Promise<readonly ProjectConfig[]> {
  const result = await readJson<unknown>(configsFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectConfigsFileInvalidError(configsFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly configs?: unknown };
  if (file.version !== PROJECT_CONFIGS_FILE_VERSION) {
    throw new ProjectConfigsFileInvalidError(
      configsFile,
      `不支持的 version：${String(file.version)}（当前支持 ${PROJECT_CONFIGS_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.configs)) {
    throw new ProjectConfigsFileInvalidError(configsFile, "configs 必须是数组");
  }
  const configs: ProjectConfig[] = [];
  for (const item of file.configs) {
    const picked = pickConfig(item);
    if (picked === undefined) {
      throw new ProjectConfigsFileInvalidError(configsFile, "存在无法识别的配置条目");
    }
    configs.push(picked);
  }
  return configs;
}

async function saveConfigs(configsFile: string, configs: readonly ProjectConfig[]): Promise<void> {
  const file: ProjectConfigsFile = { version: PROJECT_CONFIGS_FILE_VERSION, configs };
  await writeJsonAtomic(configsFile, file);
}

function withoutProjectScope(config: ProjectConfig): ProjectConfig {
  const { projectIds: _dropped, ...rest } = config;
  return rest;
}

/** 恰好一张默认，且这张不带可用项目范围。 */
function withSingleDefault(
  configs: readonly ProjectConfig[],
  defaultId: ProjectConfigId,
): ProjectConfig[] {
  return configs.map((config) => {
    if (config.id !== defaultId) {
      return { ...config, isDefault: false };
    }
    return { ...withoutProjectScope(config), isDefault: true };
  });
}

function assertDefaultHasOpenScope(
  isDefault: boolean,
  projectIds: readonly string[] | undefined,
): void {
  if (isDefault && !isProjectConfigScopeOpen(projectIds)) {
    throw new ProjectConfigDraftInvalidError("默认配置对所有项目开放，不能限制范围");
  }
}

export function createProjectConfigStore(configsFile: string): ProjectConfigStore {
  return {
    async listConfigs(): Promise<readonly ProjectConfig[]> {
      return loadConfigs(configsFile);
    },

    async getConfig(id: ProjectConfigId): Promise<ProjectConfig | undefined> {
      const configs = await loadConfigs(configsFile);
      return configs.find((config) => config.id === id);
    },

    async ensureDefaultConfig(): Promise<ProjectConfig> {
      const configs = await loadConfigs(configsFile);
      if (configs.length === 0) {
        const id = generateConfigId(new Set());
        const created: ProjectConfig = { ...buildDefaultProjectConfigDraft(), id, isDefault: true };
        await saveConfigs(configsFile, [created]);
        return created;
      }
      const defaults = configs.filter((config) => config.isDefault);
      if (defaults.length === 1) {
        const only = defaults[0];
        if (only === undefined) {
          throw new ProjectConfigDraftInvalidError("默认配置缺失");
        }
        return only;
      }
      const keep = defaults[0] ?? configs[0];
      if (keep === undefined) {
        throw new ProjectConfigDraftInvalidError("默认配置缺失");
      }
      const next = withSingleDefault(configs, keep.id);
      await saveConfigs(configsFile, next);
      const repaired = next.find((config) => config.id === keep.id);
      if (repaired === undefined) {
        throw new ProjectConfigDraftInvalidError("默认配置缺失");
      }
      return repaired;
    },

    async createConfig(
      draft: ProjectConfigDraft,
      validateDraft?: ProjectConfigDraftValidator,
    ): Promise<ProjectConfig> {
      const normalized = normalizeProjectConfigDraft(draft);
      if (validateDraft !== undefined) {
        await validateDraft(normalized);
      }
      const configs = await loadConfigs(configsFile);
      const id = generateConfigId(new Set(configs.map((config) => config.id)));
      const isDefault = configs.length === 0 || normalized.isDefault;
      assertDefaultHasOpenScope(isDefault, normalized.projectIds);
      const created: ProjectConfig = { ...normalized, id, isDefault };
      const next = isDefault
        ? [...configs.map((config) => ({ ...config, isDefault: false })), created]
        : [...configs, created];
      await saveConfigs(configsFile, next);
      return created;
    },

    async updateConfig(
      id: ProjectConfigId,
      draft: ProjectConfigDraft,
      validateDraft?: ProjectConfigDraftValidator,
    ): Promise<ProjectConfig> {
      const normalized = normalizeProjectConfigDraft(draft);
      if (validateDraft !== undefined) {
        await validateDraft(normalized);
      }
      const configs = await loadConfigs(configsFile);
      const current = configs.find((config) => config.id === id);
      if (current === undefined) {
        throw new ProjectConfigNotFoundError(id);
      }
      const othersHaveDefault = configs.some((config) => config.id !== id && config.isDefault);
      if (current.isDefault && !normalized.isDefault && !othersHaveDefault) {
        throw new ProjectConfigDefaultRequiredError();
      }
      const isDefault = normalized.isDefault || (current.isDefault && !othersHaveDefault);
      assertDefaultHasOpenScope(isDefault, normalized.projectIds);
      const updated: ProjectConfig = { ...normalized, id, isDefault };
      const next = configs.map((config) => {
        if (config.id === id) {
          return updated;
        }
        return isDefault ? { ...config, isDefault: false } : config;
      });
      await saveConfigs(configsFile, next);
      return updated;
    },

    async setDefaultConfig(id: ProjectConfigId): Promise<ProjectConfig> {
      const configs = await loadConfigs(configsFile);
      if (!configs.some((config) => config.id === id)) {
        throw new ProjectConfigNotFoundError(id);
      }
      const next = withSingleDefault(configs, id);
      await saveConfigs(configsFile, next);
      const updated = next.find((config) => config.id === id);
      if (updated === undefined) {
        throw new ProjectConfigNotFoundError(id);
      }
      return updated;
    },

    async deleteConfig(id: ProjectConfigId, newDefaultId?: ProjectConfigId): Promise<void> {
      const configs = await loadConfigs(configsFile);
      const current = configs.find((config) => config.id === id);
      if (current === undefined) {
        throw new ProjectConfigNotFoundError(id);
      }
      if (configs.length <= 1) {
        throw new ProjectConfigLastError();
      }
      if (current.isDefault) {
        if (newDefaultId === undefined || newDefaultId === id) {
          throw new ProjectConfigDefaultRequiredError();
        }
        if (!configs.some((config) => config.id === newDefaultId)) {
          throw new ProjectConfigNotFoundError(newDefaultId);
        }
        const remaining = withSingleDefault(
          configs.filter((config) => config.id !== id),
          newDefaultId,
        );
        await saveConfigs(configsFile, remaining);
        return;
      }
      await saveConfigs(
        configsFile,
        configs.filter((config) => config.id !== id),
      );
    },
  };
}
