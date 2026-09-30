/**
 * T9.11 —— 档案连法（本地 CLI / 中转）的主进程装配。
 *
 * - 旧配置一次性清掉（用户裁定全部抛弃，按新连法重配）。
 * - 选「本地 CLI」时自动绑 / 建一条 local-login 来源，档案里不再填网址。
 */

import { access, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile, Provider } from "@ff-pane/shared";
import { isLocalLoginProvider } from "@ff-pane/shared";

/** 自动创建的本机登录来源显示名。 */
export const LOCAL_CLI_PROVIDER_NAME = "本地 CLI";

/** 一次性重置标记（写在数据根，有则不再清）。 */
export const CONNECTION_MODE_RESET_ID = "connection-mode-v1";

export type ProfileDraft = Omit<AgentProfile, "id">;

export type LocalCliProviderDraft = Omit<Provider, "id">;

export interface LocalCliProviderStore {
  readonly listProviders: () => Promise<readonly Provider[]>;
  readonly createProvider: (draft: LocalCliProviderDraft) => Promise<Provider>;
}

/**
 * 本机旧来源 / 档案 / 角色 / 密钥一次性丢掉。
 * 项目注册表与项目目录不动。已重置过则跳过。
 * 返回是否刚执行了清场。
 */
export async function resetLegacyAgentConfigIfNeeded(input: {
  readonly rootDir: string;
  readonly providersFile: string;
  readonly profilesFile: string;
  readonly rolesFile: string;
  readonly secretsFile: string;
}): Promise<boolean> {
  const markerPath = join(input.rootDir, `.reset-${CONNECTION_MODE_RESET_ID}`);
  try {
    await access(markerPath);
    return false;
  } catch {
    // 尚无标记：清旧档
  }
  await Promise.all([
    unlink(input.providersFile).catch(() => undefined),
    unlink(input.profilesFile).catch(() => undefined),
    unlink(input.rolesFile).catch(() => undefined),
    unlink(input.secretsFile).catch(() => undefined),
  ]);
  await writeFile(markerPath, `${CONNECTION_MODE_RESET_ID}\n`, "utf8");
  return true;
}

/** 找到已有 local-login 来源，没有就建一条「本地 CLI」。 */
export async function ensureLocalCliProvider(store: LocalCliProviderStore): Promise<Provider> {
  const existing = (await store.listProviders()).find((provider) => isLocalLoginProvider(provider));
  if (existing !== undefined) {
    return existing;
  }
  const now = Date.now();
  return store.createProvider({
    name: LOCAL_CLI_PROVIDER_NAME,
    templateId: "local-login",
    models: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** 本地 CLI 档案在落盘前绑上本机登录来源（覆盖误选的中转）。 */
export async function materializeProfileDraft(
  draft: ProfileDraft,
  store: LocalCliProviderStore,
): Promise<ProfileDraft> {
  if (draft.connectionMode !== "local_cli") {
    return draft;
  }
  const local = await ensureLocalCliProvider(store);
  return { ...draft, providerId: local.id };
}
