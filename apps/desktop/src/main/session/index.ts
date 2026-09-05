/**
 * 会话执行层装配（T4.2）：把编排器接到真实的存取 / 密钥 / 适配器注册表 / 事件推送，
 * 并暴露为契约化的 invoke handlers（session:start / respond-permission / cancel，
 * T8.2b 起加 sessions:latest / sessions:transcript）。
 *
 * 与 data.ts 一样在全局根上装配自己的 store 实例（文件后端，读即命中磁盘，与数据层
 * 一致无副本问题）。事件推送经 publishEvent 打到当前主窗口的 webContents。
 *
 * 启动修正（T8.2b）：本层 handlers 首次触碰某项目布局时先跑一次 `ensureRepaired`
 * （幂等、按项目去重），把上次被中断的轮次补齐；bootstrap 另对已登记项目扫一遍
 * （见 `repairRegisteredProjects`）。渲染层并没有"选中项目"的主进程通道——选中是
 * 渲染层 store 状态——故"打开项目时修正"落在会话层首次为该项目服务的那一刻。
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHabitConflicts, observeCorrection } from "@ff-pane/core";
import type {
  HabitEntry,
  HabitEntryId,
  LocalSessionId,
  Plan,
  PlanVersion,
  RunId,
} from "@ff-pane/shared";
import {
  appendTranscriptEntry,
  createConfigStore,
  createObservationStore,
  createProfileStore,
  createProjectRegistry,
  createProjectSettingsStore,
  createProviderStore,
  createRoleStore,
  createSessionStore,
  deleteInflightMarker,
  initGlobalLayout,
  listEntries,
  listHabits,
  listInflightMarkers,
  listRuns,
  listTasks,
  loadPlan,
  loadRun,
  loadStateSnapshot,
  loadTask,
  type ProjectLayout,
  readInflightPartial,
  readTranscript,
  resolveProjectLayout,
  saveHabit,
  savePlan,
  saveRun,
  saveTask,
  writeInflightMarker,
  writeInflightPartial,
  writeRunChangesDiff,
  writeRunRawLog,
} from "@ff-pane/storage";
import { DEFAULT_TRANSCRIPT_LIMIT } from "../../shared-ipc/contracts";
import { type InvokeHandlers, publishEvent, type WebContentsLike } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import {
  createKnowledgeAuditPath,
  readKnowledgeAudit,
  resolveKnowledgeMcpServer,
} from "./knowledge-tool";
import { createSessionOrchestrator, type SessionOrchestrator } from "./orchestrator";
import { createDesktopAdapterRegistry, type DesktopAdapterRegistry } from "./registry";
import { createProjectRepairer, type ProjectRepairer, type RepairDeps } from "./repair";

export * from "./env";
export * from "./event-map";
export * from "./interrupted";
export * from "./knowledge-tool";
export * from "./orchestrator";
export * from "./quit";
export * from "./registry";
export * from "./repair";

/** 主进程模块目录：内置 MCP sidecar 与 main/index.js 同目录（见 electron.vite.config.ts）。 */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** 本层负责的 invoke 通道集合。 */
type SessionChannel =
  | "session:start"
  | "session:respond-permission"
  | "session:cancel"
  | "sessions:latest"
  | "sessions:transcript"
  | "sessions:active-turns";

/** 事件推送目标窗口取值器（惰性：窗口在装配后才创建，且可能已关闭）。 */
export type SessionWindowGetter = () => { readonly webContents: WebContentsLike } | null;

/** createSessionLayer 的产出：handler 表 + 供 main/index.ts 接退出钩子与启动修正的句柄。 */
export interface SessionLayer {
  readonly handlers: Pick<InvokeHandlers, SessionChannel>;
  readonly orchestrator: SessionOrchestrator;
  /** 注册表（T8.5c：退出钩子经 hasRuntimeResources / closeRuntimes 关停 opencode server）。 */
  readonly registry: DesktopAdapterRegistry;
  /** 按项目去重的启动修正入口（data.ts 的 sessions:list 亦可触发）。 */
  readonly repairer: ProjectRepairer;
  /** 对已登记的全部项目各扫一遍残留标记（bootstrap 调用；单个项目失败不阻断其余）。 */
  repairRegisteredProjects(): Promise<void>;
}

