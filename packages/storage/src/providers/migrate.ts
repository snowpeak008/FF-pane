/**
 * providers.json v1 → v2 迁移（T10.3）。
 * - 迁移前写备份 providers.json.bak-v1
 * - 幂等：version===2 直接返回
 * - 损坏文件不丢数据：保留原文件并抛错
 */

import { copyFile, rename } from "node:fs/promises";
import type {
  EpochMillis,
  LegacyProviderType,
  ModelId,
  ModelKind,
  Provider,
  ProviderId,
  ProviderModel,
  ProviderTemplateId,
} from "@ff-pane/shared";
import {
  ANTHROPIC_OFFICIAL_BASE_URL,
  isLegacyProviderType,
  isModelKind,
  isProviderTemplateId,
  OPENAI_OFFICIAL_BASE_URL,
} from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { ProvidersFileInvalidError } from "./errors.js";

/** 当前 providers.json 格式版本。 */
export const PROVIDERS_FILE_VERSION = 2;

/** 备份后缀（相对原文件旁）。 */
export const PROVIDERS_V1_BACKUP_SUFFIX = ".bak-v1";

export interface ProvidersFileV2 {
  readonly version: 2;
  readonly providers: readonly Provider[];
}

/** v1 模型条目（displayName 必填）。 */
interface LegacyProviderModel {
  readonly id?: unknown;
  readonly displayName?: unknown;
  readonly label?: unknown;
  readonly kind?: unknown;
  readonly contextWindowTokens?: unknown;
}

