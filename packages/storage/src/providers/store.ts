/**
 * providers.json 持久化与 CRUD（T10.3：version 2 + 读时迁移）。
 */

import { randomBytes } from "node:crypto";
import type { Provider, ProviderId } from "@ff-pane/shared";
import { writeJsonAtomic } from "../fs/index.js";
import { ProviderInUseError, ProviderNotFoundError } from "./errors.js";
import {
  loadAndMigrateProvidersFile,
  PROVIDERS_FILE_VERSION,
  type ProvidersFileV2,
} from "./migrate.js";
import { type ProviderDraft, validateProviderDraft } from "./validate.js";

export type { ProvidersFileV2 as ProvidersFile } from "./migrate.js";
export { PROVIDERS_FILE_VERSION, PROVIDERS_V1_BACKUP_SUFFIX } from "./migrate.js";

/** 删除保护钩子。 */
export type ProviderInUseCheck = (id: ProviderId) => boolean | Promise<boolean>;

/** Provider CRUD 存取接口。 */
export interface ProviderStore {
  listProviders(): Promise<readonly Provider[]>;
  getProvider(id: ProviderId): Promise<Provider | undefined>;
  createProvider(draft: ProviderDraft): Promise<Provider>;
  updateProvider(id: ProviderId, draft: ProviderDraft): Promise<Provider>;
  deleteProvider(id: ProviderId, isInUse?: ProviderInUseCheck): Promise<void>;
}

const PROVIDER_ID_PREFIX = "provider";
const PROVIDER_ID_RANDOM_BYTES = 6;

function generateProviderId(existingIds: ReadonlySet<string>): ProviderId {
  let id: string;
  do {
    id = `${PROVIDER_ID_PREFIX}-${randomBytes(PROVIDER_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as ProviderId;
}

async function loadProviders(providersFile: string): Promise<readonly Provider[]> {
  const { providers } = await loadAndMigrateProvidersFile(providersFile);
  return providers;
}

async function saveProviders(providersFile: string, providers: readonly Provider[]): Promise<void> {
  const file: ProvidersFileV2 = { version: PROVIDERS_FILE_VERSION, providers };
  await writeJsonAtomic(providersFile, file);
}

/** 创建绑定到指定 providers.json 路径的 ProviderStore。 */
export function createProviderStore(providersFile: string): ProviderStore {
  return {
    async listProviders(): Promise<readonly Provider[]> {
      return loadProviders(providersFile);
    },

    async getProvider(id: ProviderId): Promise<Provider | undefined> {
      const providers = await loadProviders(providersFile);
      return providers.find((provider) => provider.id === id);
    },

    async createProvider(draft: ProviderDraft): Promise<Provider> {
      const now = Date.now();
      const createdAt =
        draft.createdAt !== undefined && draft.createdAt > 0 ? draft.createdAt : now;
      const updatedAt =
        draft.updatedAt !== undefined && draft.updatedAt > 0 ? draft.updatedAt : now;
      const draftWithTimes: ProviderDraft = { ...draft, createdAt, updatedAt };
      validateProviderDraft(draftWithTimes);
      const providers = await loadProviders(providersFile);
      const id = generateProviderId(new Set(providers.map((provider) => provider.id)));
      const created = { ...draftWithTimes, id, createdAt, updatedAt } as Provider;
      await saveProviders(providersFile, [...providers, created]);
      return created;
    },

    async updateProvider(id: ProviderId, draft: ProviderDraft): Promise<Provider> {
      const providers = await loadProviders(providersFile);
      const index = providers.findIndex((provider) => provider.id === id);
      if (index === -1) {
        throw new ProviderNotFoundError(id);
      }
      const existing = providers[index];
      if (existing === undefined) {
        throw new ProviderNotFoundError(id);
      }
      const now = Date.now();
      const createdAt =
        draft.createdAt !== undefined && draft.createdAt > 0
          ? draft.createdAt
          : (existing.createdAt ?? now);
      const updatedAt = now;
      const draftWithTimes: ProviderDraft = { ...draft, createdAt, updatedAt };
      validateProviderDraft(draftWithTimes);
      const updated = { ...draftWithTimes, id, createdAt, updatedAt } as Provider;
      await saveProviders(providersFile, providers.with(index, updated));
      return updated;
    },

    async deleteProvider(id: ProviderId, isInUse?: ProviderInUseCheck): Promise<void> {
      const providers = await loadProviders(providersFile);
      if (!providers.some((provider) => provider.id === id)) {
        throw new ProviderNotFoundError(id);
      }
      if (isInUse !== undefined && (await isInUse(id))) {
        throw new ProviderInUseError(id);
      }
      await saveProviders(
        providersFile,
        providers.filter((provider) => provider.id !== id),
      );
    },
  };
}
