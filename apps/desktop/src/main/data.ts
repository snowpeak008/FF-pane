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
  acceptTask,
  approvePlan,
  buildHandoff,
  CustomRoleValidationError,
  cancelTask,
  deriveAcceptanceCandidates,
  detectHabitConflicts,
  fetchModels,
  ProfileValidationError,
  renderHandoff,
  testConnection,
  validateCustomRoleDraft,
  validateProfileDraft,
} from "@ff-pane/core";
import type {
  ApiKeyRef,
  HabitEntry,
  HabitEntryId,
  MemoryEntryId,
  Plan,
  PlanVersion,
} from "@ff-pane/shared";
import {
  createConfigStore,
  createProfileStore,
  createProjectRegistry,
  createProjectSettingsStore,
  createProviderStore,
  createRoleStore,
  createSessionStore,
  deleteEntry,
  deleteHabit,
  initGlobalLayout,
  initProjectLayout,
  listEntries,
  listHabits,
  listRuns,
  listTasks,
  loadPlan,
  loadTask,
  type ProfileDraftValidator,
  type ProjectLayout,
  type ProviderDraft,
  profileReferencesProvider,
  profileReferencesRole,
  type RoleDraftValidator,
  resolveProjectLayout,
  saveEntry,
  saveHabit,
  savePlan,
  saveTask,
  setHabitEnabled,
  updateEntryStatus,
  updateHabitStatus,
  validateHabitDraft,
} from "@ff-pane/storage";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { InvokeHandlers } from "../shared-ipc/server";
import { resolveGlobalRoot } from "./data-root";
import { type ProjectSummarySources, summarizeProjects } from "./project-summary";
import { resolveProbeOutlet } from "./provider-proxy";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "./secrets";

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
  | "secrets:masked-tail"
  | "config:get"
  | "config:update"
  | "profiles:list"
  | "profiles:create"
  | "profiles:update"
  | "profiles:remove"
  | "roles:list"
  | "roles:create"
  | "roles:update"
  | "roles:remove"
  | "tasks:list"
  | "tasks:accept"
  | "tasks:cancel"
  | "runs:list"
  | "memory:list"
  | "memory:approve"
  | "memory:reject"
  | "memory:update"
  | "habits:list"
  | "habits:create"
  | "habits:update"
  | "habits:approve"
  | "habits:reject"
  | "habits:set-enabled"
  | "habits:check-conflicts"
  | "plans:list"
  | "plans:approve"
  | "sessions:list"
  | "handoff:generate";

/** 目录选择器挂靠的父窗口取值器（窗口在数据层装配后才创建，故惰性取用）。 */
export type MainWindowGetter = () => BrowserWindow | null;

/**
 * 解析全局数据根、幂等初始化布局、绑定项目注册表，返回契约化的 handler 表。
 * 在 app.whenReady 之后、注册窗口之前调用一次。
 */