/** 启动修正的真实存取绑定（与编排器 deps 同一套 storage 函数，只是形状不同）。 */
function createRepairDeps(isTurnActive: (turnId: string) => boolean): RepairDeps {
  return {
    listInflightMarkers,
    readInflightPartial,
    deleteInflightMarker,
    appendTranscript: appendTranscriptEntry,
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
    persistRun: async (projectLayout, run, rawLog, changesDiff) => {
      await saveRun(projectLayout, run);
      await writeRunRawLog(projectLayout, run.id, rawLog);
      if (changesDiff.length > 0) {
        await writeRunChangesDiff(projectLayout, run.id, changesDiff);
      }
    },
    now: () => Date.now(),
    newRunId: () => randomUUID() as RunId,
    isTurnActive,
    log: (message) => console.log(message),
  };
}

/**
 * 装配会话执行层。在 app.whenReady 之后、注册窗口之前调用一次。
 */
export async function createSessionLayer(getWindow: SessionWindowGetter): Promise<SessionLayer> {
  const layout = await initGlobalLayout(resolveGlobalRoot());
  const projects = createProjectRegistry(layout.projectsFile);
  const providers = createProviderStore(layout.providersFile);
  const profiles = createProfileStore(layout.profilesFile);
  const roles = createRoleStore(layout.rolesFile);
  const config = createConfigStore(layout.configFile);
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  // 多实例装配（T8.4b）：aider 按 Profile 的 transcript 落
  // `<全局数据根>/agent-sessions/<profileId>/`（出 tmpdir，重启后仍在；目录由
  // 适配器 startTurn 按需 mkdirSync -p，无需预建）。
  const registry = createDesktopAdapterRegistry({
    agentSessionsDir: join(layout.rootDir, "agent-sessions"),
    // iFlow 受管 HOME（T8.6b）：settings 与会话存储全部落此（USERPROFILE/HOME
    // 替换，用户真实 ~/.iflow 零触碰）；目录由适配器 startTurn 按需建出。
    iflowHomeDir: join(layout.rootDir, "iflow-home"),
  });

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
    // 自定义角色（T8.4）：Profile.defaultRole 为 CustomRoleId 的讨论轮按该角色行事
    loadCustomRole: (id) => roles.getRole(id),
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
    // 来源三（§8.2.4）：观察讨论消息，跨会话累计纠正 → 达阈值生成 observed 候选并提示。
    // 尽力而为，任何失败都不影响会话（catch 吞掉）。
    observeMessage: (message) => {
      void (async () => {
        try {
          const store = createObservationStore(layout.observationsFile);
          const existing = await store.listObservations();
          const result = observeCorrection({
            observations: existing,
            message,
            now: Date.now(),
            newId: () => `obs-${randomUUID()}`,
          });
          if (result.changed) {
            await store.saveObservations(result.observations);
          }
          if (result.suggestion === undefined) {
            return;
          }
          // 去重：已有相近的 active/candidate 习惯则不再打扰
          const { entries } = await listHabits(layout);
          const relevant = entries.filter((entry) => entry.status !== "archived");
          const near = detectHabitConflicts(
            { category: "workflow", content: result.suggestion.content },
            relevant,
            { threshold: 0.5 },
          );
          if (near.length > 0) {
            return;
          }
          const now = Date.now();
          const candidate: HabitEntry = {
            id: `hab-${randomUUID()}` as HabitEntryId,
            category: "workflow",
            content: result.suggestion.content,
            status: "candidate",
            enabled: true,
            source: { kind: "observed" },
            importance: 50,
            createdAt: now,
            updatedAt: now,
          };
          await saveHabit(layout, candidate);
          const window = getWindow();
          if (window !== null) {
            publishEvent(window.webContents, "habits:suggestion", {
              habitId: candidate.id,
              content: candidate.content,
              count: result.suggestion.count,
            });
          }
        } catch {
          // 观察是尽力而为的后台行为，失败静默——绝不影响正在进行的会话
        }
      })();
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
    loadRun: async (projectLayout, id) => {
      const result = await loadRun(projectLayout, id);
      return result.ok ? result.value : undefined;
    },
    // 审查结论回写（T7.2）：只改 run.json，不碰 raw.log / changes.diff——
    // 那两份正是被审查的证据本身（见编排器 deps.updateRun 注释）。
    updateRun: async (projectLayout, run) => {
      await saveRun(projectLayout, run);
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
    // Agent 只读知识库检索工具（T6.6，§8.3.5 路径二）：项目开关默认关闭，
    // 关着就返回 undefined —— 本轮连 MCP 配置都不生成，Agent 侧完全看不到这个工具。
    prepareKnowledgeTool: async (projectLayout) => {
      const settings = await createProjectSettingsStore(projectLayout.projectFile).readSettings();
      if (!settings.knowledgeToolEnabled) {
        return undefined;
      }
      const auditPath = await createKnowledgeAuditPath();
      const globalConfig = await config.readConfig();
      const { serverName, spec } = resolveKnowledgeMcpServer({
        moduleDir,
        // 知识库是全局作用域（§10.1，T6.5 结论），故索引库取全局 layout 而非项目 layout
        indexDbFile: layout.indexDbFile,
        auditPath,
        ...(globalConfig.knowledgeTool !== undefined
          ? { settings: globalConfig.knowledgeTool }
          : {}),
      });
      return {
        serverName,
        spec,
        readAudit: () => readKnowledgeAudit(auditPath),
      };
    },
    // 对话回放本与在飞标记（T8.2b）：直接绑 storage 的 sessions/ 函数
    appendTranscript: appendTranscriptEntry,
    readRecentTranscript: async (projectLayout, sessionId, tail) =>
      (await readTranscript(projectLayout, sessionId, { tail })).entries,
    writeInflightMarker,
    deleteInflightMarker: async (projectLayout, turnId) => {
      await deleteInflightMarker(projectLayout, turnId);
    },
    writeInflightPartial,
    now: () => Date.now(),
    newRunId: () => randomUUID() as RunId,
    newLocalSessionId: () => randomUUID() as LocalSessionId,
  });

  const repairer = createProjectRepairer(
    createRepairDeps((turnId) => orchestrator.hasActiveTurn(turnId)),
  );

  /** 首次为某项目服务前先修正残留（幂等；修正失败只记日志，不挡正常请求）。 */
  async function touchProject(projectRoot: string): Promise<ProjectLayout> {
    const projectLayout = resolveProjectLayout(projectRoot);
    await repairer.ensureRepaired(projectLayout);
    return projectLayout;
  }

  const handlers: Pick<InvokeHandlers, SessionChannel> = {
    "session:start": async (request) => {
      await touchProject(request.projectRoot);
      return orchestrator.start(request);
    },
    "session:respond-permission": (request) => orchestrator.respondPermission(request),
    "session:cancel": (request) => orchestrator.cancel(request),
    "sessions:latest": async (request) => {
      const projectLayout = await touchProject(request.projectRoot);
      // listSessions 已按 lastActiveAt 降序，首项即最近
      const [latest] = await createSessionStore(projectLayout.sessionsFile).listSessions();
      return latest ?? null;
    },
    "sessions:transcript": async (request) => {
      const projectLayout = await touchProject(request.projectRoot);
      const limit =
        request.limit !== undefined && Number.isFinite(request.limit) && request.limit >= 0
          ? Math.floor(request.limit)
          : DEFAULT_TRANSCRIPT_LIMIT;
      return readTranscript(projectLayout, request.sessionId, { tail: limit });
    },
    // T8.3a：在飞轮次快照（纯内存态，不触碰磁盘，故不走 touchProject——
    // 没有磁盘现场需要修正，也不该让一个只读内存的查询去扫 inflight/ 目录）
    "sessions:active-turns": async (request) => orchestrator.listActiveTurns(request.projectRoot),
  };

  return {
    handlers,
    orchestrator,
    registry,
    repairer,
    async repairRegisteredProjects() {
      let entries: Awaited<ReturnType<typeof projects.listProjects>>;
      try {
        entries = await projects.listProjects();
      } catch (thrown) {
        console.warn(`[repair] project registry unreadable: ${String(thrown)}`);
        return;
      }
      for (const entry of entries) {
        // ensureRepaired 自身吞掉单项目失败并记日志；这里串行扫，避免同时打开几十个目录
        await repairer.ensureRepaired(resolveProjectLayout(entry.rootPath));
      }
    },
  };
}
