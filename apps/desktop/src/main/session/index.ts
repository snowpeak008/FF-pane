/**
 * 会话执行层装配（T4.2）：把编排器接到真实的存取 / 密钥 / 适配器注册表 / 事件推送，
 * 并暴露为契约化的 invoke handlers（session:start / respond-permission / cancel）。
 *
 * 与 data.ts 一样在全局根上装配自己的 store 实例（文件后端，读即命中磁盘，与数据层
 * 一致无副本问题）。事件推送经 publishEvent 打到当前主窗口的 webContents。
 */

import { randomUUID } from "node:crypto";
import type { LocalSessionId, Plan, PlanVersion, RunId } from "@ff-pane/shared";
import {
  createConfigStore,
  createProfileStore,
  createProviderStore,
  createSessionStore,
  initGlobalLayout,
  listEntries,
  listHabits,
  listRuns,
  listTasks,
  loadPlan,
  loadStateSnapshot,
  loadTask,
  type ProjectLayout,
  resolveProjectLayout,
  savePlan,
  saveRun,
  saveTask,
  writeRunChangesDiff,
  writeRunRawLog,
} from "@ff-pane/storage";
import { type InvokeHandlers, publishEvent, type WebContentsLike } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import { createSessionOrchestrator } from "./orchestrator";
import { createDesktopAdapterRegistry } from "./registry";

export * from "./env";
export * from "./event-map";
export * from "./orchestrator";
export * from "./registry";

/** 本层负责的 invoke 通道集合。 */
type SessionChannel = "session:start" | "session:respond-permission" | "session:cancel";

/** 事件推送目标窗口取值器（惰性：窗口在装配后才创建，且可能已关闭）。 */
export type SessionWindowGetter = () => { readonly webContents: WebContentsLike } | null;

/**
 * 装配会话执行 handlers。在 app.whenReady 之后、注册窗口之前调用一次。
 */
export async function createSessionHandlers(
  getWindow: SessionWindowGetter,
): Promise<Pick<InvokeHandlers, SessionChannel>> {
  const layout = await initGlobalLayout(resolveGlobalRoot());
  const providers = createProviderStore(layout.providersFile);
  const profiles = createProfileStore(layout.profilesFile);
  const config = createConfigStore(layout.configFile);
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  const registry = createDesktopAdapterRegistry();

  // 最新计划版本：v1..vN 连续，逐版加载到 not-found 为止，返回末版（与 data.ts plans:list 同构）
  async function loadLatestPlan(projectLayout: ProjectLayout): Promise<Plan | undefined> {
    let latest: Plan | undefined;
    for (let v = 1; ; v += 1) {
      const result = await loadPlan(projectLayout, v as PlanVersion);
      if (!result.ok) {
        if (result.error.code === "not-found") {
          break;
        }
        throw result.error;
      }
      latest = result.value.plan;
    }
    return latest;
  }

  const orchestrator = createSessionOrchestrator({
    registry,
    publish: (event) => {
      const window = getWindow();
      if (window !== null) {
        publishEvent(window.webContents, "session:event", event);
      }
    },
    loadProfile: (id) => profiles.getProfile(id),
    loadProvider: (id) => providers.getProvider(id),
    revealSecret: (ref) => secrets.revealSecret(ref),
    resolveLayout: (root) => resolveProjectLayout(root),
    loadActiveMemory: async (projectLayout) => {
      const { entries } = await listEntries(projectLayout, { status: "active" });
      return entries;
    },
    // 习惯是共享记忆（全局，§8.2）：绑定 GlobalLayout，编译器筛 active + enabled 进 Prompt 第 2 层。
    loadHabits: async () => {
      const { entries } = await listHabits(layout);
      return entries;
    },
    loadStateSnapshot: async (projectLayout) => {
      const result = await loadStateSnapshot(projectLayout);
      return result.ok ? result.value.body : undefined;
    },
    loadGlobalConfig: () => config.readConfig(),
    loadTask: async (projectLayout, id) => {
      const loaded = await loadTask(projectLayout, id);
      return loaded.ok ? loaded.value : undefined;
    },
    saveTask: async (projectLayout, task) => {
      await saveTask(projectLayout, task);
    },
    listRuns: async (projectLayout) => {
      const result = await listRuns(projectLayout);
      return result.ok ? result.value : [];
    },
    listTasks: async (projectLayout) => {
      const result = await listTasks(projectLayout);
      return result.ok ? result.value : [];
    },
    loadLatestPlan,
    loadSession: (projectLayout, id) =>
      createSessionStore(projectLayout.sessionsFile).getSession(id),
    saveSession: (projectLayout, record) =>
      createSessionStore(projectLayout.sessionsFile).saveSession(record),
    savePlan: async (projectLayout, plan) => {
      await savePlan(projectLayout, plan);
    },
    persistRun: async (projectLayout, run, rawLog, changesDiff) => {
      await saveRun(projectLayout, run);
      await writeRunRawLog(projectLayout, run.id, rawLog);
      if (changesDiff.length > 0) {
        await writeRunChangesDiff(projectLayout, run.id, changesDiff);
      }
    },
    now: () => Date.now(),
    newRunId: () => randomUUID() as RunId,
    newLocalSessionId: () => randomUUID() as LocalSessionId,
  });

  return {
    "session:start": (request) => orchestrator.start(request),
    "session:respond-permission": (request) => orchestrator.respondPermission(request),
    "session:cancel": (request) => orchestrator.cancel(request),
  };
}