export async function createDataHandlers(
  getWindow: MainWindowGetter,
): Promise<Pick<InvokeHandlers, DataChannel>> {
  // 全局数据根经共享解析（FF_PANE_DATA_ROOT 覆盖优先）；session 层必须共用同一解析。
  const layout = await initGlobalLayout(resolveGlobalRoot());
  const registry = createProjectRegistry(layout.projectsFile);
  const providers = createProviderStore(layout.providersFile);
  const profiles = createProfileStore(layout.profilesFile);
  const roles = createRoleStore(layout.rolesFile);
  const config = createConfigStore(layout.configFile);

  // Profile 落盘前的校验（W1.6，T8.4 扩展）：provider 引用 / 模型 kind / 角色
  // （内置字面量或已存在的自定义角色）/ 权限预设 vs 角色默认（自定义角色以其预设为默认层）。
  // 拒绝以抛错表达，violations 随 ProfileValidationError 上行到 IPC / 界面。
  const validateProfile: ProfileDraftValidator = async (draft) => {
    const result = await validateProfileDraft(draft, {
      getProvider: (id) => providers.getProvider(id),
      getCustomRole: (id) => roles.getRole(id),
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

  // 全部计划版本（v1..vN 连续，逐版加载到 not-found 为止，按版本升序）。与 session 层的
  // 同名逻辑是两份同形代码：那份绑在编排器依赖注入上，这份服务查询通道，跨进程边界不共享闭包。
  async function loadAllPlans(projectLayout: ProjectLayout): Promise<readonly Plan[]> {
    const plans: Plan[] = [];
    for (let v = 1; ; v += 1) {
      const result = await loadPlan(projectLayout, v as PlanVersion);
      if (!result.ok) {
        if (result.error.code === "not-found") {
          break;
        }
        throw result.error;
      }
      plans.push(result.value.plan);
    }
    return plans;
  }

  /** 最新计划版本（= 版本号最大的那份，见 loadAllPlans）。 */
  async function loadLatestPlan(projectLayout: ProjectLayout): Promise<Plan | undefined> {
    return (await loadAllPlans(projectLayout)).at(-1);
  }

  // 项目摘要（T7.4）的四路读取：一律用查询通道自己那套「缺目录视为空集」的处置，
  // 其余读错误照常抛出，由 summarizeProject 降级为对应源的 unavailable。
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
    listPlans: loadAllPlans,
    listTasks: async (projectLayout) => {
      const result = await listTasks(projectLayout);
      if (!result.ok) {
        if (result.error.code === "not-found") {
          return [];
        }
        throw result.error;
      }
      return result.value;
    },
    listRuns: async (projectLayout) => {
      const result = await listRuns(projectLayout);
      if (!result.ok) {
        if (result.error.code === "not-found") {
          return [];
        }
        throw result.error;
      }
      return result.value;
    },
    listSessions: (projectLayout) => createSessionStore(projectLayout.sessionsFile).listSessions(),
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
      // 幂等生成 .workbench/ 全套目录（已存在即跳过，不动已有内容）
      await initProjectLayout(rootPath);
      return registry.addProject({ name: request.name, rootPath });
    },

    "projects:remove": (request) => registry.removeProject(request.id),

    "projects:restore": (request) => registry.restoreProject(request.entry),

    // 项目级设置（T6.6）：只读写 project.json 中本层负责的字段，其余键原样保留
    "projects:get-settings": (request) =>
      createProjectSettingsStore(
        resolveProjectLayout(request.projectRoot).projectFile,
      ).readSettings(),

    "projects:update-settings": (request) =>
      createProjectSettingsStore(
        resolveProjectLayout(request.projectRoot).projectFile,
      ).updateSettings(request.patch),

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
      await providers.deleteProvider(request.id, async (pid) =>
        profileReferencesProvider(await profiles.listProfiles(), pid),
      );
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

    "secrets:masked-tail": async (request) => ({ tail: await secrets.maskedTail(request.ref) }),

    "config:get": () => config.readConfig(),

    "config:update": (request) => config.updateConfig(request),

    "profiles:list": () => profiles.listProfiles(),

    "profiles:create": (request) => profiles.createProfile(request.draft, validateProfile),

    "profiles:update": (request) =>
      profiles.updateProfile(request.id, request.draft, validateProfile),

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

    "tasks:list": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const result = await listTasks(layout);
      if (!result.ok) {
        // tasks 目录缺失（未初始化的项目）视为空集，其余读错误上抛
        if (result.error.code === "not-found") {
          return [];
        }
        throw result.error;
      }
      return result.value;
    },

    "tasks:accept": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const loaded = await loadTask(layout, request.id);
      if (!loaded.ok) {
        throw loaded.error;
      }
      const accepted = acceptTask(loaded.value, "user");
      await saveTask(layout, accepted);
      // T4.4：验收即从任务沉淀派生记忆候选（§8.1）。落库失败不回滚验收——任务已 accepted
      // 是事实，候选缺失可由用户后续手写补，不该让记忆派生阻断验收终态。
      let candidateCount = 0;
      try {
        const runsResult = await listRuns(layout);
        const runs = runsResult.ok ? runsResult.value : [];
        const candidates = deriveAcceptanceCandidates({
          task: accepted,
          runs,
          now: Date.now(),
          newId: () => `mem-${randomUUID()}` as MemoryEntryId,
        });
        for (const candidate of candidates) {
          await saveEntry(layout, candidate);
        }
        candidateCount = candidates.length;
      } catch {
        candidateCount = 0;
      }
      return { task: accepted, candidateCount };
    },

    "tasks:cancel": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const loaded = await loadTask(layout, request.id);
      if (!loaded.ok) {
        throw loaded.error;
      }
      const cancelled = cancelTask(loaded.value);
      await saveTask(layout, cancelled);
      return cancelled;
    },

    "runs:list": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const result = await listRuns(layout);
      if (!result.ok) {
        if (result.error.code === "not-found") {
          return [];
        }
        throw result.error;
      }
      return result.value;
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
      return result.value;
    },

    "memory:reject": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const removed = await deleteEntry(layout, request.id);
      return { removed };
    },

    "memory:update": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      // saveEntry 按 status 落位并自愈旧址副本（编辑后通过：内容 + 状态一并写回）
      await saveEntry(layout, request.entry);
      return request.entry;
    },

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

    "sessions:list": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      return createSessionStore(layout.sessionsFile).listSessions();
    },

    "handoff:generate": async (request) => {
      // 跨 Agent 交接包（T7.1，§10.4）。取材只有本项目的计划 / 任务 / 项目记忆三样——
      // 不读 Run（raw.log 的宿主）、不碰密钥模块、不触别的项目，红线在取材面上落实（§4.3 规则 2）。
      const layout = resolveProjectLayout(request.projectRoot);
      const [plan, tasksResult, memoryResult] = await Promise.all([
        loadLatestPlan(layout),
        listTasks(layout),
        listEntries(layout),
      ]);
      // 未初始化的项目（无 tasks 目录）视为空集，与 tasks:list 同一处置；其余读错误上抛。
      if (!tasksResult.ok && tasksResult.error.code !== "not-found") {
        throw tasksResult.error;
      }
      const tasks = tasksResult.ok ? tasksResult.value : [];
      const handoff = buildHandoff({
        ...(plan !== undefined ? { plan } : {}),
        tasks,
        memory: memoryResult.entries,
      });
      return {
        text: renderHandoff(handoff),
        ...(handoff.plan !== undefined ? { planVersion: handoff.plan.version } : {}),
        taskCount: handoff.progress.length,
        decisionCount: handoff.decisions.length,
        ruleCount: handoff.rules.length,
        lessonCount: handoff.recentLessons.length,
        openIssueCount: handoff.openIssues.length,
      };
    },

    "plans:list": (request) => loadAllPlans(resolveProjectLayout(request.projectRoot)),

    "plans:approve": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      const loaded = await loadPlan(layout, request.version);
      if (!loaded.ok) {
        throw loaded.error;
      }
      // 批准只能由用户触发；core 运行时强制 approval.by === "user"
      const approved = approvePlan(loaded.value.plan, { by: "user", at: Date.now() });
      await savePlan(layout, approved);
      // §12 步骤 5：批准后把计划内的任务合同物化为 pending 任务记录（幂等：已存在的跳过，
      // 不覆盖其运行态）。任务看板据此有可派发的条目。
      for (const contract of approved.tasks) {
        const existing = await loadTask(layout, contract.id);
        if (existing.ok) {
          continue;
        }
        if (existing.error.code !== "not-found") {
          throw existing.error;
        }
        await saveTask(layout, { ...contract, status: "pending" });
      }
      return approved;
    },
  };
}
