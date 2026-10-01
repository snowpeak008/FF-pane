/**
 * 工作台自配置草案的校验与落盘。
 * apply 只应由确认回执调用；prepare 不写盘。
 */

import type { ApiKeyRef, ProjectConfig, ProjectConfigId, ProviderId } from "@ff-pane/shared";
import { getProviderTemplate } from "@ff-pane/shared";
import type { ProjectConfigStore, ProviderStore } from "@ff-pane/storage";
import {
  ProjectConfigScopeBlockedError,
  type ProviderDraft,
  validateProviderDraft,
} from "@ff-pane/storage";
import type { ParsedConfigDraft, SanitizedProviderView } from "../../mcp/config-tool";
import { sanitizeProvider } from "../../mcp/config-tool";
import type { PrepareDraftResult } from "../session/config-draft-hub";
import { validateWorkbenchConfigDraft } from "./config-draft-validate";

export interface WorkbenchConfigDraftStores {
  readonly providers: Pick<
    ProviderStore,
    "getProvider" | "listProviders" | "createProvider" | "updateProvider"
  >;
  readonly projectConfigs: Pick<
    ProjectConfigStore,
    "getConfig" | "listConfigs" | "createConfig" | "updateConfig"
  >;
  readonly storeSecret: (plaintext: string) => Promise<ApiKeyRef>;
  readonly listBoundProjects: (
    configId: string,
  ) => Promise<readonly { readonly id: string; readonly name: string }[]>;
}

function failure(error: unknown): PrepareDraftResult {
  if (error instanceof ProjectConfigScopeBlockedError) {
    return {
      ok: false,
      error: `这些项目仍绑着这张配置，不能收窄范围：${error.reason}`,
    };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function createWorkbenchConfigDraftActions(stores: WorkbenchConfigDraftStores): {
  readonly prepare: (parsed: ParsedConfigDraft) => Promise<PrepareDraftResult>;
  readonly apply: (parsed: ParsedConfigDraft, apiKey?: string) => Promise<string>;
} {
  const prepare = async (parsed: ParsedConfigDraft): Promise<PrepareDraftResult> => {
    try {
      if (parsed.kind === "config") {
        const current = parsed.id
          ? await stores.projectConfigs.getConfig(parsed.id as ProjectConfigId)
          : undefined;
        if (parsed.id !== undefined && current === undefined) {
          return { ok: false, error: "配置不存在" };
        }
        const configs = await stores.projectConfigs.listConfigs();
        const othersHaveDefault = configs.some((item) => item.id !== parsed.id && item.isDefault);
        const normalized = await validateWorkbenchConfigDraft({
          draft: parsed.draft,
          ...(parsed.id !== undefined ? { configId: parsed.id } : {}),
          currentIsOnlyDefault: current?.isDefault === true && !othersHaveDefault,
          getProvider: (id) => stores.providers.getProvider(id as ProviderId),
          boundProjects: parsed.id !== undefined ? await stores.listBoundProjects(parsed.id) : [],
        });
        return {
          ok: true,
          normalized: {
            kind: "config",
            ...(parsed.id !== undefined ? { id: parsed.id } : {}),
            draft: normalized,
          },
          needsApiKey: false,
          ...(current !== undefined ? { current } : {}),
        };
      }
      if (parsed.kind === "provider") {
        const template = getProviderTemplate(parsed.draft.templateId);
        if (template === undefined) {
          return { ok: false, error: `未知的来源模板：${parsed.draft.templateId}` };
        }
        const existing =
          parsed.id !== undefined
            ? await stores.providers.getProvider(parsed.id as ProviderId)
            : undefined;
        if (parsed.id !== undefined && existing === undefined) {
          return { ok: false, error: "来源不存在" };
        }
        const needsApiKey =
          template.fields.apiKey === "required" &&
          (existing?.apiKeyRef === undefined || existing.apiKeyRef.length === 0);
        const draftForCheck: ProviderDraft = {
          ...parsed.draft,
          ...(existing?.apiKeyRef !== undefined
            ? { apiKeyRef: existing.apiKeyRef }
            : needsApiKey
              ? { apiKeyRef: "pending-user-entry" as ApiKeyRef }
              : {}),
        };
        validateProviderDraft(draftForCheck);
        const current: SanitizedProviderView | undefined =
          existing !== undefined ? sanitizeProvider(existing) : undefined;
        return {
          ok: true,
          normalized: parsed,
          needsApiKey,
          ...(current !== undefined ? { current } : {}),
        };
      }
      return { ok: false, error: "不再接受档案草案" };
    } catch (error) {
      return failure(error);
    }
  };

  const apply = async (parsed: ParsedConfigDraft, apiKey?: string): Promise<string> => {
    if (parsed.kind === "config") {
      const current = parsed.id
        ? await stores.projectConfigs.getConfig(parsed.id as ProjectConfigId)
        : undefined;
      const configs = await stores.projectConfigs.listConfigs();
      const othersHaveDefault = configs.some((item) => item.id !== parsed.id && item.isDefault);
      const normalized = await validateWorkbenchConfigDraft({
        draft: parsed.draft,
        ...(parsed.id !== undefined ? { configId: parsed.id } : {}),
        currentIsOnlyDefault: current?.isDefault === true && !othersHaveDefault,
        getProvider: (id) => stores.providers.getProvider(id as ProviderId),
        boundProjects: parsed.id !== undefined ? await stores.listBoundProjects(parsed.id) : [],
      });
      if (parsed.id !== undefined) {
        const updated = await stores.projectConfigs.updateConfig(
          parsed.id as ProjectConfigId,
          normalized,
        );
        return updated.id;
      }
      const created = await stores.projectConfigs.createConfig(normalized);
      return created.id;
    }
    if (parsed.kind === "provider") {
      const existing =
        parsed.id !== undefined
          ? await stores.providers.getProvider(parsed.id as ProviderId)
          : undefined;
      let apiKeyRef = existing?.apiKeyRef;
      if (apiKey !== undefined && apiKey.length > 0) {
        apiKeyRef = await stores.storeSecret(apiKey);
      }
      const draft: ProviderDraft = {
        ...parsed.draft,
        ...(apiKeyRef !== undefined && apiKeyRef.length > 0 ? { apiKeyRef } : {}),
      };
      validateProviderDraft(draft);
      if (parsed.id !== undefined) {
        const updated = await stores.providers.updateProvider(parsed.id as ProviderId, draft);
        return updated.id;
      }
      const created = await stores.providers.createProvider(draft);
      return created.id;
    }
    throw new Error("不再接受档案草案");
  };

  return { prepare, apply };
}

export type { ProjectConfig };