/** v1 Provider 松散形状。 */
interface LegacyProviderRecord {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly templateId?: unknown;
  readonly baseUrl?: unknown;
  readonly apiKeyRef?: unknown;
  readonly models?: unknown;
  readonly defaultModel?: unknown;
  readonly defaultModelId?: unknown;
  readonly embeddingModel?: unknown;
  readonly proxy?: unknown;
  readonly timeoutS?: unknown;
  readonly requestTemplate?: unknown;
  readonly enabled?: unknown;
  readonly extraEnv?: unknown;
  readonly options?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

/** 旧 type → templateId。 */
export function mapLegacyTypeToTemplateId(
  type: LegacyProviderType,
  baseUrl: string | undefined,
): ProviderTemplateId {
  switch (type) {
    case "cli_login":
      return "local-login";
    case "openai_compatible":
      return baseUrl !== undefined && sameOrigin(baseUrl, OPENAI_OFFICIAL_BASE_URL)
        ? "openai-official"
        : "openai-compatible";
    case "anthropic":
      return baseUrl !== undefined && sameOrigin(baseUrl, ANTHROPIC_OFFICIAL_BASE_URL)
        ? "anthropic-official"
        : "anthropic-compatible";
    case "custom":
      // 尽力：有 anthropic 官方味 → anthropic-compatible；否则 openai-compatible
      if (baseUrl !== undefined && /anthropic/i.test(baseUrl)) {
        return "anthropic-compatible";
      }
      return "openai-compatible";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function migrateModel(raw: LegacyProviderModel, index: number): ProviderModel {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error(`models[${index}] 缺少非空 id`);
  }
  const labelFromNew = typeof raw.label === "string" ? raw.label.trim() : "";
  const labelFromOld = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  const label = labelFromNew.length > 0 ? labelFromNew : labelFromOld;
  const kind: ModelKind | undefined = isModelKind(raw.kind) ? raw.kind : undefined;
  const contextWindowTokens =
    typeof raw.contextWindowTokens === "number" &&
    Number.isInteger(raw.contextWindowTokens) &&
    raw.contextWindowTokens > 0
      ? raw.contextWindowTokens
      : undefined;
  return {
    id: raw.id as ModelId,
    ...(label.length > 0 ? { label } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 清洗 options：去掉已废弃的 wire_api（现行 Codex 不写 / 不认 chat）。
 * 返回新字典；若空则 undefined。
 */
function sanitizeMigratedOptions(
  options: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (options === undefined) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "wire_api") {
      continue;
    }
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 旧流程对 anthropic / custom→anthropic 中转恒注入 ANTHROPIC_API_KEY。
 * 新模板 anthropic-compatible 默认 AUTH_TOKEN；迁移时写入 api_key 保持等价。
 */
function legacyAuthOptionsForTemplate(
  legacyType: LegacyProviderType | undefined,
  templateId: ProviderTemplateId,
  options: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (
    legacyType !== undefined &&
    (legacyType === "anthropic" || legacyType === "custom") &&
    templateId === "anthropic-compatible"
  ) {
    return { ...(options ?? {}), authHeaderStyle: "api_key" };
  }
  return options;
}

/** 单条 v1（或半迁移）记录 → v2 Provider。 */
export function migrateLegacyProviderRecord(raw: LegacyProviderRecord, now: EpochMillis): Provider {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("Provider 缺少 id");
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error(`Provider ${raw.id} 缺少 name`);
  }

  let templateId: ProviderTemplateId;
  let legacyType: LegacyProviderType | undefined;
  if (isProviderTemplateId(raw.templateId)) {
    templateId = raw.templateId;
  } else if (isLegacyProviderType(raw.type)) {
    legacyType = raw.type;
    const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : undefined;
    templateId = mapLegacyTypeToTemplateId(raw.type, baseUrl);
  } else {
    throw new Error(`Provider ${raw.id} 无法识别 type/templateId`);
  }

  const modelsRaw = Array.isArray(raw.models) ? raw.models : [];
  const models = modelsRaw.map((entry, index) => migrateModel(entry as LegacyProviderModel, index));

  const baseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl.trim().length > 0
      ? raw.baseUrl.trim()
      : undefined;
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) {
    throw new Error(`Provider ${raw.id} 的 baseUrl 非法：${baseUrl}`);
  }

  const defaultModelIdRaw =
    (typeof raw.defaultModelId === "string" && raw.defaultModelId) ||
    (typeof raw.defaultModel === "string" && raw.defaultModel) ||
    undefined;
  const defaultModelId =
    defaultModelIdRaw !== undefined && defaultModelIdRaw.length > 0
      ? (defaultModelIdRaw as ModelId)
      : undefined;

  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;

  const options = asStringRecord(raw.options);
  const extraEnv = asStringRecord(raw.extraEnv);
  // custom 的 requestTemplate 保留进 options，避免丢字段
  let mergedOptions =
    typeof raw.requestTemplate === "string" && raw.requestTemplate.length > 0
      ? { ...(options ?? {}), requestTemplate: raw.requestTemplate }
      : options;
  mergedOptions = sanitizeMigratedOptions(mergedOptions);
  mergedOptions = legacyAuthOptionsForTemplate(legacyType, templateId, mergedOptions);

  return {
    id: raw.id as ProviderId,
    name: raw.name.trim(),
    templateId,
    models,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    createdAt,
    updatedAt,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(typeof raw.apiKeyRef === "string" && raw.apiKeyRef.length > 0
      ? { apiKeyRef: raw.apiKeyRef as Provider["apiKeyRef"] }
      : {}),
    ...(defaultModelId !== undefined ? { defaultModelId } : {}),
    ...(typeof raw.embeddingModel === "string" && raw.embeddingModel.length > 0
      ? { embeddingModel: raw.embeddingModel as ModelId }
      : {}),
    ...(typeof raw.proxy === "string" && raw.proxy.trim().length > 0
      ? { proxy: raw.proxy.trim() }
      : {}),
    ...(typeof raw.timeoutS === "number" && Number.isInteger(raw.timeoutS) && raw.timeoutS > 0
      ? { timeoutS: raw.timeoutS }
      : {}),
    ...(extraEnv !== undefined ? { extraEnv } : {}),
    ...(mergedOptions !== undefined ? { options: mergedOptions } : {}),
  } as Provider;
}

export interface MigrateProvidersResult {
  /** 是否执行了写入（已是 v2 则为 false）。 */
  readonly migrated: boolean;
  readonly providers: readonly Provider[];
  /** 若写了备份，为备份路径。 */
  readonly backupPath?: string;
}

/**
 * 读 providers.json：v1 则备份并升 v2；v2 原样；损坏则抛错且不改原文件。
 */
export async function loadAndMigrateProvidersFile(
  providersFile: string,
  now: EpochMillis = Date.now(),
): Promise<MigrateProvidersResult> {
  const result = await readJson<unknown>(providersFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return { migrated: false, providers: [] };
    }
    throw result.error;
  }

  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProvidersFileInvalidError(providersFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly providers?: unknown };
  if (!Array.isArray(file.providers)) {
    throw new ProvidersFileInvalidError(providersFile, "providers 必须是数组");
  }

  if (file.version === PROVIDERS_FILE_VERSION) {
    // 信任已校验写入的 v2；条目按松散再收一次（兼容半手工编辑）
    try {
      const providers = file.providers.map((entry) =>
        migrateLegacyProviderRecord(entry as LegacyProviderRecord, now),
      );
      return { migrated: false, providers };
    } catch (error) {
      throw new ProvidersFileInvalidError(
        providersFile,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (file.version !== 1) {
    throw new ProvidersFileInvalidError(
      providersFile,
      `不支持的 version：${String(file.version)}（当前支持 1→2 迁移或 2）`,
    );
  }

  let providers: Provider[];
  try {
    providers = file.providers.map((entry) =>
      migrateLegacyProviderRecord(entry as LegacyProviderRecord, now),
    );
  } catch (error) {
    // 损坏：不写备份、不改原文件
    throw new ProvidersFileInvalidError(
      providersFile,
      error instanceof Error ? error.message : String(error),
    );
  }

  const backupPath = `${providersFile}${PROVIDERS_V1_BACKUP_SUFFIX}`;
  await copyFile(providersFile, backupPath);

  const next: ProvidersFileV2 = { version: PROVIDERS_FILE_VERSION, providers };
  // 先写临时再替换，失败时原文件与备份仍在
  await writeJsonAtomic(providersFile, next);

  return { migrated: true, providers, backupPath };
}

/** 测试辅助：只做内存迁移，不碰文件系统。 */
export function migrateProvidersFileInMemory(
  raw: unknown,
  now: EpochMillis = Date.now(),
): ProvidersFileV2 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly providers?: unknown };
  if (!Array.isArray(file.providers)) {
    throw new Error("providers 必须是数组");
  }
  if (file.version === 2) {
    return {
      version: 2,
      providers: file.providers.map((entry) =>
        migrateLegacyProviderRecord(entry as LegacyProviderRecord, now),
      ),
    };
  }
  if (file.version !== 1) {
    throw new Error(`不支持的 version：${String(file.version)}`);
  }
  return {
    version: 2,
    providers: file.providers.map((entry) =>
      migrateLegacyProviderRecord(entry as LegacyProviderRecord, now),
    ),
  };
}

/** 仅供 store 在极端情况下重命名损坏迁移产物（当前未用，保留符号避免 tree-shake）。 */
export async function quarantineProvidersFile(
  providersFile: string,
  stamp: string,
): Promise<string> {
  const dest = `${providersFile}.corrupt-${stamp}`;
  await rename(providersFile, dest);
  return dest;
}
