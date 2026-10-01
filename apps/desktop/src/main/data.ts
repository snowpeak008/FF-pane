/**
 * 主进程数据层接线（W3.3）：把 @ff-pane/storage 的存取能力绑定到全局数据根，
 * 并装配成契约化的 invoke handlers。
 *
 * 布局层「根目录一律参数注入」（W1.2a）：全局根在此解析为 <homedir>/.aiworkbench，
 * 首次启动时幂等补建目录（initGlobalLayout，只建目录不建文件）。
 *
 * 目录生成语义（设计系统 §5.5 / §6.3）：
 * - 新建项目 = initProjectLayout 生成 <项目根>/.workbench/ 全套目录 + 写入注册表；
 * - 移除项目 = 仅出注册表，不删磁盘（故 remove 返回被移条目、支持 restore 撤销）。
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isCliLoginRuntime,
  listLocalModels,
  probeCliLogin,
  readOpenCodeEffortValues,
} from "@ff-pane/adapters";
import {
  CustomRoleValidationError,
  detectHabitConflicts,
  fetchModels,
  ProfileValidationError,
  testConnection,
  validateCustomRoleDraft,
  validateProfileDraft,
} from "@ff-pane/core";
import {
  type ApiKeyRef,
  type HabitEntry,
  type HabitEntryId,
  isProjectConfigScopeOpen,
  isProjectConfigVisibleTo,
  projectNamesOutsideScope,
  resolveReasoningEffortOptions,
} from "@ff-pane/shared";
import {
  configReferencesProvider,
  createConfigStore,
  createProfileStore,
  createProjectConfigStore,
  createProjectRegistry,
  createProjectSettingsStore,
  createProviderStore,
  createRoleStore,
  createWorkbenchLayoutStore,
  deleteEntry,
  deleteHabit,
  initGlobalLayout,
  initProjectLayout,
  listEntries,
  listHabits,
  type ProfileDraftValidator,
  ProjectConfigDraftInvalidError,
  ProjectConfigScopeBlockedError,
  type ProviderDraft,
  profileReferencesProvider,
  profileReferencesRole,
  type RoleDraftValidator,
  resolveProjectLayout,
  saveEntry,
  saveHabit,
  setHabitEnabled,
  updateEntryStatus,
  updateHabitStatus,
  validateHabitDraft,
} from "@ff-pane/storage";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { InvokeHandlers } from "../shared-ipc/server";
import { materializeProfileDraft, resetLegacyAgentConfigIfNeeded } from "./connection-mode";
import { resolveGlobalRoot } from "./data-root";
import { createMemoryIndexService, type MemoryIndexService } from "./memory-index";
import { type ProjectSummarySources, summarizeProjects } from "./project-summary";
import { resolveProbeOutlet } from "./provider-proxy";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "./secrets";
import { keepModelEffortOverrides } from "./workbench/model-effort";

/** 本数据层负责的 invoke 通道集合。 */
type DataChannel =
  | "dialog:pick-directory"
  | "projects:list"
  | "projects:summary"
  | "projects:create"
  | "projects:remove"
  | "projects:restore"
  | "projects:get-settings"
  | "projects:update-settings"
  | "providers:list"
  | "providers:create"
  | "providers:update"
  | "providers:remove"
  | "providers:test-connection"
  | "providers:fetch-models"
  | "providers:probe-cli-login"
  | "providers:list-local-models"
  | "runtimes:reasoning-effort-levels"
  | "secrets:masked-tail"
  | "config:get"
  | "config:update"
  | "workbench:get-layouts"
  | "workbench:save-layout"
  | "profiles:list"
  | "configs:list"
  | "configs:create"
  | "configs:update"
  | "configs:set-default"
  | "configs:delete"
  | "profiles:create"
  | "profiles:update"
  | "profiles:remove"
  | "roles:list"
  | "roles:create"
  | "roles:update"
  | "roles:remove"
  | "memory:list"
  | "memory:approve"
  | "memory:reject"
  | "memory:update"
  | "memory:search"
  | "habits:list"
  | "habits:create"
  | "habits:update"
  | "habits:approve"
  | "habits:reject"
  | "habits:set-enabled"
  | "habits:check-conflicts";

