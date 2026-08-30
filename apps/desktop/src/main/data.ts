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
import { resolve } from "node:path";
import {
  acceptTask,
  approvePlan,
  cancelTask,
  deriveAcceptanceCandidates,
  detectHabitConflicts,
  fetchModels,
  ProfileValidationError,
  testConnection,
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
  createProviderStore,
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
  type ProviderDraft,
  profileReferencesProvider,
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
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "./secrets";

/** 本数据层负责的 invoke 通道集合。 */
type DataChannel =
  | "dialog:pick-directory"
  | "projects:list"
  | "projects:create"
  | "projects:remove"
  | "projects:restore"
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
  | "sessions:list";

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
  const config = createConfigStore(layout.configFile);

  // Profile 落盘前的校验（W1.6）：provider 引用 / 模型 kind / 角色 / 权限预设 vs 角色默认。
  // 拒绝以抛错表达，violations 随 ProfileValidationError 上行到 IPC / 界面。
  const validateProfile: ProfileDraftValidator = async (draft) => {
    const result = await validateProfileDraft(draft, {
      getProvider: (id) => providers.getProvider(id),
    });
    if (!result.ok) {
      throw new ProfileValidationError(result.violations);
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

    "projects:create": async (request) => {
      // 归一为绝对路径：注册表以 rootPath 唯一，接线层负责归一（见 registry 模块注释）
      const rootPath = resolve(request.rootPath);
      // 幂等生成 .workbench/ 全套目录（已存在即跳过，不动已有内容）
      await initProjectLayout(rootPath);
      return registry.addProject({ name: request.name, rootPath });
    },

    "projects:remove": (request) => registry.removeProject(request.id),

    "projects:restore": (request) => registry.restoreProject(request.entry),

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
      const apiKey = await resolveProbeKey(request);
      return testConnection({
        provider: request.provider,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
      });
    },

    "providers:fetch-models": async (request) => {
      const apiKey = await resolveProbeKey(request);
      return fetchModels({
        provider: request.provider,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
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

    "plans:list": async (request) => {
      const layout = resolveProjectLayout(request.projectRoot);
      // 版本 v1..vN 连续（每次修改产出下一版），逐版加载到 not-found 为止
      const plans: Plan[] = [];
      for (let v = 1; ; v += 1) {
        const result = await loadPlan(layout, v as PlanVersion);
        if (!result.ok) {
          if (result.error.code === "not-found") {
            break;
          }
          throw result.error;
        }
        plans.push(result.value.plan);
      }
      return plans;
    },

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
