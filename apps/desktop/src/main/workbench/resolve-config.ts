/**
 * 按「项目绑定的配置 → 默认配置」选出 Claude 或 Codex 这一路。
 * 本机登录不读取来源、不注入密钥。
 * Cursor 只有本机登录：配置里没有这一路也能开。没填模型时用设置里的 Cursor 默认模型（T11.18）。
 */

import {
  isModelAllowedBySource,
  type ModelKind,
  type ProjectConfigId,
  projectConfigRoute,
  providerChatModelIds,
  selectEffectiveProjectConfig,
  type WorkbenchAiKind,
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
  /**
   * 本机登录路线选了来源、且来源里有对话模型时：允许使用的模型 id。空或没有 = 不限制。
   * 只管 FF-pane 自己指定的模型；CLI 自己的默认模型不检查。
   */
  readonly allowedModels?: readonly string[];
}

/** 开窗取路线要用的来源信息。完整的 Provider 本身就满足它。 */
export interface RouteProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly templateId?: string;
  readonly enabled?: boolean;
  readonly models?: readonly { readonly id: string; readonly kind?: ModelKind }[];
  readonly defaultModelId?: string;
}

/**
 * 管理者开窗、给窗口换模型时用：指定的模型不在这一路的允许集合里，返回人话；允许或不限制返回 undefined。
 * 没指定模型（用 CLI 自己的默认）不检查。
 */
export function modelNotAllowedMessage(
  route: Pick<LaunchCliRoute, "allowedModels" | "providerName">,
  model: string | undefined,
): string | undefined {
  const allowed = route.allowedModels ?? [];
  if (isModelAllowedBySource(allowed, model)) {
    return undefined;
  }
  return `模型「${model?.trim() ?? ""}」不在来源「${route.providerName ?? "本机登录来源"}」允许的模型里。允许：${allowed.join("、")}。`;
}

/**
 * 重启、续接时窗口里存着的「模型覆盖」要再过一遍来源的允许集合：
 * 换模型之后用户可能把来源清单改窄了，旧覆盖不能绕过限制。
 * 不允许的覆盖直接丢掉（回到配置解析出的模型），窗口照常续接，不报错。
 */
export function dropDisallowedModelOverride<
  W extends { readonly modelOverride?: string } | undefined,
>(route: Pick<LaunchCliRoute, "allowedModels" | "providerName">, window: W): W {
  if (
    window === undefined ||
    window.modelOverride === undefined ||
    modelNotAllowedMessage(route, window.modelOverride) === undefined
  ) {
    return window;
  }
  const { modelOverride: _dropped, ...rest } = window;
  void _dropped;
  return rest as W;
}

export interface ResolveProjectLaunchRouteInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly kind: WorkbenchAiKind;
  readonly configs: ProjectConfigStore;
  readonly getProvider: (id: string) => Promise<RouteProviderInfo | undefined>;
  /** 设置里的 Cursor 默认模型（T11.18）：Cursor 这一路没填模型时用它。 */
  readonly cursorDefaultModel?: string;
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
  const spec =
    projectConfigRoute(effective, input.kind) ??
    (input.kind === "cursor" || input.kind === "gemini"
      ? { connectionMode: "local_cli" as const }
      : undefined);
  const cliName =
    input.kind === "claude"
      ? "Claude"
      : input.kind === "codex"
        ? "Codex"
        : input.kind === "grok"
          ? "Grok"
          : input.kind === "cursor"
            ? "Cursor"
            : input.kind === "gemini"
              ? "Gemini"
              : "DeepSeek";
  if (spec === undefined) {
    return {
      ok: false,
      error: `配置「${effective.name}」没有 ${cliName} 这一路，不能开这个窗口。`,
    };
  }
  if (input.kind === "deepseek" && spec.connectionMode !== "relay") {
    return {
      ok: false,
      error: `配置「${effective.name}」的 DeepSeek 必须选择来源并填写密钥。`,
    };
  }
  const explicitModel = spec.model?.trim() || undefined;
  const cursorModel =
    input.kind === "cursor" ? input.cursorDefaultModel?.trim() || undefined : undefined;
  const reasoningEffort = spec.reasoningEffort;
  const sharedBase = {
    configId: effective.id,
    configName: effective.name,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
  if (spec.connectionMode === "local_cli") {
    const sourceId = spec.providerId?.trim() ?? "";
    if (sourceId === "") {
      // 没选来源：和以前完全一样，不限制。
      const model = explicitModel ?? cursorModel;
      return {
        ok: true,
        route: {
          connectionMode: "local_cli",
          ...sharedBase,
          ...(model !== undefined ? { model } : {}),
        },
      };
    }
    // 选了本机登录来源：它里面留下的对话模型就是允许使用的模型（清单为空 = 不限制）。
    const source = await input.getProvider(sourceId);
    if (source === undefined) {
      return { ok: false, error: `配置「${effective.name}」的 ${cliName} 本机登录来源不存在。` };
    }
    if (source.templateId !== undefined && source.templateId !== "local-login") {
      return {
        ok: false,
        error: `配置「${effective.name}」的 ${cliName} 本机登录选的来源「${source.name}」不是「本机已登录」类型。`,
      };
    }
    if (source.enabled === false) {
      return {
        ok: false,
        error: `配置「${effective.name}」的 ${cliName} 本机登录来源「${source.name}」已停用。`,
      };
    }
    const allowed = providerChatModelIds({ models: source.models ?? [] });
    const denied = modelNotAllowedMessage(
      { allowedModels: allowed, providerName: source.name },
      explicitModel,
    );
    if (denied !== undefined) {
      return { ok: false, error: `配置「${effective.name}」的 ${cliName} 指定了${denied}` };
    }
    // 没指定模型：用来源的默认模型（要在清单里）；都没有就不传，让 CLI 用自己的默认。
    const sourceDefault = source.defaultModelId?.trim() || undefined;
    const model =
      explicitModel ??
      (sourceDefault !== undefined && isModelAllowedBySource(allowed, sourceDefault)
        ? sourceDefault
        : undefined) ??
      cursorModel;
    return {
      ok: true,
      route: {
        connectionMode: "local_cli",
        providerId: source.id,
        providerName: source.name,
        ...sharedBase,
        ...(model !== undefined ? { model } : {}),
        ...(allowed.length > 0 ? { allowedModels: allowed } : {}),
      },
    };
  }
  const model = explicitModel ?? cursorModel;
  const shared = { ...sharedBase, ...(model !== undefined ? { model } : {}) };
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