/** 目录选择器挂靠的父窗口取值器（窗口在数据层装配后才创建，故惰性取用）。 */
export type MainWindowGetter = () => BrowserWindow | null;

export interface DataHandlersOptions {
  /** 项目从注册表移除后的清场（杀该项目 PTY 等）；可在终端层装配后注入。 */
  readonly onProjectRemoved?: (projectId: string) => void | Promise<void>;
  /** T10.5'：与 CLI 启动层共享的权威权限表。 */
  readonly authRegistry?: import("./workbench/auth-registry").WorkbenchAuthRegistry;
  /** T10.10：把记忆索引交给工作台层，避免两套连接各写各的。 */
  readonly shareMemoryIndex?: (service: MemoryIndexService) => void;
}

/** 绑定或新建时，配置不存在，或当前项目不在可用范围内。 */
export class ProjectConfigNotVisibleError extends Error {
  readonly code = "config-not-visible" as const;
  readonly reason: string;

  constructor() {
    const message = "这张配置不存在，或只对指定项目开放";
    super(message);
    this.name = "ProjectConfigNotVisibleError";
    this.reason = message;
  }
}

/**
 * 解析全局数据根、幂等初始化布局、绑定项目注册表，返回契约化的 handler 表。
 * 在 app.whenReady 之后、注册窗口之前调用一次。
 */
