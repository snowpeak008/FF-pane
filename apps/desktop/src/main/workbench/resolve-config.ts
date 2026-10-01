/**
 * 按「项目绑定的配置 → 默认配置」选出 Claude 或 Codex 这一路。
 * 本机登录不读取来源、不注入密钥。
 */

import {
  type ProjectConfigId,
  projectConfigRoute,
  selectEffectiveProjectConfig,
} from "@ff-pane/shared";
import {
  createProjectSettingsStore,
  type ProjectConfigStore,
  resolveProjectLayout,
} from "@ff-pane/storage";

/** 启动器消费的一路。密钥仍由启动器按 providerId 现取。 */
export interface LaunchCliRoute {
  readonly connectionMode: "local_cli" | "relay";
  readonly providerId?: string;
  readonly providerName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly configId: ProjectConfigId;
  readonly configName: string;
}

export interface ResolveProjectLaunchRouteInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly kind: "claude" | "codex";
  readonly configs: ProjectConfigStore;
  readonly getProvider: (
    id: string,
  ) => Promise<{ readonly id: string; readonly name: string } | undefined>;
}

export async function resolveProjectLaunchRoute(
  input: ResolveProjectLaunchRouteInput,
): Promise<
  | { readonly ok: true; readonly route: LaunchCliRoute }
  | { readonly ok: false; readonly error: string }
> {
  const settings = await createProjectSettingsStore(
    resolveProjectLayout(input.projectRoot).projectFile,
  ).readSettings();
  await input.configs.ensureDefaultConfig();
  const all = await input.configs.listConfigs();
  const effective = selectEffectiveProjectConfig(all, settings.configId, input.projectId);
  if (effective === undefined) {
    return { ok: false, error: "没有可用的项目配置。" };
  }
  const spec = projectConfigRoute(effective, input.kind);
  const cliName = input.kind === "claude" ? "Claude" : "Codex";
  if (spec === undefined) {
    return {
      ok: false,
      error: `配置「${effective.name}」没有 ${cliName} 这一路，不能开这个窗口。`,
    };
  }
  const model = spec.model?.trim() || undefined;
  const reasoningEffort = spec.reasoningEffort;
  const shared = {
    configId: effective.id,
    configName: effective.name,
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
  if (spec.connectionMode === "local_cli") {
    return { ok: true, route: { connectionMode: "local_cli", ...shared } };
  }
  const providerId = spec.providerId?.trim() ?? "";
  if (providerId === "") {
    return { ok: false, error: `配置「${effective.name}」的 ${cliName} 中转来源没有选。` };
  }
  const provider = await input.getProvider(providerId);
  if (provider === undefined) {
    return { ok: false, error: `配置「${effective.name}」的 ${cliName} 中转来源不存在。` };
  }
  return {
    ok: true,
    route: {
      connectionMode: "relay",
      providerId,
      providerName: provider.name,
      ...shared,
    },
  };
}