export async function createDataHandlers(
  getWindow: MainWindowGetter,
  options: DataHandlersOptions = {},
): Promise<Pick<InvokeHandlers, DataChannel>> {
  // 全局数据根经共享解析（FF_PANE_DATA_ROOT 覆盖优先）；session 层必须共用同一解析。
  const layout = await initGlobalLayout(resolveGlobalRoot());
  // T9.11：旧来源/档案/角色/密钥一次性丢掉，按「本地 CLI / 中转」重配。
  await resetLegacyAgentConfigIfNeeded({
    rootDir: layout.rootDir,
    providersFile: layout.providersFile,
    profilesFile: layout.profilesFile,
    rolesFile: layout.rolesFile,
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  const registry = createProjectRegistry(layout.projectsFile);
  const providers = createProviderStore(layout.providersFile);
  const profiles = createProfileStore(layout.profilesFile);
  const projectConfigs = createProjectConfigStore(layout.configsFile);
  const roles = createRoleStore(layout.rolesFile);
  const config = createConfigStore(layout.configFile);
  const workbenchLayouts = createWorkbenchLayoutStore(layout.workbenchLayoutsFile);

  // Profile 落盘前的校验（W1.6，T8.4 扩展）：provider 引用 / 模型 kind / 角色
  // （内置字面量或已存在的自定义角色）/ 权限预设 vs 角色默认（自定义角色以其预设为默认层）。
  // 拒绝以抛错表达，violations 随 ProfileValidationError 上行到 IPC / 界面。
  const validateProfile: ProfileDraftValidator = async (draft) => {
    const result = await validateProfileDraft(draft, {
      getProvider: (id) => providers.getProvider(id),
      getCustomRole: (id) => roles.getRole(id),
      getSupportedReasoningEfforts: async (runtime, model) => {
        if (runtime !== "opencode") {
          return undefined;
        }
        return readOpenCodeEffortValues(model);
      },
    });
    if (!result.ok) {
      throw new ProfileValidationError(result.violations);
    }
  };

  // 自定义角色落盘前的校验（T8.4）：名称/提示词非空、预设不出项目根、§7 危险清单不可关闭。
  // 校验落 core（界面层只是表单），拒绝抛 CustomRoleValidationError 上行。
  const validateRole: RoleDraftValidator = (draft) => {
    const result = validateCustomRoleDraft(draft);
    if (!result.ok) {
      throw new CustomRoleValidationError(result.violations);
    }
  };
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });

  // 记忆语义检索（T8.7）：项目级索引连接惰性打开；嵌入配置与知识库共用同一 Provider 面。
  const memoryIndex = createMemoryIndexService({
    listProviders: () => providers.listProviders(),
    revealSecret: (ref) => secrets.revealSecret(ref),
    log: (message) => console.log(message),
  });
  options.shareMemoryIndex?.(memoryIndex);

  // 测试连接 / 拉取模型的共用取密逻辑：优先明文（未保存表单），否则用引用解密（已保存）。
  // 明文用完即弃、不出现在任何返回值（§4.3；探测层输出已 redact 兜底）。
  async function resolveProbeKey(input: {
    readonly apiKey?: string;
    readonly apiKeyRef?: ApiKeyRef;
  }): Promise<string | undefined> {
    if (input.apiKey !== undefined && input.apiKey.length > 0) {
      return input.apiKey;
    }
    if (input.apiKeyRef !== undefined) {
      return secrets.revealSecret(input.apiKeyRef);
    }
    return undefined;
  }

  // 项目摘要只看数据目录在不在。计划、任务、Run、会话登记留在磁盘上，这里不读。
  const summarySources: ProjectSummarySources = {
    resolveLayout: resolveProjectLayout,
    workbenchPresent: async (projectLayout) => {
      try {
        return (await stat(projectLayout.workbenchDir)).isDirectory();
      } catch {
        // ENOENT（目录被删）与 EACCES/EIO（坏盘）在卡片上是同一句话：这个项目的数据读不到
        return false;
      }
    },
  };

  const assertConfigDraft = async (
    draft: {
      readonly claude?: { readonly connectionMode: string; readonly providerId?: string };
      readonly codex?: { readonly connectionMode: string; readonly providerId?: string };
      readonly projectIds?: readonly string[];
    },
    configId?: string,
  ): Promise<void> => {
    for (const route of [draft.claude, draft.codex]) {
      if (route?.connectionMode !== "relay") {
        continue;
      }
      const providerId = route.providerId;
      if (
        providerId === undefined ||
        (await providers.getProvider(providerId as never)) === undefined
      ) {
        throw new ProjectConfigDraftInvalidError("中转来源不存在");
      }
    }
    if (configId === undefined) {
      return;
    }
    const projects = await registry.listProjects();
    const bound: { id: string; name: string }[] = [];
    for (const project of projects) {
      const settings = await createProjectSettingsStore(
        resolveProjectLayout(project.rootPath).projectFile,
      ).readSettings();
      if (settings.configId === configId) {
        bound.push({ id: project.id, name: project.name });
      }
    }
    const names = projectNamesOutsideScope(bound, draft.projectIds);
    if (names.length > 0) {
      throw new ProjectConfigScopeBlockedError(names);
    }
  };

  const assertConfigUsableByProject = async (
    configId: string,
    projectId: string | undefined,
  ): Promise<void> => {
    await projectConfigs.ensureDefaultConfig();
    const found = (await projectConfigs.listConfigs()).find((item) => item.id === configId);
    const visible =
      found !== undefined &&
      (projectId === undefined
        ? isProjectConfigScopeOpen(found.projectIds)
        : isProjectConfigVisibleTo(found, projectId));
    if (!visible) {
      throw new ProjectConfigNotVisibleError();
    }
  };

  return {
    "dialog:pick-directory": async () => {
      const window = getWindow();
      const options: OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
      };
      const result =
        window !== null
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
      const [picked] = result.filePaths;
      if (result.canceled || picked === undefined) {
        return { cancelled: true } as const;
      }
      return { cancelled: false, path: picked } as const;
    },

    "projects:list": () => registry.listProjects(),

    // §11.1 项目列表页：注册表 + 逐项目当场汇总的派生信息（不持久化，见 project-summary.ts）
    "projects:summary": async () =>
      summarizeProjects(await registry.listProjects(), summarySources),

    "projects:create": async (request) => {
      // 归一为绝对路径：注册表以 rootPath 唯一，接线层负责归一（见 registry 模块注释）
      const rootPath = resolve(request.rootPath);
      const configId = request.configId?.trim() ?? "";
      if (configId !== "") {
        await assertConfigUsableByProject(configId, undefined);
      }
      // 幂等生成 .workbench/ 全套目录（已存在即跳过，不动已有内容）
      await initProjectLayout(rootPath);
      const entry = await registry.addProject({ name: request.name, rootPath });
      if (configId !== "") {
        await createProjectSettingsStore(resolveProjectLayout(rootPath).projectFile).updateSettings(
          {
            configId,
          },
        );
      }
      return entry;
    },

    "projects:remove": async (request) => {
      const removed = await registry.removeProject(request.id);
      await workbenchLayouts.removeProject(request.id);
      await options.onProjectRemoved?.(request.id);
      return removed;
    },

    "projects:restore": (request) => registry.restoreProject(request.entry),

    // 项目级设置（T6.6）：只读写 project.json 中本层负责的字段，其余键原样保留
    "projects:get-settings": (request) =>
      createProjectSettingsStore(
        resolveProjectLayout(request.projectRoot).projectFile,
      ).readSettings(),

    "projects:update-settings": async (request) => {
      const configId = request.patch.configId;
      const trimmed = typeof configId === "string" ? configId.trim() : configId;
      if (typeof trimmed === "string" && trimmed !== "") {
        const projects = await registry.listProjects();
        const project = projects.find(
          (item) => resolve(item.rootPath) === resolve(request.projectRoot),
        );
        await assertConfigUsableByProject(trimmed, project?.id);
      }
      const patch =
        typeof trimmed === "string" && trimmed !== ""
          ? { ...request.patch, configId: trimmed }
          : request.patch;
      return createProjectSettingsStore(
        resolveProjectLayout(request.projectRoot).projectFile,
      ).updateSettings(patch);
    },

    "providers:list": () => providers.listProviders(),

    "providers:create": async (request) => {
      // 明文密钥先加密落库，再把引用写进草稿；密钥本体不入 providers.json（§4.3）
      const draft: ProviderDraft =
        request.apiKey !== undefined && request.apiKey.length > 0
          ? { ...request.draft, apiKeyRef: await secrets.storeSecret(request.apiKey) }
          : request.draft;
      return providers.createProvider(draft);
    },

    "providers:update": async (request) => {
      const existing = await providers.getProvider(request.id);
      const oldRef = existing?.apiKeyRef;
      // 决定本次落盘的引用：清除 → 无；换新 → 存新得引用；否则沿用旧引用
      let nextRef: ApiKeyRef | undefined;
      if (request.clearApiKey === true) {
        nextRef = undefined;
      } else if (request.apiKey !== undefined && request.apiKey.length > 0) {
        nextRef = await secrets.storeSecret(request.apiKey);
      } else {
        nextRef = oldRef;
      }
      // exactOptionalPropertyTypes：清除密钥须「省略」apiKeyRef 而非置 undefined
      const { apiKeyRef: _dropped, ...rest } = request.draft;
      const draft: ProviderDraft = nextRef !== undefined ? { ...rest, apiKeyRef: nextRef } : rest;
      const updated = await providers.updateProvider(request.id, draft);
      // 落盘成功后再清理被替换 / 被清除的旧密文（顺序保证任何失败都不丢可用密钥）
      if (oldRef !== undefined && oldRef !== nextRef) {
        await secrets.deleteSecret(oldRef);
      }
      return updated;
    },

    "providers:remove": async (request) => {
      const existing = await providers.getProvider(request.id);
      // 在用保护：被任一 Profile 引用时拒删（deleteProvider 抛 ProviderInUseError）
      await providers.deleteProvider(request.id, async (pid) => {
        if (profileReferencesProvider(await profiles.listProfiles(), pid)) {
          return true;
        }
        return configReferencesProvider(await projectConfigs.listConfigs(), pid);
      });
      if (existing?.apiKeyRef !== undefined) {
        await secrets.deleteSecret(existing.apiKeyRef);
      }
      return { removed: true } as const;
    },

    "providers:test-connection": async (request) => {
      // 代理先解析：地址非法时一次网络请求都不该发出去（走 invalid-config 通道）。
      const outlet = resolveProbeOutlet(request.proxy);
      if (!outlet.ok) {
        return outlet.failure;
      }
      // 取密钥也在 try 内：revealSecret 会抛（SecretNotFoundError / 后端不可用），
      // 抛在 try 之外则已构造的 ProxyAgent 不会 close。
      try {
        const apiKey = await resolveProbeKey(request);
        return await testConnection({
          provider: request.provider,
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(outlet.fetchImpl !== undefined ? { fetchImpl: outlet.fetchImpl } : {}),
        });
      } finally {
        await outlet.dispose?.();
      }
    },

    "providers:fetch-models": async (request) => {
      const outlet = resolveProbeOutlet(request.proxy);
      if (!outlet.ok) {
        return outlet.failure;
      }
      // 同 test-connection：取密钥的抛出路径也必须经过 finally 的 close。
      try {
        const apiKey = await resolveProbeKey(request);
        return await fetchModels({
          provider: request.provider,
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(outlet.fetchImpl !== undefined ? { fetchImpl: outlet.fetchImpl } : {}),
        });
      } finally {
        await outlet.dispose?.();
      }
    },

    // cli_login 登录态探测（T9.2 ②）：接线既有 adapters probeCliLogin。
    // 探测层自身吞异常落 unknown（probe.ts），此处只挡契约外的 runtime 值。
    "providers:probe-cli-login": async (request) => {
      if (!isCliLoginRuntime(request.runtime)) {
        return {
          status: "unknown",
          detail: `不支持登录态探测的 Runtime：${String(request.runtime)}`,
          probedWith: "",
        };
      }
      return probeCliLogin(request.runtime);
    },

    // cli_login 本地模型枚举（T9.2 ③）：接线 adapters listLocalModels。
    // 不支持的 Runtime（claude-code / gemini-cli）由枚举层如实回 unsupported。
    "providers:list-local-models": async (request) => {
      if (!isCliLoginRuntime(request.runtime)) {
        return {
          ok: false,
          error: "unsupported",
          detail: `非 cli_login Runtime：${String(request.runtime)}`,
        };
      }
      return listLocalModels(request.runtime);
    },

    "runtimes:reasoning-effort-levels": async (request) => {
      const catalog =
        request.runtime === "opencode" ? await readOpenCodeEffortValues(request.model) : undefined;
      return { levels: [...resolveReasoningEffortOptions(request.runtime, catalog)] };
    },

    "secrets:masked-tail": async (request) => ({ tail: await secrets.maskedTail(request.ref) }),

    "config:get": () => config.readConfig(),

    "config:update": (request) => config.updateConfig(request),

    "workbench:get-layouts": async () => {
      const all = await workbenchLayouts.readAll();
      const authRegistry = options.authRegistry;
      if (authRegistry === undefined) {
        return all;
      }
      const next: Record<string, (typeof all)[string]> = {};
      for (const [projectId, layout] of Object.entries(all)) {
        if (authRegistry.hasProject(layout.projectId)) {
          next[projectId] = authRegistry.syncLayout(layout);
        } else {
          const restored = authRegistry.restoreColdLayout(layout);
          await workbenchLayouts.saveProject(restored);
          next[projectId] = restored;
        }
      }
      return next;
    },
    "workbench:save-layout": async (request) => {
      const authRegistry = options.authRegistry;
      const previous = (await workbenchLayouts.readAll())[request.layout.projectId];
      const windows = { ...request.layout.windows };
      if (previous !== undefined) {
        for (const [id, window] of Object.entries(windows)) {
          const prior = previous.windows[id];
          if (prior !== undefined) {
            windows[id] = keepModelEffortOverrides(window, prior);
          }
        }
      }
      const incoming = { ...request.layout, windows };
      const layout = authRegistry !== undefined ? authRegistry.syncLayout(incoming) : incoming;
      await workbenchLayouts.saveProject(layout);
      return { ok: true as const };
    },

    "profiles:list": () => profiles.listProfiles(),

    "configs:list": async () => {
      await projectConfigs.ensureDefaultConfig();
      return projectConfigs.listConfigs();
    },

    "configs:create": (request) =>
      projectConfigs.createConfig(request.draft, (draft) => assertConfigDraft(draft)),

    "configs:update": (request) =>
      projectConfigs.updateConfig(request.id, request.draft, (draft) =>
        assertConfigDraft(draft, request.id),
      ),

    "configs:set-default": (request) => projectConfigs.setDefaultConfig(request.id),

    "configs:delete": async (request) => {
      await projectConfigs.deleteConfig(request.id, request.newDefaultId);
      return { removed: true } as const;
    },

    "profiles:create": async (request) => {
      const draft = await materializeProfileDraft(request.draft, providers);
      return profiles.createProfile(draft, validateProfile);
    },

    "profiles:update": async (request) => {
      const draft = await materializeProfileDraft(request.draft, providers);
      return profiles.updateProfile(request.id, draft, validateProfile);
    },

    "profiles:remove": async (request) => {
      await profiles.deleteProfile(request.id);
      return { removed: true } as const;
    },

    "roles:list": () => roles.listRoles(),

    "roles:create": (request) => roles.createRole(request.draft, validateRole),

    "roles:update": (request) => roles.updateRole(request.id, request.draft, validateRole),

    "roles:remove": async (request) => {
      // 删除保护（T8.4 口径）：被 Profile 引用（defaultRole 指向它）即拒删，先解绑再删
      await roles.deleteRole(request.id, async (roleId) =>
        profileReferencesRole(await profiles.listProfiles(), roleId),
      );
      return { removed: true } as const;
    },

    "memory:list": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      // listEntries 内部对缺目录容错（ENOENT 跳过），损坏文件进 issues 不阻断
      const { entries } = await listEntries(layout);
      return entries;
    },

    "memory:approve": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const result = await updateEntryStatus(layout, request.id, "active");
      if (!result.ok) {
        throw result.error;
      }
      // 先写真实源成功、再调索引钩子（W1.3b 纪律）；钩子失败由下次对账自愈
      await memoryIndex.entrySaved(request.projectRoot, result.value);
      return result.value;
    },

    "memory:reject": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const removed = await deleteEntry(layout, request.id);
      if (removed) {
        await memoryIndex.entryDeleted(request.projectRoot, request.id);
      }
      return { removed };
    },

    "memory:update": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      // saveEntry 按 status 落位并自愈旧址副本（编辑后通过：内容 + 状态一并写回）
      await saveEntry(layout, request.entry);
      await memoryIndex.entrySaved(request.projectRoot, request.entry);
      return request.entry;
    },

    // T8.7 记忆混合检索：FTS/LIKE + 向量 → RRF 融合；未配嵌入来源退化纯关键词
    "memory:search": (request) => memoryIndex.search(request),

    // ── 习惯（共享记忆，§8.2）：全局作用域，绑定 GlobalLayout（无 projectRoot）──

    "habits:list": async () => {
      // listHabits 内部对缺目录容错（ENOENT 跳过），损坏文件进 issues 不阻断
      const { entries } = await listHabits(layout);
      return entries;
    },

    "habits:create": async (request) => {
      validateHabitDraft(request.draft);
      const now = Date.now();
      const entry: HabitEntry = {
        ...request.draft,
        id: `hab-${randomUUID()}` as HabitEntryId,
        createdAt: now,
        updatedAt: now,
      };
      await saveHabit(layout, entry);
      return entry;
    },

    "habits:update": async (request) => {
      // 整条写回：刷新 updatedAt，触发习惯档案下次重编译（§8.2.2）
      const entry: HabitEntry = { ...request.entry, updatedAt: Date.now() };
      validateHabitDraft(entry);
      await saveHabit(layout, entry);
      return entry;
    },

    "habits:approve": async (request) => {
      // 候选（来源二/三）→ active，唯一入 active 途径是用户确认（§8.2.4）
      const result = await updateHabitStatus(layout, request.id, "active");
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },

    "habits:reject": async (request) => {
      const removed = await deleteHabit(layout, request.id);
      return { removed };
    },

    "habits:set-enabled": async (request) => {
      const result = await setHabitEnabled(layout, request.id, request.enabled);
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },

    "habits:check-conflicts": async (request) => {
      // 入库前查相近条目（§8.2.5）：只比 active + candidate（archived 已退出，不干扰）
      const { entries } = await listHabits(layout);
      const relevant = entries.filter((entry) => entry.status !== "archived");
      return detectHabitConflicts(
        {
          category: request.category,
          content: request.content,
          ...(request.excludeId !== undefined ? { excludeId: request.excludeId } : {}),
        },
        relevant,
      );
    },
  };
}
