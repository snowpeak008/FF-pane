/**
 * 工作台 CLI 启动 IPC（T10.4 / T10.4' / T10.5'）。
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeLaunchRolePrompt,
  createWindowTokenRegistry,
  type WindowTokenRegistry,
} from "@ff-pane/core";
import {
  clampMaxWorkbenchWindows,
  DEFAULT_CONFIG_TOOL_SERVER_NAME,
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  isWorkbenchRoleManualId,
  type ProjectId,
  type Provider,
  setActivePage,
  type WorkbenchWindow,
} from "@ff-pane/shared";
import {
  createConfigStore,
  createProjectConfigStore,
  createProjectRegistry,
  createProjectSettingsStore,
  createProviderStore,
  createWorkbenchLayoutStore,
  initGlobalLayout,
  listHabits,
  resolveGlobalLayout,
  resolveProjectLayout,
} from "@ff-pane/storage";
import { app, type BrowserWindow, shell } from "electron";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { publishEvent } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { generateProjectImage } from "../image-gen/generate";
import { createMemoryIndexService, type MemoryIndexService } from "../memory-index";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import { type ConfigDraftHub, createConfigDraftHub } from "../session/config-draft-hub";
import {
  CONFIG_MAILBOX_ROOT_NAME,
  createConfigMailbox,
  resolveConfigMcpServer,
} from "../session/config-tool";
import { WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX } from "../terminal/handlers";
import type { PtyManager } from "../terminal/manager";
import { API_ERROR_SAME_TURN_MS, createApiErrorTracker } from "./api-error-tracker";
import { createWorkbenchAuthRegistry, type WorkbenchAuthRegistry } from "./auth-registry";
import {
  describeCanvasRevision,
  editCanvasBoard,
  loadCanvasBoard,
  placeImageOnBoard,
  readCanvasImageBytes,
  removeFromCanvasBoard,
  updateCanvasAnnotations,
  writeCanvasMarkedPreview,
} from "./canvas-files";
import {
  exportCanvasImage,
  listCanvasTrash,
  markCanvasRejected,
  purgeCanvasTrash,
  requestCanvasDelete,
  resolveCanvasDeleteRequest,
  restoreCanvasTrash,
  trashCanvasImage,
} from "./canvas-library";
import { ensureCanvasWatcher } from "./canvas-watcher";
import { closeDescendantWindow } from "./close-descendant";
import { CodexSessionClaimer, isAutomatedTestEnv, resolveCodexHome } from "./codex-claim";
import { switchCodexModelInWindow } from "./codex-model-switch";
import {
  type CodexRolloutTail,
  codexRolloutPathFor,
  tailCodexRollout,
} from "./codex-rollout-watch";
import { createWorkbenchConfigDraftActions } from "./config-draft-apply";
import { isConfigToolAuthorized, shouldAttachConfigTool } from "./config-tool-attach";
import {
  createWorkbenchControlServer,
  WORKBENCH_TOOL_MAX_REQUEST_BYTES,
  type WorkbenchControlRequestContext,
} from "./control-channel";
import { grokHookSessionMatches } from "./grok-hook-config";
import { releaseWindowHooks } from "./hook-launch";
import {
  createIdleDeliverQueue,
  type IdleDeliverHold,
  type IdleDeliverQueue,
  type SubmitResult,
} from "./idle-deliver";
import { createInboxCursorStore, inboxCursorPath } from "./inbox-cursor";
import {
  assertLaunchCliIpcSafe,
  type LaunchCliWindowResult,
  launchCliWindow,
  WorkbenchMcpTempRegistry,
} from "./launch-cli";
import { decideManagerGrantRestore } from "./manager-grant";
import { cleanupStaleWorkbenchMcpDirs } from "./mcp-temp";
import {
  executeWorkbenchTool,
  hasInboxHook,
  type ModelEffortApplyResult,
  type RemindDelivery,
  takeInboxDigest,
  type WindowModelInfo,
  type WorkbenchToolDeps,
} from "./mcp-tools";
import {
  canSetModelEffort,
  createModelEffortController,
  type ModelEffortApplyMode,
  type ModelEffortController,
  modelEffortApplyMode,
  parseModelEffortArgs,
  withModelEffortOverrides,
} from "./model-effort";
import { createNamedLocks, type LockGrant } from "./named-locks";
import { createOnlineHub } from "./online-hub";
import { openChildWindow } from "./open-child";
import { clampReadOutputBytes, renderTerminalText, takeUtf8Tail } from "./output-text";
import {
  assertOpenableMarkdown,
  listBriefFiles,
  PANEL_INDEX_PAGE_LIMIT,
  pageNewestFirst,
  readBriefFile,
  readPanelThreadIndex,
  resolveFfPaneFile,
} from "./panel-files";
import { addCallerProjectMemory, searchCallerProjectMemory } from "./project-memory";
import {
  createPromptWatch,
  inputHasText,
  type PromptRuntime,
  inputStillHolds as readInputStillHolds,
} from "./prompt-ready";
import {
  buildCoalescedReminder,
  buildNewMessageReminder,
  sanitizeReminderTitle,
  sanitizeThreadText,
} from "./remind";
import { resolveProjectLaunchRoute } from "./resolve-config";
import { describeShortage, resourceLimitsFromConfig, takeResourceSnapshot } from "./resource-guard";
import {
  planResume as planResumeLaunch,
  type ResumeHandoffReason,
  resumeHandoffText,
} from "./resume-handoff";
import {
  composeWindowRolePrompt,
  listRoleManuals,
  RolePromptTempRegistry,
  resetRoleManualOverride,
  resolveRoleSwitchManualPath,
  saveRoleManualOverride,
  writeClaudeRolePromptFile,
} from "./role-manuals";
import {
  resolveWorkbenchRoleOverridesDir,
  resolveWorkbenchRoleResourcesDir,
} from "./role-resources";
import { setWindowRole } from "./set-role";
import { createTeamDigest, digestRelativePath } from "./team-digest";
import {
  appendThreadRecord,
  readThreadIndex,
  readThreadIndexTail,
  recordsAddressedTo,
  summarizeInboxBadges,
  type ThreadRecord,
  teamFileSlug,
  USER_PARTY_ID,
} from "./thread-store";

export interface WorkbenchCliLayer {
  readonly handlers: Pick<
    InvokeHandlers,
    | "workbench:launch-cli"
    | "workbench:set-role"
    | "workbench:set-permission"
    | "workbench:deliver-now"
    | "workbench:deliver-cancel"
    | "workbench:model-effort-settled"
    | "workbench:model-effort-confirm"
    | "workbench:list-role-manuals"
    | "workbench:save-role-manual"
    | "workbench:reset-role-manual"
    | "workbench:inbox-badges"
    | "workbench:runtime-status"
    | "workbench:list-decisions"
    | "workbench:set-online"
    | "workbench:answer-decision"
    | "workbench:list-briefs"
    | "workbench:read-brief"
    | "workbench:read-threads"
    | "workbench:open-ffpane"
    | "workbench:panel-activity"
    | "workbench:get-canvas"
    | "workbench:canvas-edit"
    | "workbench:save-canvas-marked"
    | "workbench:read-canvas-image"
    | "workbench:remove-canvas-image"
    | "workbench:respond-config-draft"
  >;
  readonly mcpRegistry: WorkbenchMcpTempRegistry;
  readonly codexClaimer: CodexSessionClaimer;
  readonly tokenRegistry: WindowTokenRegistry;
  readonly authRegistry: WorkbenchAuthRegistry;
  readonly idleQueue: IdleDeliverQueue;
  readonly modelEffort: ModelEffortController;
  readonly rolePromptTemps: RolePromptTempRegistry;
  readonly releaseConfigHub: (windowId: string) => Promise<void>;
  /** 终端退出（自然退出或被关闭）：放锁；自然退出时告诉监管者或上级。 */
  readonly noteWindowExit: (
    windowId: string,
    exit: { readonly exitCode: number; readonly killed: boolean },
  ) => void;
  readonly dispose: () => Promise<void>;
}

export interface WorkbenchCliLayerOptions {
  readonly manager: PtyManager;
  readonly getWindow: () => BrowserWindow | null;
  readonly getMaxWorkbenchWindows?: () => number | Promise<number>;
  /** 与 data 层共享的权威权限表；缺省则本层自建。 */
  readonly authRegistry?: WorkbenchAuthRegistry;
  /**
   * 与记忆页共用的索引服务。缺省时本层自建一份，检索仍能从 Markdown 对账，
   * 但已打开的另一份连接不会立刻看到新条目。
   */
  readonly memoryIndex?: MemoryIndexService;
}

function mainModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * 装配 workbench:launch-cli；按项目配置读来源与密钥。本机登录不注入密钥。
 */
export async function createWorkbenchCliLayer(
  options: WorkbenchCliLayerOptions,
): Promise<WorkbenchCliLayer> {
  await cleanupStaleWorkbenchMcpDirs();

  const layout = await initGlobalLayout(resolveGlobalRoot());
  const projectConfigs = createProjectConfigStore(layout.configsFile);
  const providers = createProviderStore(layout.providersFile);
  const config = createConfigStore(layout.configFile);
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  const mcpRegistry = new WorkbenchMcpTempRegistry();
  const rolePromptTemps = new RolePromptTempRegistry();
  const configHubs = new Map<string, ConfigDraftHub>();
  const projects = createProjectRegistry(layout.projectsFile);

  const listBoundProjects = async (
    configId: string,
  ): Promise<readonly { readonly id: string; readonly name: string }[]> => {
    const registered = await projects.listProjects();
    const bound: { id: string; name: string }[] = [];
    for (const project of registered) {
      const settings = await createProjectSettingsStore(
        resolveProjectLayout(project.rootPath).projectFile,
      ).readSettings();
      if (settings.configId === configId) {
        bound.push({ id: project.id, name: project.name });
      }
    }
    return bound;
  };

  const configDraftActions = createWorkbenchConfigDraftActions({
    providers,
    projectConfigs,
    storeSecret: (plaintext) => secrets.storeSecret(plaintext),
    listBoundProjects,
  });

  const disposeConfigHub = async (windowId: string): Promise<void> => {
    const hub = configHubs.get(windowId);
    if (hub === undefined) {
      return;
    }
    configHubs.delete(windowId);
    await hub.dispose();
  };
  const codexClaimer = new CodexSessionClaimer();
  const tokenRegistry = createWindowTokenRegistry();
  const authRegistry = options.authRegistry ?? createWorkbenchAuthRegistry();
  const ownsMemoryIndex = options.memoryIndex === undefined;
  const memoryIndex =
    options.memoryIndex ??
    createMemoryIndexService({
      listProviders: () => providers.listProviders(),
      revealSecret: (ref) => secrets.revealSecret(ref),
      log: (message) => console.log(message),
    });
  const layouts = createWorkbenchLayoutStore(layout.workbenchLayoutsFile);
  const resourcesDir = resolveWorkbenchRoleResourcesDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const overridesDir = resolveWorkbenchRoleOverridesDir(layout.rootDir);
  const getMax =
    options.getMaxWorkbenchWindows ?? (async () => (await config.readConfig()).maxWorkbenchWindows);

  const publishRoleNotice = (notice: {
    readonly windowId: string;
    readonly delivery: "dropped";
    readonly reason?: string;
  }): void => {
    const window = options.getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    publishEvent(window.webContents, "workbench:role-notice", notice);
  };

  const findLiveTerminalId = (windowId: string): string | undefined => {
    for (const record of options.manager.list()) {
      if (record.exited) {
        continue;
      }
      if (record.metadata?.["windowId"] === windowId) {
        return record.id;
      }
    }
    return undefined;
  };

  const publishDeliverPending = (notice: {
    readonly windowId: string;
    readonly count: number;
    readonly mode: "manual" | "blocked" | "busy" | "draft" | "clear";
  }): void => {
    const window = options.getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    publishEvent(window.webContents, "workbench:deliver-pending", notice);
  };

  const locks = createNamedLocks();
  /** 平台主动报告的状态，发给监管者（有的话）或上级。只发固定文案，不带终端正文。 */
  /** 在线监管：窗口循环调用 ffpane_wait_events 时，提醒和新消息交给等待调用，不走终端。 */
  // 掉线判定：等待返回后 5 分钟没再来等就算掉线。只有自动化测试能用环境变量改短。
  const testGraceMs = isAutomatedTestEnv()
    ? Number(process.env["FF_PANE_ONLINE_GRACE_MS"] ?? "")
    : Number.NaN;
  const onlineHub = createOnlineHub({
    now: () => Date.now(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    },
    ...(Number.isFinite(testGraceMs) && testGraceMs > 0 ? { graceMs: testGraceMs } : {}),
  });
  const publishOnline = (windowId: string): void => {
    const browser = options.getWindow();
    if (browser === null || browser.isDestroyed()) {
      return;
    }
    publishEvent(browser.webContents, "workbench:online-changed", {
      windowId,
      online: onlineHub.isOnline(windowId),
    });
  };
  /** 给窗口一行平台提醒：在线就交给等待调用，否则打进终端。 */
  /** 排着队的提醒告诉发信方的说法。 */
  const queuedDelivery = (mode: IdleDeliverHold): RemindDelivery =>
    mode === "manual"
      ? "queued-manual"
      : mode === "blocked"
        ? "queued-blocked"
        : mode === "draft"
          ? "queued-draft"
          : "queued-busy";
  const deliverLine = (
    windowId: string,
    text: string,
    extra?: {
      readonly allowUnknown?: boolean;
      readonly onSubmit?: (result: SubmitResult) => void;
    },
  ): RemindDelivery => {
    if (onlineHub.offer(windowId, text)) {
      return "online";
    }
    const terminalId = findLiveTerminalId(windowId);
    if (terminalId === undefined) {
      return "not-running";
    }
    const queued = idleQueue.enqueue({
      terminalId,
      text,
      tag: windowId,
      ...(extra?.allowUnknown === true ? { allowUnknown: true } : {}),
      ...(extra?.onSubmit !== undefined ? { onSubmit: extra.onSubmit } : {}),
    });
    if (queued.status === "dropped") {
      return "failed";
    }
    if (queued.status === "delivered") {
      return "delivered";
    }
    return queuedDelivery(queued.mode);
  };
  /**
   * 当场打进去的提醒等核对完再返回：提交了才算送达，没提交（补按一次回车也不行）直接报失败。
   * 核对最长约 10 秒（Codex 回车延迟 0.8 秒 + 核对 4 秒 + 补回车后再核对 4 秒）。
   */
  const SUBMIT_WAIT_MAX_MS = 20_000;
  const awaitSubmit = async (
    delivery: RemindDelivery,
    submitted: Promise<SubmitResult>,
  ): Promise<RemindDelivery> => {
    if (delivery !== "delivered") {
      return delivery;
    }
    const result = await Promise.race([
      submitted,
      new Promise<undefined>((done) => {
        setTimeout(() => done(undefined), SUBMIT_WAIT_MAX_MS).unref?.();
      }),
    ]);
    if (result === "not-submitted") {
      return "not-submitted";
    }
    return result === "dropped" ? "failed" : "delivered";
  };
  const deliverLineAndWait = (
    windowId: string,
    text: string,
    extra?: { readonly allowUnknown?: boolean },
  ): Promise<RemindDelivery> => {
    let settle: (result: SubmitResult) => void = () => undefined;
    const submitted = new Promise<SubmitResult>((done) => {
      settle = done;
    });
    return awaitSubmit(deliverLine(windowId, text, { ...extra, onSubmit: settle }), submitted);
  };
  /**
   * 汇报和状态的去向（用户 2026-10-22 定的规则）：监管者在线就交给监管者；监管者掉线或暂停就交给上级；
   * 上级也暂停（限流）或不在，就记进上级的「待处理」，不打进任何终端，等用户叫醒它。
   */
  const teamDigest = createTeamDigest({ now: () => Date.now() });
  /** 能不能把事交给这个窗口：终端在跑、没因错误暂停；当监管者用时还要在线（在等事件）。 */
  const canReceive = (windowId: string, asSupervisor: boolean): boolean =>
    findLiveTerminalId(windowId) !== undefined &&
    !apiErrors.isPaused(windowId) &&
    (!asSupervisor || onlineHub.isOnline(windowId));
  const findStoredWindow = async (
    windowId: string,
  ): Promise<
    { window: import("@ff-pane/shared").WorkbenchWindow; projectRoot: string } | undefined
  > => {
    for (const current of Object.values(await layouts.readAll())) {
      const window = current.windows[windowId];
      if (window !== undefined) {
        const project = (await projects.listProjects()).find((p) => p.id === current.projectId);
        return { window, projectRoot: project?.rootPath ?? window.cwd };
      }
    }
    return undefined;
  };
  /** 上级收不了：记进它的待处理。 */
  const holdForManager = async (
    managerId: string,
    aboutWindowId: string,
    text: string,
  ): Promise<void> => {
    const about = await findStoredWindow(aboutWindowId);
    const manager = await findStoredWindow(managerId);
    if (manager === undefined) {
      return;
    }
    await teamDigest.note({
      managerId,
      projectRoot: manager.projectRoot,
      windowId: aboutWindowId,
      title: about?.window.title ?? aboutWindowId,
      text,
    });
  };
  const notifyOverseer = async (
    windowId: string,
    what: string,
    routeOptions?: { readonly skipSupervisor?: boolean },
  ): Promise<void> => {
    const stored = await findStoredWindow(windowId);
    if (stored === undefined) {
      return;
    }
    const found = stored.window;
    const parentId = authRegistry.get(windowId)?.parentWindowId ?? found.parentWindowId;
    const watcherId =
      found.watcherWindowId !== undefined && found.watcherWindowId !== windowId
        ? found.watcherWindowId
        : undefined;
    const line = `[状态] ${sanitizeReminderTitle(found.title)}（${windowId}）${what}`;
    if (
      watcherId !== undefined &&
      routeOptions?.skipSupervisor !== true &&
      canReceive(watcherId, true)
    ) {
      deliverLine(watcherId, line);
      return;
    }
    if (parentId === undefined || parentId === windowId) {
      return;
    }
    if (canReceive(parentId, false)) {
      const note =
        watcherId !== undefined && routeOptions?.skipSupervisor !== true
          ? `（它的监管者不在线，改交给你；可以用 ffpane_nudge 叫醒监管者）`
          : "";
      deliverLine(parentId, `${line}${note}`);
      return;
    }
    // 上级也停了：不打进终端，记进待处理，等用户叫醒它。
    await holdForManager(parentId, windowId, what);
  };
  /** 每个窗口最近一次因「空闲没汇报」提醒过的依据，同一依据只提醒一次。 */
  const idleNoticeKey = new Map<string, string>();
  const noteIdleWithoutReport = async (windowId: string): Promise<void> => {
    const node = authRegistry.get(windowId);
    if (node === undefined || node.role === "manager" || node.parentWindowId === undefined) {
      return;
    }
    const terminalId = findLiveTerminalId(windowId);
    const startedAt =
      terminalId !== undefined ? options.manager.get(terminalId)?.createdAt : undefined;
    if (startedAt === undefined) {
      return;
    }
    let projectRoot: string | undefined;
    for (const current of Object.values(await layouts.readAll())) {
      if (current.windows[windowId] !== undefined) {
        projectRoot = (await projects.listProjects()).find(
          (p) => p.id === current.projectId,
        )?.rootPath;
        break;
      }
    }
    if (projectRoot === undefined) {
      return;
    }
    const records = await readThreadIndex(projectRoot);
    const lastIn = records.filter((r) => r.to.windowId === windowId && r.kind === "message").at(-1);
    const since = lastIn?.ts ?? new Date(startedAt).toISOString();
    const reported = records.some(
      (r) => r.from.windowId === windowId && r.kind === "report" && r.ts >= since,
    );
    const key = lastIn?.id ?? `launch-${startedAt}`;
    if (reported || idleNoticeKey.get(windowId) === key) {
      return;
    }
    idleNoticeKey.set(windowId, key);
    await notifyOverseer(
      windowId,
      "已经空闲，但这一轮没有汇报。可以用 ffpane_read_output 看它停在哪里，再决定要不要发消息。",
    );
  };
  const apiErrors = createApiErrorTracker({
    now: () => Date.now(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    },
    isAlive: (windowId) => findLiveTerminalId(windowId) !== undefined,
    notify: (windowId, text) => {
      void notifyOverseer(windowId, text);
      checkTeams();
    },
    // 网络或服务端的临时故障：平台自己让它接着做，不用谁思考。
    autoContinue: (windowId, label) => {
      void deliverLineAndWait(
        windowId,
        `[继续] 上一轮因${label}中断，平台自动让你接着做。从停下的地方接着做；做不了就用 ffpane_report blocked 说明原因。`,
        { allowUnknown: true },
      );
    },
  });
  /**
   * 显示在忙、终端却长时间一点输出都没有：CLI 干活时加载动画每秒都在刷新（实测间隔不到 0.5 秒），
   * 这种安静多半是卡住，或 Codex 这类没有出错信号的 CLI 因 API 错误停了。每段安静只报一次。
   */
  const STALL_NOTICE_MS = 120_000;
  const stallNoticeKey = new Map<string, number>();
  const checkStalls = (): void => {
    const now = Date.now();
    for (const record of options.manager.list()) {
      const windowId = record.metadata?.["windowId"];
      if (record.exited || typeof windowId !== "string") {
        continue;
      }
      if (
        idleQueue.phaseOf(record.id) !== "busy" ||
        now - record.lastOutputAt < STALL_NOTICE_MS ||
        onlineHub.isWaiting(windowId)
      ) {
        continue;
      }
      if (stallNoticeKey.get(windowId) === record.lastOutputAt) {
        continue;
      }
      stallNoticeKey.set(windowId, record.lastOutputAt);
      const minutes = Math.floor((now - record.lastOutputAt) / 60_000);
      void notifyOverseer(
        windowId,
        `显示在忙，但终端已经 ${minutes} 分钟没有任何输出，可能卡住或因 API 错误停了。可以用 ffpane_read_output 看看。`,
      );
    }
  };
  /** 已经离线、还存着没交出去的提醒：监管者的交给上级；别的打回终端。都不丢。 */
  const drainOffline = (): void => {
    for (const backlog of onlineHub.drainOffline()) {
      publishOnline(backlog.windowId);
      if (authRegistry.get(backlog.windowId)?.role === "supervisor") {
        // 监管者掉线了：它没处理的提醒交给它的上级（上级也停了就进待处理）。新消息留在它的收件箱里。
        for (const text of backlog.events) {
          void notifyOverseer(backlog.windowId, `掉线前还有一条没处理的提醒：${text}`);
        }
        continue;
      }
      const terminalId = findLiveTerminalId(backlog.windowId);
      if (terminalId === undefined) {
        continue;
      }
      for (const text of backlog.events) {
        idleQueue.enqueue({ terminalId, text, tag: backlog.windowId });
      }
      if (backlog.inbox) {
        idleQueue.enqueueInbox(terminalId, (count) => buildCoalescedReminder(count));
      }
    }
  };
  /** 平台叫停的监管者（管理者暂停、执行也都停了），以及用户点了下线的：掉线不算异常。 */
  const stopRequested = new Set<string>();
  const supervisorWasOnline = new Map<string, boolean>();
  /** 监管者从在线变成掉线（超过 5 分钟没来等事件）：告诉它的上级，路线改走上级。 */
  const checkSupervisors = (): void => {
    for (const record of options.manager.list()) {
      const windowId = record.metadata?.["windowId"];
      if (record.exited || typeof windowId !== "string") {
        continue;
      }
      if (authRegistry.get(windowId)?.role !== "supervisor") {
        continue;
      }
      const online = onlineHub.isOnline(windowId);
      const before = supervisorWasOnline.get(windowId);
      supervisorWasOnline.set(windowId, online);
      if (online) {
        stopRequested.delete(windowId);
        continue;
      }
      if (before === true && !stopRequested.has(windowId)) {
        const reason = apiErrors.get(windowId)?.label;
        void notifyOverseer(
          windowId,
          `掉线了：超过 5 分钟没在等事件${reason !== undefined ? `（${reason}）` : "（可能出错，或这一轮结束了）"}。它名下窗口的提醒和汇报改交给你；需要的话用 ffpane_nudge 叫醒它。`,
        );
      }
    }
  };
  /** 团队暂停状态：管理者停了（限流或不在）且没有在线的监管者时，在管理者窗口上盖一层提示。 */
  const teamPaused = new Map<string, string>();
  const publishTeamPaused = (managerId: string, reason: string | undefined): void => {
    if ((teamPaused.get(managerId) ?? "") === (reason ?? "")) {
      return;
    }
    if (reason === undefined) {
      teamPaused.delete(managerId);
    } else {
      teamPaused.set(managerId, reason);
    }
    const browser = options.getWindow();
    if (browser !== null && !browser.isDestroyed()) {
      publishEvent(browser.webContents, "workbench:team-paused", {
        windowId: managerId,
        paused: reason !== undefined,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  };
  /**
   * 管理者暂停时：还有执行在干活，监管者就继续在线收汇报；都停了，监管者也下线。
   * 管理者和监管者都不在线，团队就停下，等用户叫醒管理者。
   */
  const checkTeams = (): void => {
    const tree = authRegistry.snapshot();
    for (const [managerId, node] of Object.entries(tree)) {
      if (node.role !== "manager") {
        continue;
      }
      const team = Object.keys(tree).filter((id) => {
        let cursor = tree[id]?.parentWindowId;
        for (let depth = 0; cursor !== undefined && depth < 16; depth += 1) {
          if (cursor === managerId) {
            return true;
          }
          cursor = tree[cursor]?.parentWindowId;
        }
        return false;
      });
      if (team.length === 0) {
        publishTeamPaused(managerId, undefined);
        continue;
      }
      const managerTerminal = findLiveTerminalId(managerId);
      const managerError = apiErrors.get(managerId);
      const managerDown = managerTerminal === undefined || managerError?.paused === true;
      if (!managerDown) {
        publishTeamPaused(managerId, undefined);
        continue;
      }
      const working = team.some((id) => {
        if (tree[id]?.role === "supervisor") {
          return false;
        }
        const terminalId = findLiveTerminalId(id);
        if (terminalId === undefined || apiErrors.isPaused(id)) {
          return false;
        }
        const phase = idleQueue.phaseOf(terminalId);
        return phase === "busy" || phase === "blocked";
      });
      const supervisors = team.filter((id) => tree[id]?.role === "supervisor");
      if (!working) {
        for (const supervisorId of supervisors) {
          if (onlineHub.isOnline(supervisorId)) {
            stopRequested.add(supervisorId);
            onlineHub.requestStop(supervisorId);
            publishOnline(supervisorId);
          }
        }
      }
      if (supervisors.some((id) => onlineHub.isOnline(id))) {
        publishTeamPaused(managerId, undefined);
        continue;
      }
      publishTeamPaused(
        managerId,
        managerTerminal === undefined
          ? "管理者窗口没在运行"
          : `管理者因${managerError?.label ?? "错误"}停下`,
      );
    }
  };
  const stallTimer = setInterval(() => {
    checkStalls();
    drainOffline();
    checkSupervisors();
    checkTeams();
  }, 30_000);
  stallTimer.unref?.();
  const PERMISSION_WAIT_NOTICE_MS = 90_000;
  const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearPermissionTimer = (windowId: string): void => {
    const timer = permissionTimers.get(windowId);
    if (timer !== undefined) {
      clearTimeout(timer);
      permissionTimers.delete(windowId);
    }
  };
  const notePermissionWait = (windowId: string): void => {
    if (permissionTimers.has(windowId)) {
      return;
    }
    permissionTimers.set(
      windowId,
      setTimeout(() => {
        permissionTimers.delete(windowId);
        const terminalId = findLiveTerminalId(windowId);
        if (terminalId !== undefined && idleQueue.phaseOf(terminalId) === "blocked") {
          void notifyOverseer(
            windowId,
            "在等用户批准，已经等了一分半钟。请用户到那个窗口处理，或考虑用 ffpane_set_permission 调整权限。",
          );
        }
      }, PERMISSION_WAIT_NOTICE_MS),
    );
  };
  const notifyLockGranted = (grant: LockGrant): void => {
    deliverLine(
      grant.windowId,
      `[锁] 轮到你了，你已拿到锁 ${grant.name}，可以开始用。用完调用 ffpane_lock release。`,
    );
  };
  const noteWindowExit = (
    windowId: string,
    exit: { readonly exitCode: number; readonly killed: boolean },
  ): void => {
    clearPermissionTimer(windowId);
    apiErrors.forget(windowId);
    supervisorWasOnline.delete(windowId);
    stopRequested.delete(windowId);
    if (exit.killed) {
      // 被关掉的窗口：在上级待处理里的那一行不用再管。
      const parentId = authRegistry.get(windowId)?.parentWindowId;
      if (parentId !== undefined) {
        void teamDigest.clear(parentId, windowId);
      }
    }
    onlineHub.forget(windowId);
    stopCodexTail(windowId);
    for (const grant of locks.releaseWindow(windowId)) {
      notifyLockGranted(grant);
    }
    // 关窗、重启是本软件结束的，不打扰；自己退出的（崩溃、限流中断或 /exit）才报。
    if (!exit.killed) {
      void notifyOverseer(
        windowId,
        `的终端自己退出了（退出码 ${exit.exitCode}）。它持有的锁已放掉。需要的话请用户在那个窗口重启或续接。`,
      );
    }
  };

  /** 提醒还在排队时的发信方，按目标终端记。 */
  const pendingSenders = new Map<string, Set<string>>();
  /** 提醒已经打出、还在核对是否提交的发信方。 */
  const inflightSenders = new Map<string, Set<string>>();
  const DROP_REASON_TEXT: Readonly<Record<string, string>> = {
    exited: "对方终端已退出",
    "write-failed": "写入对方终端失败",
    "not-submitted": "文字打进了输入框，但对方没有提交",
  };
  const noteSenderOutcome = (outcome: {
    readonly terminalId: string;
    readonly status: "delivered" | "dropped";
    readonly reason?: string;
  }): void => {
    const { terminalId } = outcome;
    if (outcome.status === "delivered") {
      const pending = pendingSenders.get(terminalId);
      pendingSenders.delete(terminalId);
      if (pending !== undefined) {
        inflightSenders.set(terminalId, pending);
      }
      return;
    }
    const senders = new Set<string>([
      ...(pendingSenders.get(terminalId) ?? []),
      ...(outcome.reason === "not-submitted" ? (inflightSenders.get(terminalId) ?? []) : []),
    ]);
    pendingSenders.delete(terminalId);
    inflightSenders.delete(terminalId);
    if (outcome.reason === "cancelled" || senders.size === 0) {
      return;
    }
    const reasonText = DROP_REASON_TEXT[outcome.reason ?? ""] ?? "没能送达";
    const targetWindowId = options.manager.get(terminalId)?.metadata?.["windowId"];
    void (async () => {
      let title = "对方窗口";
      if (typeof targetWindowId === "string") {
        for (const current of Object.values(await layouts.readAll())) {
          const found = current.windows[targetWindowId];
          if (found !== undefined) {
            title = sanitizeReminderTitle(found.title);
            break;
          }
        }
      }
      const text = `[投递失败] 给 ${title} 的提醒没能送到（${reasonText}）。消息还在它的收件箱里；可以稍后再发，或请用户在那个窗口点立即发送。`;
      for (const senderId of senders) {
        const senderTerminal = findLiveTerminalId(senderId);
        if (senderTerminal !== undefined && senderTerminal !== terminalId) {
          deliverLine(senderId, text);
        }
      }
    })();
  };

  const idleQueue = createIdleDeliverQueue({
    isIdle: (terminalId, quietMs) => options.manager.isIdle(terminalId, quietMs),
    isAlive: (terminalId) => {
      const record = options.manager.get(terminalId);
      return record !== undefined && record.exited !== true;
    },
    write: (terminalId, data) => {
      options.manager.write(terminalId, data);
    },
    lastOutputAt: (terminalId) => options.manager.get(terminalId)?.lastOutputAt,
    inputStillHolds: async (terminalId, text) => {
      const runtime = promptRuntimeOf(options.manager.get(terminalId)?.metadata);
      if (runtime === undefined) {
        return undefined;
      }
      const screen = await renderTail(terminalId);
      return screen === undefined ? undefined : readInputStillHolds(screen, runtime, text);
    },
    readDraft: (terminalId) => readDraft(terminalId),
    now: () => Date.now(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    onDeferred: (outcome) => {
      noteSenderOutcome(outcome);
      if (outcome.tag === undefined || outcome.status !== "dropped") {
        return;
      }
      if (outcome.reason === "cancelled") {
        return;
      }
      publishRoleNotice({
        windowId: outcome.tag,
        delivery: "dropped",
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
    },
    onPending: (notice) => {
      if (notice.windowId === undefined) {
        return;
      }
      publishDeliverPending({
        windowId: notice.windowId,
        count: notice.count,
        mode: notice.mode,
      });
    },
  });

  let afterIdleHook = (_windowId: string): void => undefined;

  let onTool: (
    context: WorkbenchControlRequestContext,
  ) =>
    | { readonly ok: true; readonly result?: unknown }
    | { readonly ok: false; readonly error: string }
    | Promise<
        | { readonly ok: true; readonly result?: unknown }
        | { readonly ok: false; readonly error: string }
      > = () => ({ ok: false, error: "unsupported" });
  const handleHookSignal = (
    windowId: string,
    signal: import("./idle-deliver").HookSignal,
    meta?: {
      readonly toolUseId?: string;
      readonly toolDigest?: string;
      readonly sessionId?: string;
      readonly releasePermissions?: boolean;
      readonly errorType?: string;
    },
  ): void => {
    const terminalId = findLiveTerminalId(windowId);
    if (terminalId !== undefined) {
      const metadata = options.manager.get(terminalId)?.metadata;
      if (metadata?.["kind"] === "codex") {
        // Codex 的 notify 只装在这个进程上、凭本窗口令牌回报，报来的编号就是本窗口的会话。
        if (meta?.sessionId !== undefined) {
          noteCodexThread(windowId, meta.sessionId);
        }
      } else {
        // Grok 的钩子写在项目配置里，同项目的其他 Grok 会话也会触发，所以要核对会话编号。
        const storedSession = metadata?.["nativeSessionId"];
        const expectedSession = typeof storedSession === "string" ? storedSession : undefined;
        if (!grokHookSessionMatches(expectedSession, meta?.sessionId)) {
          return;
        }
      }
      if (signal === "user-prompt-submit") {
        idleQueue.noteTurnStarted(terminalId);
      }
      idleQueue.noteHook(terminalId, signal, {
        ...(meta?.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
        ...(meta?.toolDigest !== undefined ? { toolDigest: meta.toolDigest } : {}),
        ...(meta?.releasePermissions === true ? { releasePermissions: true } : {}),
      });
    }
    if (signal === "permission-request") {
      notePermissionWait(windowId);
    } else if (signal === "stop" || signal === "user-prompt-submit") {
      clearPermissionTimer(windowId);
    }
    if (signal === "user-prompt-submit") {
      // 又开始干活了（被叫醒或用户接手）：不再算暂停，也不再自动接着做。
      apiErrors.turnStarted(windowId);
    }
    if (signal === "stop" && meta?.errorType !== undefined) {
      apiErrors.note(windowId, meta.errorType);
    } else if (signal === "stop") {
      // 同一轮的正常结束信号可能比出错信号先到（Codex 的 notify 立刻到，rollout 里的错误稍后读到）。
      // 等一下再判断：这期间出了错，就只报错误，不清记录，也不报「空闲没汇报」。
      setTimeout(() => {
        if (apiErrors.turnCompleted(windowId)) {
          void noteIdleWithoutReport(windowId).catch(() => undefined);
          // 暂停期间攒下的事：醒来后一句话告诉它去看待处理，不逐条打进来。
          if (teamDigest.takeAnnouncement(windowId)) {
            deliverLine(
              windowId,
              `[待处理] 你暂停期间团队里有 ${teamDigest.count(windowId)} 个窗口有事，见 ${teamDigest.relativePath(windowId)}。先读这一页，要细节再看对应的汇报；你给哪个窗口发过消息、叫醒或关掉它，那一行会自动划掉。`,
            );
          }
          checkTeams();
        }
      }, API_ERROR_SAME_TURN_MS);
    }
    if (signal === "user-prompt-submit") {
      checkTeams();
    }
    if (signal === "stop" || signal === "user-prompt-submit") {
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:conversation-touch", {
          windowId,
          at: Date.now(),
        });
      }
    }
    afterIdleHook(windowId);
  };

  /** Codex 窗口的 rollout 读取：一轮开始（确认提交）、出错结束。 */
  const codexTails = new Map<string, CodexRolloutTail>();
  const stopCodexTail = (windowId: string): void => {
    codexTails.get(windowId)?.stop();
    codexTails.delete(windowId);
    codexSessionOf.delete(windowId);
  };
  /** 每个 Codex 窗口当前对话的编号。 */
  const codexSessionOf = new Map<string, string>();
  const publishCodexSession = (windowId: string, nativeSessionId: string): void => {
    const browser = options.getWindow();
    if (browser === null || browser.isDestroyed()) {
      return;
    }
    publishEvent(browser.webContents, "workbench:session-claimed", { windowId, nativeSessionId });
  };
  /** Codex 报来编号：还在等认领就交给认领；已认领但变了（在 Codex 里开了新对话）就换过去。 */
  const noteCodexThread = (windowId: string, threadId: string): void => {
    if (codexClaimer.noteThreadId(windowId, threadId)) {
      return;
    }
    if (codexSessionOf.get(windowId) === threadId) {
      return;
    }
    startCodexTail(windowId, threadId);
    publishCodexSession(windowId, threadId);
  };
  const startCodexTail = (windowId: string, sessionId: string): void => {
    stopCodexTail(windowId);
    codexSessionOf.set(windowId, sessionId);
    const terminalId = findLiveTerminalId(windowId);
    if (terminalId === undefined) {
      return;
    }
    // 只按编号拼出这一个会话自己的文件，不列目录、不碰别的会话。
    const file = codexRolloutPathFor(join(resolveCodexHome(), "sessions"), sessionId);
    if (file === undefined) {
      console.error(`[wb-codex] rollout not found for session ${sessionId}`);
      return;
    }
    idleQueue.setTurnStartSource(terminalId, true);
    const tail = tailCodexRollout(file, (event) => {
      const live = findLiveTerminalId(windowId);
      if (live === undefined) {
        return;
      }
      if (event.kind === "turn-started") {
        handleHookSignal(windowId, "user-prompt-submit");
        return;
      }
      if (event.kind === "turn-aborted") {
        // 用户按 Esc 打断：notify 不报，不清掉就一直显示忙。只清状态，不当成「空闲没汇报」。
        idleQueue.noteHook(live, "stop");
        afterIdleHook(windowId);
        return;
      }
      if (event.errorType !== undefined) {
        handleHookSignal(windowId, "stop", { errorType: event.errorType });
        return;
      }
      // 正常结束一般已由 notify 报过；notify 没到（比如没装上）才由这里补。
      setTimeout(() => {
        const still = findLiveTerminalId(windowId);
        if (still !== undefined && idleQueue.phaseOf(still) === "busy") {
          handleHookSignal(windowId, "stop");
        }
      }, API_ERROR_SAME_TURN_MS);
    });
    codexTails.set(windowId, tail);
  };

  /** 终端对应哪种 CLI 屏幕。Grok 的屏幕没核对过，不看。 */
  const promptRuntimeOf = (
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): PromptRuntime | undefined => {
    const kind = metadata?.["kind"];
    if (kind === "claude" || kind === "deepseek") {
      return "claude-code";
    }
    return kind === "codex" ? "codex" : undefined;
  };
  /**
   * 看屏幕只要最后一段：输入框和状态行每帧都重画，开头的横幅由 observe 缓存。
   * 按屏幕上的行读（keepRows），折行不拼回去，否则认不出 Claude 的输入框。
   */
  const SCREEN_TAIL_BYTES = 256 * 1024;
  const renderTail = async (terminalId: string, solidOnly = false): Promise<string | undefined> => {
    const record = options.manager.get(terminalId);
    if (record === undefined || record.exited) {
      return undefined;
    }
    try {
      return await renderTerminalText(
        takeUtf8Tail(options.manager.getReplayBuffer(terminalId), SCREEN_TAIL_BYTES),
        { cols: record.cols, rows: record.rows },
        60,
        { solidOnly, keepRows: true },
      );
    } catch {
      return undefined;
    }
  };
  /** 输入框里有没有用户打的字（只看正常颜色的字，提示文字和光标格不算）。看不出返回 undefined。 */
  const readDraft = async (terminalId: string): Promise<boolean | undefined> => {
    const runtime = promptRuntimeOf(options.manager.get(terminalId)?.metadata);
    if (runtime === undefined) {
      return undefined;
    }
    const screen = await renderTail(terminalId, true);
    return screen === undefined ? undefined : inputHasText(screen, runtime);
  };
  /** 重启过的窗口看到输入提示符就判为空闲；被 Esc 打断、一直显示忙的也清掉。 */
  const promptWatch = createPromptWatch({
    targets: () => {
      const out = [];
      for (const record of options.manager.list()) {
        const windowId = record.metadata?.["windowId"];
        const runtime = promptRuntimeOf(record.metadata);
        if (record.exited || typeof windowId !== "string" || runtime === undefined) {
          continue;
        }
        out.push({ terminalId: record.id, windowId, runtime, lastOutputAt: record.lastOutputAt });
      }
      return out;
    },
    phaseOf: (terminalId) => idleQueue.phaseOf(terminalId),
    render: (terminalId) => renderTail(terminalId),
    notePromptReady: (terminalId, opts) => idleQueue.notePromptReady(terminalId, opts),
    onReady: (windowId) => {
      afterIdleHook(windowId);
    },
    now: () => Date.now(),
  });
  const promptTimer = setInterval(() => {
    void promptWatch.tick().catch(() => undefined);
  }, 1000);
  promptTimer.unref?.();

  const control = await createWorkbenchControlServer({
    tokens: tokenRegistry,
    maxRequestBytes: WORKBENCH_TOOL_MAX_REQUEST_BYTES,
    onRequest: (context) => onTool(context),
    onHook: (windowId, signal, meta) => {
      handleHookSignal(windowId, signal, meta);
    },
    log: (message) => {
      console.error(`[wb-control] ${message}`);
    },
  });

  const cursors = createInboxCursorStore(inboxCursorPath(layout.rootDir));

  /** 应用这次运行里启动过的窗口。没启动过又要续接的，是重开项目后用户点了「续接」。 */
  const launchedThisRun = new Set<string>();
  const planResume = (input: Parameters<typeof planResumeLaunch>[0]) =>
    planResumeLaunch(input, { codexHome: resolveCodexHome() });
  /** 续接上之后补发一句交接：角色、未读、待处理。普通窗口不发。 */
  const sendResumeHandoff = async (input: {
    readonly reason: ResumeHandoffReason;
    readonly windowId: string;
    readonly projectRoot: string;
    readonly window: WorkbenchWindow;
    readonly windows: Readonly<Record<string, WorkbenchWindow>>;
  }): Promise<void> => {
    const role = authRegistry.get(input.windowId)?.role ?? input.window.role;
    if (role === undefined || role === "none") {
      return;
    }
    try {
      const records = await readThreadIndex(input.projectRoot);
      const cursor = await cursors.get(input.windowId);
      const unread = recordsAddressedTo(records, input.windowId, cursor).length;
      const digestPath = digestRelativePath(input.windowId);
      const hasDigest = role === "manager" && existsSync(join(input.projectRoot, digestPath));
      const parentId =
        authRegistry.get(input.windowId)?.parentWindowId ?? input.window.parentWindowId;
      const openerTitle = parentId !== undefined ? input.windows[parentId]?.title : undefined;
      deliverLine(
        input.windowId,
        resumeHandoffText({
          reason: input.reason,
          title: input.window.title,
          role,
          unread,
          ...(openerTitle !== undefined ? { openerTitle } : {}),
          ...(hasDigest ? { digestPath } : {}),
        }),
      );
    } catch (error) {
      console.error(`[wb-resume] handoff for ${input.windowId} failed: ${String(error)}`);
    }
  };
  const roleDeps = () => ({
    authRegistry,
    readLayouts: () => layouts.readAll(),
    saveLayout: (next: import("@ff-pane/shared").ProjectWorkbenchLayout) =>
      layouts.saveProject(next),
    findLiveTerminalId,
    idleQueue,
    manualPath: (role: import("@ff-pane/shared").WorkbenchRole) =>
      resolveRoleSwitchManualPath(resourcesDir, overridesDir, role),
  });
  const publishManagerGrant = (projectId: string, windowId: string, pending: boolean): void => {
    const browser = options.getWindow();
    if (browser === null || browser.isDestroyed()) {
      return;
    }
    publishEvent(browser.webContents, "workbench:manager-grant", {
      projectId: projectId as ProjectId,
      windowId,
      managerGrantPending: pending,
    });
  };
  const setManagerPending = async (windowId: string, pending: boolean): Promise<void> => {
    const all = await layouts.readAll();
    for (const current of Object.values(all)) {
      const window = current.windows[windowId];
      if (window === undefined) {
        continue;
      }
      const nextWindow = pending
        ? { ...window, managerGrantPending: true as const }
        : (() => {
            const { managerGrantPending: _flag, ...rest } = window;
            void _flag;
            return rest;
          })();
      await layouts.saveProject({
        ...current,
        windows: { ...current.windows, [windowId]: nextWindow },
      });
      publishManagerGrant(current.projectId, windowId, pending);
      return;
    }
  };
  const reconcileManagerGrant = async (windowId: string): Promise<void> => {
    const node = authRegistry.get(windowId);
    if (node === undefined) {
      return;
    }
    const parentId = node.parentWindowId;
    const parent = parentId !== undefined ? authRegistry.get(parentId) : undefined;
    const action = decideManagerGrantRestore({
      role: node.role,
      openedBy: node.openedBy,
      ...(parentId !== undefined ? { parentWindowId: parentId } : {}),
      ...(parent?.role !== undefined ? { parentRole: parent.role } : {}),
      parentGranted: parentId !== undefined && authRegistry.isManagerGranted(parentId),
      alreadyGranted: authRegistry.isManagerGranted(windowId),
      sanitizeLocked: node.sanitizeLocked === true,
      userRoleSet: node.userRoleSet === true,
    });
    if (action === "user-reauth") {
      await setWindowRole({ kind: "user" }, windowId, "manager", roleDeps(), { deliver: false });
      await setManagerPending(windowId, false);
      return;
    }
    if (action === "inherit") {
      authRegistry.grantManager(windowId);
      await setManagerPending(windowId, false);
      return;
    }
    if (action === "pending") {
      authRegistry.clearManagerGrant(windowId);
      await setManagerPending(windowId, true);
      return;
    }
    if (action === "already") {
      await setManagerPending(windowId, false);
    }
  };
  const launchDeps = () => ({
    manager: options.manager,
    getProvider: async (id: string) => {
      const provider = await providers.getProvider(id as never);
      return provider as Provider | undefined;
    },
    revealSecret: async (ref: string) => {
      try {
        return await secrets.revealSecret(ref as never);
      } catch {
        return undefined;
      }
    },
    getMaxWorkbenchWindows: getMax,
    isKnowledgeToolEnabled: async (projectRoot: string) => {
      try {
        const projectLayout = resolveProjectLayout(projectRoot);
        const settings = await createProjectSettingsStore(projectLayout.projectFile).readSettings();
        return settings.knowledgeToolEnabled === true;
      } catch {
        return false;
      }
    },
    isConfigToolEnabled: async (projectRoot: string) => {
      try {
        const settings = await createProjectSettingsStore(
          resolveProjectLayout(projectRoot).projectFile,
        ).readSettings();
        return settings.configToolEnabled === true;
      } catch {
        return false;
      }
    },
    getKnowledgeToolSettings: async () => {
      const globalConfig = await config.readConfig();
      return globalConfig.knowledgeTool;
    },
    indexDbFile: resolveGlobalLayout(resolveGlobalRoot()).indexDbFile,
    moduleDir: join(mainModuleDir()),
    mcpRegistry,
    tokenRegistry,
    authRegistry,
    loadRoleInjection: async ({
      windowId,
      role,
      runtime,
    }: {
      readonly windowId: string;
      readonly role: import("@ff-pane/shared").WorkbenchRole;
      readonly runtime: "claude-code" | "codex" | "grok";
    }) => {
      const roleText = await composeWindowRolePrompt(resourcesDir, overridesDir, role);
      let outputLanguage: string | undefined;
      try {
        outputLanguage = (await config.readConfig()).aiOutputLanguage;
      } catch {
        outputLanguage = undefined;
      }
      let habits: Awaited<ReturnType<typeof listHabits>>["entries"] = [];
      try {
        habits = (await listHabits(layout)).entries;
      } catch {
        habits = [];
      }
      const text = composeLaunchRolePrompt({
        rolePrompt: roleText,
        ...(outputLanguage !== undefined ? { outputLanguage } : {}),
        habits,
      });
      if (runtime === "claude-code") {
        const filePath = writeClaudeRolePromptFile(windowId, text);
        rolePromptTemps.track(windowId, filePath);
        return { claudePromptFile: filePath };
      }
      if (runtime === "grok") {
        return { grokRules: text };
      }
      return { developerInstructions: text };
    },
    resolveConfigTool: async ({
      windowId,
      projectRoot,
      role,
    }: {
      readonly windowId: string;
      readonly projectRoot: string;
      readonly role: import("@ff-pane/shared").WorkbenchRole;
    }) => {
      let enabled = false;
      try {
        const settings = await createProjectSettingsStore(
          resolveProjectLayout(projectRoot).projectFile,
        ).readSettings();
        enabled = settings.configToolEnabled === true;
      } catch {
        enabled = false;
      }
      const node = authRegistry.get(windowId);
      const parentId = node?.parentWindowId;
      const parent = parentId !== undefined ? authRegistry.get(parentId) : undefined;
      const grant =
        node === undefined
          ? "none"
          : decideManagerGrantRestore({
              role: node.role ?? role,
              openedBy: node.openedBy,
              ...(parentId !== undefined && parentId.trim() !== ""
                ? { parentWindowId: parentId }
                : {}),
              ...(parent?.role !== undefined ? { parentRole: parent.role } : {}),
              parentGranted: parentId !== undefined && authRegistry.isManagerGranted(parentId),
              alreadyGranted: authRegistry.isManagerGranted(windowId),
              sanitizeLocked: node.sanitizeLocked === true,
              userRoleSet: node.userRoleSet === true,
            });
      if (
        !shouldAttachConfigTool({
          role,
          configToolEnabled: enabled,
          managerAuthorized: isConfigToolAuthorized(grant),
        })
      ) {
        await disposeConfigHub(windowId);
        return {};
      }
      await disposeConfigHub(windowId);
      const mailbox = await createConfigMailbox(join(layout.rootDir, CONFIG_MAILBOX_ROOT_NAME));
      const hub = createConfigDraftHub({
        turnId: windowId,
        requestsDir: mailbox.requestsDir,
        responsesDir: mailbox.responsesDir,
        auditPath: mailbox.auditPath,
        publish: (event) => {
          const browser = options.getWindow();
          if (browser === null || browser.isDestroyed()) {
            return;
          }
          if (event.kind === "config-draft") {
            publishEvent(browser.webContents, "workbench:config-draft", {
              windowId: event.turnId,
              draftId: event.draftId,
              summary: event.summary,
              needsApiKey: event.needsApiKey,
              payload: event.payload,
            });
            return;
          }
          if (event.kind === "config-draft-resolved") {
            publishEvent(browser.webContents, "workbench:config-draft-resolved", {
              windowId: event.turnId,
              draftId: event.draftId,
            });
          }
        },
        prepare: configDraftActions.prepare,
        apply: configDraftActions.apply,
        now: () => Date.now(),
      });
      hub.start();
      configHubs.set(windowId, hub);
      const spec = resolveConfigMcpServer({
        moduleDir: join(mainModuleDir()),
        mailbox,
        providersFile: layout.providersFile,
        configsFile: layout.configsFile,
      });
      return { [DEFAULT_CONFIG_TOOL_SERVER_NAME]: spec };
    },
    clampMax: clampMaxWorkbenchWindows,
    limitErrorPrefix: WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX,
    codexClaimer,
    controlPipe: control.address,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    ...(process.env["LOCALAPPDATA"] !== undefined
      ? { localAppData: process.env["LOCALAPPDATA"] }
      : {}),
    idleQueue,
    onCodexSessionClaimed: (windowId: string, nativeSessionId: string) => {
      startCodexTail(windowId, nativeSessionId);
      publishCodexSession(windowId, nativeSessionId);
    },
    onCodexSessionUnidentified: (windowId: string) => {
      const window = options.getWindow();
      if (window === null || window.isDestroyed()) {
        return;
      }
      publishEvent(window.webContents, "workbench:session-unidentified", { windowId });
    },
    onWindowLaunched: (windowId: string) =>
      reconcileManagerGrant(windowId).catch((error: unknown) => {
        console.error(`[wb-grant] ${String(error)}`);
      }),
  });

  const modelEffortView = new Map<
    string,
    {
      readonly modelOverride?: string;
      readonly effortOverride?: string;
      readonly permission?: import("@ff-pane/shared").WorkbenchPermissionLevel;
    }
  >();

  const publishModelEffort = (notice: {
    readonly windowId: string;
    readonly action: "resume" | "confirm" | "pending" | "clear";
    readonly reason: "busy" | "confirm" | "not-running" | "no-session" | "failed";
    readonly error?: string;
  }): void => {
    if (notice.action === "resume" && !modelEffortRuns.has(notice.windowId)) {
      // 由主进程自己重启，不靠界面：窗口不在当前标签页时界面收不到这条事件。
      void runModelEffort(notice.windowId);
    }
    const browser = options.getWindow();
    if (browser === null || browser.isDestroyed()) {
      return;
    }
    const extra = modelEffortView.get(notice.windowId);
    publishEvent(browser.webContents, "workbench:model-effort", {
      windowId: notice.windowId,
      action: notice.action,
      reason: notice.reason,
      ...(notice.error !== undefined && notice.error !== "" ? { error: notice.error } : {}),
      ...(extra?.modelOverride !== undefined ? { modelOverride: extra.modelOverride } : {}),
      ...(extra?.effortOverride !== undefined ? { effortOverride: extra.effortOverride } : {}),
      ...(extra?.permission !== undefined ? { permission: extra.permission } : {}),
    });
  };

  const modelEffort = createModelEffortController({ onChange: publishModelEffort });

  const modelEffortFacts = async (windowId: string) => {
    const all = await layouts.readAll();
    let stored: (typeof all)[string]["windows"][string] | undefined;
    for (const layout of Object.values(all)) {
      const window = layout.windows[windowId];
      if (window !== undefined) {
        stored = window;
        break;
      }
    }
    const node = authRegistry.get(windowId);
    const terminalId = findLiveTerminalId(windowId);
    const record = terminalId !== undefined ? options.manager.get(terminalId) : undefined;
    const fromMeta = record?.metadata?.["nativeSessionId"];
    const sessionId =
      typeof fromMeta === "string" && fromMeta.trim() !== "" ? fromMeta : stored?.nativeSessionId;
    const role =
      node?.role ?? (isWorkbenchRole(stored?.role) ? stored.role : DEFAULT_WORKBENCH_ROLE);
    const permission =
      node?.permission ??
      (isWorkbenchPermissionLevel(stored?.permission)
        ? stored.permission
        : DEFAULT_WORKBENCH_WINDOW_PERMISSION);
    const kind = record?.metadata?.["kind"] ?? stored?.kind;
    // Codex 的编号由 notify 报来，界面不在当前标签页时布局里可能还没记上，以主进程记的为准。
    const codexSession = kind === "codex" ? codexSessionOf.get(windowId) : undefined;
    const resumeId = codexSession ?? sessionId;
    const hadConversation =
      terminalId !== undefined &&
      (record?.metadata?.["resumed"] === true ||
        record?.metadata?.["initialPrompt"] === true ||
        idleQueue.hadTurn(terminalId));
    return {
      running: terminalId !== undefined,
      phase: terminalId !== undefined ? idleQueue.phaseOf(terminalId) : ("unknown" as const),
      canResume: terminalId !== undefined && resumeId !== undefined && resumeId.trim() !== "",
      needsConfirm: role === "manager" || permission === "yolo",
      hadConversation,
      // 改权限只能靠重启；/model 只换模型和强度。
      canSwitchInWindow: kind === "codex" && !permissionChangePending.has(windowId),
      ...(resumeId !== undefined && resumeId.trim() !== "" ? { sessionId: resumeId } : {}),
      kind: typeof kind === "string" ? kind : undefined,
      permission,
      title: stored?.title ?? windowId,
      stored,
    };
  };

  /** 改了权限、还没重启生效的窗口：不能用 /model 代替重启。 */
  const permissionChangePending = new Set<string>();
  type ModelEffortRunOutcome =
    | {
        readonly ok: true;
        readonly how: ModelEffortApplyMode;
        readonly model?: string;
        readonly reasoningEffort?: string;
        readonly source: WindowModelInfo["source"];
      }
    | { readonly ok: false; readonly error: string };
  /** 正在让新设置生效的那一次。 */
  const modelEffortRuns = new Map<string, Promise<ModelEffortRunOutcome>>();
  /** 有工具调用在等结果的那几次：完成时由工具调用自己回报，不再发提醒。 */
  const awaitedRuns = new WeakSet<Promise<ModelEffortRunOutcome>>();
  /** 谁要求改的模型：排队后生效或失败时告诉它。 */
  const modelEffortRequester = new Map<string, string>();
  const MODEL_EFFORT_AWAIT_MS = 60_000;
  const sleep = (ms: number): Promise<void> =>
    new Promise((done) => {
      setTimeout(done, ms);
    });

  /** Codex 没带参数时读的是用户 config.toml 顶层的 model 和 model_reasoning_effort。只读不改。 */
  const readCodexDefaults = async (): Promise<{ model?: string; effort?: string }> => {
    try {
      const text = await readFile(join(resolveCodexHome(), "config.toml"), "utf8");
      const top = text.split(/^\s*\[/m)[0] ?? "";
      const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
      const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1];
      return {
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      };
    } catch {
      return {};
    }
  };

  /** 窗口现在用的模型和强度：屏幕上显示的优先，其次本次启动参数，再次 CLI 用户配置。 */
  const describeModel = async (windowId: string): Promise<WindowModelInfo | undefined> => {
    let stored: import("@ff-pane/shared").WorkbenchWindow | undefined;
    for (const current of Object.values(await layouts.readAll())) {
      stored = current.windows[windowId];
      if (stored !== undefined) {
        break;
      }
    }
    const terminalId = findLiveTerminalId(windowId);
    const record = terminalId !== undefined ? options.manager.get(terminalId) : undefined;
    if (record === undefined || terminalId === undefined) {
      if (stored === undefined) {
        return undefined;
      }
      const model = stored.modelOverride ?? stored.routeModel;
      const effort = stored.effortOverride ?? stored.routeEffort;
      return {
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        source: model !== undefined || effort !== undefined ? "launch" : "unknown",
      };
    }
    const launchModel = record.metadata?.["launchModel"];
    const launchEffort = record.metadata?.["launchEffort"];
    const runtime = promptRuntimeOf(record.metadata);
    const seen = runtime !== undefined ? await promptWatch.observe(terminalId, runtime) : undefined;
    const defaults =
      record.metadata?.["kind"] === "codex" ? await readCodexDefaults() : ({} as const);
    const fromLaunchModel = typeof launchModel === "string" ? launchModel : undefined;
    const fromLaunchEffort = typeof launchEffort === "string" ? launchEffort : undefined;
    const model = seen?.model ?? fromLaunchModel ?? defaults.model;
    const effort = seen?.effort ?? fromLaunchEffort ?? defaults.effort;
    const source: WindowModelInfo["source"] =
      seen?.model !== undefined
        ? "screen"
        : fromLaunchModel !== undefined || fromLaunchEffort !== undefined
          ? "launch"
          : defaults.model !== undefined || defaults.effort !== undefined
            ? "config"
            : "unknown";
    const pendingModel =
      stored?.modelOverride !== undefined && stored.modelOverride !== fromLaunchModel
        ? stored.modelOverride
        : undefined;
    const pendingEffort =
      stored?.effortOverride !== undefined && stored.effortOverride !== fromLaunchEffort
        ? stored.effortOverride
        : undefined;
    // 在窗口里切换过的，屏幕上已经是新值，不算没生效。
    const switched =
      seen?.model !== undefined &&
      (pendingModel === undefined || seen.model.toLowerCase() === pendingModel.toLowerCase()) &&
      (pendingEffort === undefined || seen.effort === pendingEffort);
    return {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      source,
      ...(!switched && pendingModel !== undefined ? { pendingModel } : {}),
      ...(!switched && pendingEffort !== undefined
        ? { pendingReasoningEffort: pendingEffort }
        : {}),
    };
  };

  /** 重启后等它停在输入框上，再读屏幕上的模型和强度。等不到就用启动参数。 */
  const settleActualModel = async (
    windowId: string,
    launched: LaunchCliWindowResult | undefined,
  ): Promise<{
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly source: WindowModelInfo["source"];
  }> => {
    const deadline = Date.now() + 20_000;
    const terminalId = launched?.terminal.id ?? findLiveTerminalId(windowId);
    const runtime =
      terminalId !== undefined
        ? promptRuntimeOf(options.manager.get(terminalId)?.metadata)
        : undefined;
    while (terminalId !== undefined && runtime !== undefined && Date.now() < deadline) {
      const seen = await promptWatch.observe(terminalId, runtime);
      if (seen?.ready === true && seen.model !== undefined) {
        return {
          model: seen.model,
          ...(seen.effort !== undefined ? { reasoningEffort: seen.effort } : {}),
          source: "screen",
        };
      }
      await sleep(500);
    }
    const info = await describeModel(windowId);
    return {
      ...(info?.model !== undefined ? { model: info.model } : {}),
      ...(info?.reasoningEffort !== undefined ? { reasoningEffort: info.reasoningEffort } : {}),
      source: info?.source ?? "unknown",
    };
  };

  /**
   * 主进程自己重启窗口（不靠窗口在当前标签页）：结束旧终端，按布局里记的设置重新启动，
   * 再告诉界面改接新终端。resume 时必须有对话编号。
   */
  const relaunchWindow = async (
    windowId: string,
    plan: { readonly resume: boolean; readonly nativeSessionId?: string },
  ): Promise<
    | { readonly ok: true; readonly result: LaunchCliWindowResult }
    | { readonly ok: false; readonly error: string }
  > => {
    const all = await layouts.readAll();
    let stored: import("@ff-pane/shared").WorkbenchWindow | undefined;
    for (const current of Object.values(all)) {
      stored = current.windows[windowId];
      if (stored !== undefined) {
        break;
      }
    }
    if (stored === undefined) {
      return { ok: false, error: "找不到这个窗口。" };
    }
    const kind = stored.kind;
    if (kind !== "claude" && kind !== "codex" && kind !== "grok" && kind !== "deepseek") {
      return { ok: false, error: "只能重启 AI 窗口。" };
    }
    if (plan.resume && (plan.nativeSessionId === undefined || plan.nativeSessionId.trim() === "")) {
      return { ok: false, error: "没有对话编号，没法续接。" };
    }
    const project = (await projects.listProjects()).find((item) => item.id === stored.projectId);
    if (project === undefined) {
      return { ok: false, error: "找不到窗口所属的项目。" };
    }
    const resolved = await resolveProjectLaunchRoute({
      projectRoot: project.rootPath,
      projectId: stored.projectId,
      kind,
      configs: projectConfigs,
      getProvider: async (id) => {
        const provider = await providers.getProvider(id as never);
        return provider === undefined ? undefined : { id: provider.id, name: provider.name };
      },
    });
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const node = authRegistry.get(windowId);
    const permission =
      node?.permission ??
      (isWorkbenchPermissionLevel(stored.permission)
        ? stored.permission
        : DEFAULT_WORKBENCH_WINDOW_PERMISSION);
    const role =
      node?.role ?? (isWorkbenchRole(stored.role) ? stored.role : DEFAULT_WORKBENCH_ROLE);
    const oldId = findLiveTerminalId(windowId);
    const oldRecord = oldId !== undefined ? options.manager.get(oldId) : undefined;
    const announce = (active: boolean): void => {
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:terminal-relaunching", { windowId, active });
      }
    };
    // 先告诉界面在重启，免得用户在旧终端结束、新终端还没接上时点重启，开出第二个进程。
    announce(true);
    if (oldId !== undefined) {
      options.manager.kill(oldId);
      // 等旧进程和它的临时文件清理完（角色说明临时文件按窗口固定命名），再起新的。
      await sleep(500);
    }
    let result: LaunchCliWindowResult;
    try {
      result = await launchCliWindow(
        {
          windowId,
          projectId: stored.projectId,
          projectRoot: project.rootPath,
          kind,
          route: withModelEffortOverrides(resolved.route, stored),
          cols: oldRecord?.cols ?? 120,
          rows: oldRecord?.rows ?? 32,
          ...(stored.cwd.trim() !== "" ? { cwd: stored.cwd } : {}),
          ...(plan.resume ? { resume: true } : {}),
          ...(plan.resume && plan.nativeSessionId !== undefined
            ? { nativeSessionId: plan.nativeSessionId }
            : {}),
          permission,
          role,
          ...(stored.compactPercent !== undefined ? { compactPercent: stored.compactPercent } : {}),
        },
        launchDeps(),
      );
    } catch (thrown) {
      announce(false);
      return { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    if (
      result.kind === "codex" &&
      result.claimingSession !== true &&
      result.nativeSessionId !== undefined
    ) {
      startCodexTail(windowId, result.nativeSessionId);
    }
    const browser = options.getWindow();
    if (browser !== null && !browser.isDestroyed()) {
      publishEvent(browser.webContents, "workbench:terminal-replaced", {
        projectId: stored.projectId,
        windowId,
        terminalId: result.terminal.id,
        ...(result.nativeSessionId !== undefined
          ? { nativeSessionId: result.nativeSessionId }
          : {}),
        route: {
          connectionMode: result.connectionMode,
          ...(result.providerName !== undefined ? { providerName: result.providerName } : {}),
          ...(result.model !== undefined ? { model: result.model } : {}),
          ...(result.reasoningEffort !== undefined
            ? { reasoningEffort: result.reasoningEffort }
            : {}),
        },
        effectivePermission: result.effectivePermission,
        permissionCapped: result.permissionCapped,
        turnSignal: result.turnSignal,
        resumed: plan.resume,
      });
    }
    return { ok: true, result };
  };

  /** 在 Codex 窗口里用 /model 只改本会话。期间暂停自动投递。 */
  const switchInWindow = async (
    windowId: string,
    target: { readonly model?: string; readonly effort?: string },
  ): Promise<ModelEffortRunOutcome> => {
    const terminalId = findLiveTerminalId(windowId);
    if (terminalId === undefined) {
      return { ok: false, error: "窗口已经不在运行。" };
    }
    idleQueue.setPaused(terminalId, true);
    try {
      const switched = await switchCodexModelInWindow(
        {
          write: (data) => {
            options.manager.write(terminalId, data);
          },
          screen: async () => (await renderTail(terminalId)) ?? "",
          sleep,
          now: () => Date.now(),
        },
        target,
      );
      if (!switched.ok) {
        return switched;
      }
      return {
        ok: true,
        how: "in-window",
        model: switched.model,
        reasoningEffort: switched.effort,
        source: "screen",
      };
    } finally {
      idleQueue.setPaused(terminalId, false);
    }
  };

  const runModelEffort = (windowId: string): Promise<ModelEffortRunOutcome> => {
    const run = (async (): Promise<ModelEffortRunOutcome> => {
      const generationBeforeRead = modelEffort.generation(windowId);
      const facts = await modelEffortFacts(windowId);
      modelEffort.noteLaunchRead(windowId, generationBeforeRead);
      if (!facts.running) {
        return { ok: false, error: "窗口已经不在运行。" };
      }
      const mode = modelEffortApplyMode(facts);
      if (mode === undefined) {
        return { ok: false, error: "没有可续接的对话编号，也没法在窗口里切换。" };
      }
      if (mode === "in-window") {
        return switchInWindow(windowId, {
          ...(facts.stored?.modelOverride !== undefined
            ? { model: facts.stored.modelOverride }
            : {}),
          ...(facts.stored?.effortOverride !== undefined
            ? { effort: facts.stored.effortOverride }
            : {}),
        });
      }
      const relaunched = await relaunchWindow(windowId, {
        resume: mode === "resume",
        ...(mode === "resume" && facts.sessionId !== undefined
          ? { nativeSessionId: facts.sessionId }
          : {}),
      });
      if (!relaunched.ok) {
        return relaunched;
      }
      permissionChangePending.delete(windowId);
      const actual = await settleActualModel(windowId, relaunched.result);
      return { ok: true, how: mode, ...actual };
    })().catch(
      (thrown: unknown): ModelEffortRunOutcome => ({
        ok: false,
        error: thrown instanceof Error ? thrown.message : String(thrown),
      }),
    );
    modelEffortRuns.set(windowId, run);
    void run.then(async (outcome) => {
      if (modelEffortRuns.get(windowId) === run) {
        modelEffortRuns.delete(windowId);
      }
      modelEffort.settled(windowId, outcome.ok, outcome.ok ? undefined : outcome.error);
      const requester = modelEffortRequester.get(windowId);
      if (awaitedRuns.has(run) || requester === undefined || requester === windowId) {
        return;
      }
      const facts = await modelEffortFacts(windowId).catch(() => undefined);
      const title = sanitizeReminderTitle(facts?.title ?? windowId);
      deliverLine(
        requester,
        outcome.ok
          ? `[模型] ${title}（${windowId}）的新设置已生效：模型 ${outcome.model ?? "不知道"}，思考强度 ${outcome.reasoningEffort ?? "不知道"}（${outcome.how === "in-window" ? "在窗口里切换" : outcome.how === "resume" ? "续接" : "冷重启"}）。`
          : `[模型] ${title}（${windowId}）的新设置没能生效：${sanitizeThreadText(outcome.error.replace(/[\r\n]+/g, " ")).slice(0, 200)}。已记下，下次启动时生效。`,
      );
    });
    return run;
  };

  /** 把一次生效的结果换成工具返回。等太久就当排队中，完成后再发提醒。 */
  const awaitModelEffortRun = async (
    windowId: string,
    readOnly: boolean,
  ): Promise<ModelEffortApplyResult | undefined> => {
    const run = modelEffortRuns.get(windowId);
    if (run === undefined) {
      return undefined;
    }
    awaitedRuns.add(run);
    const outcome = await Promise.race([run, sleep(MODEL_EFFORT_AWAIT_MS).then(() => undefined)]);
    if (outcome === undefined) {
      awaitedRuns.delete(run);
      return {
        status: "queued",
        message: "排队中：正在重启，还没完成；完成后平台会发「[模型]」提醒。",
      };
    }
    if (!outcome.ok) {
      return {
        status: "recorded",
        message: `仅记录：这次没能生效（${outcome.error}）。下次启动时生效${readOnly ? "；它是只读窗口，可以用 ffpane_restart_window 重启" : "；需要现在生效请用户在那个窗口重启"}。`,
      };
    }
    return {
      status: "applied",
      message: "已生效",
      how: outcome.how,
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.reasoningEffort !== undefined
        ? { reasoningEffort: outcome.reasoningEffort }
        : {}),
      source: outcome.source,
    };
  };

  afterIdleHook = (windowId) => {
    void modelEffortFacts(windowId).then((facts) => {
      modelEffort.onPossibleIdle(windowId, facts);
    });
  };

  const handlers: WorkbenchCliLayer["handlers"] = {
    "workbench:launch-cli": async (request) => {
      assertLaunchCliIpcSafe(request);
      const permission =
        request.permission !== undefined && isWorkbenchPermissionLevel(request.permission)
          ? request.permission
          : undefined;
      const kind =
        request.kind === "codex"
          ? "codex"
          : request.kind === "claude"
            ? "claude"
            : request.kind === "grok"
              ? "grok"
              : request.kind === "deepseek"
                ? "deepseek"
                : undefined;
      if (kind === undefined) {
        throw new Error("kind must be claude, codex, grok, or deepseek");
      }
      const resolved = await resolveProjectLaunchRoute({
        projectRoot: request.projectRoot,
        projectId: request.projectId,
        kind,
        configs: projectConfigs,
        getProvider: async (id) => {
          const provider = await providers.getProvider(id as never);
          return provider === undefined ? undefined : { id: provider.id, name: provider.name };
        },
      });
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const generationBeforeRead = modelEffort.generation(request.windowId);
      const projectLayout = (await layouts.readAll())[request.projectId];
      const storedWindow = projectLayout?.windows[request.windowId];
      modelEffort.noteLaunchRead(request.windowId, generationBeforeRead);
      const route = withModelEffortOverrides(resolved.route, storedWindow);
      const resumePlan = await planResume({
        kind,
        resume: request.resume === true,
        firstLaunchThisRun: !launchedThisRun.has(request.windowId),
        ...(request.nativeSessionId !== undefined
          ? { nativeSessionId: request.nativeSessionId }
          : {}),
        conversations: storedWindow?.conversations,
      });
      launchedThisRun.add(request.windowId);
      const result = await launchCliWindow(
        {
          windowId: request.windowId,
          projectId: request.projectId,
          projectRoot: request.projectRoot,
          kind,
          route,
          cols: request.cols,
          rows: request.rows,
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          ...(request.initialPrompt !== undefined ? { initialPrompt: request.initialPrompt } : {}),
          ...(resumePlan.resume ? { resume: true } : {}),
          ...(resumePlan.nativeSessionId !== undefined
            ? { nativeSessionId: resumePlan.nativeSessionId }
            : {}),
          ...(permission !== undefined ? { permission } : {}),
          ...(isWorkbenchRole(request.role) ? { role: request.role } : {}),
          ...(storedWindow?.compactPercent !== undefined
            ? { compactPercent: storedWindow.compactPercent }
            : {}),
        },
        launchDeps(),
      );
      if (
        result.kind === "codex" &&
        result.claimingSession !== true &&
        result.nativeSessionId !== undefined
      ) {
        startCodexTail(request.windowId, result.nativeSessionId);
      }
      if (resumePlan.handoff !== undefined && storedWindow !== undefined) {
        void sendResumeHandoff({
          reason: resumePlan.handoff,
          windowId: request.windowId,
          projectRoot: request.projectRoot,
          window: storedWindow,
          windows: projectLayout?.windows ?? {},
        });
      }
      return {
        terminal: result.terminal,
        kind: result.kind,
        ...(result.nativeSessionId !== undefined
          ? { nativeSessionId: result.nativeSessionId }
          : {}),
        ...(result.claimingSession === true ? { claimingSession: true } : {}),
        ...(result.resumePicker === true ? { resumePicker: true } : {}),
        configName: result.configName,
        connectionMode: result.connectionMode,
        ...(result.providerName !== undefined ? { providerName: result.providerName } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.reasoningEffort !== undefined
          ? { reasoningEffort: result.reasoningEffort }
          : {}),
        effectivePermission: result.effectivePermission,
        permissionCapped: result.permissionCapped,
        turnSignal: result.turnSignal,
      };
    },
    "workbench:set-role": async (request) => {
      if (!isWorkbenchRole(request.role)) {
        throw new Error("invalid workbench role");
      }
      const result = await setWindowRole(
        { kind: "user" },
        request.windowId,
        request.role,
        roleDeps(),
      );
      if (!result.ok) {
        throw new Error(`set-role ${result.reason}`);
      }
      return { ok: true as const, role: result.role, delivery: result.delivery };
    },
    "workbench:set-permission": (request) => {
      if (!isWorkbenchPermissionLevel(request.permission)) {
        throw new Error("invalid workbench permission");
      }
      const applied = authRegistry.applyUserPermission(request.windowId, request.permission);
      if (!applied) {
        throw new Error("set-permission unknown-window");
      }
      return { ok: true as const, permission: request.permission };
    },
    "workbench:deliver-now": async (request) => {
      const terminalId = findLiveTerminalId(request.windowId);
      if (terminalId === undefined) {
        return { ok: false as const, reason: "unknown-window" as const };
      }
      // 用户点的立即发送：看得出框里有字才拒绝，看不出就照用户的意思发。
      const draft = idleQueue.needsDraftCheck(terminalId)
        ? (await readDraft(terminalId)) === true
        : false;
      const result = idleQueue.deliverNow(terminalId, { draft });
      if (result.status === "refused") {
        return {
          ok: false as const,
          reason: result.reason === "dead" ? ("unknown-window" as const) : result.reason,
        };
      }
      return { ok: true as const, count: result.count };
    },
    "workbench:deliver-cancel": (request) => {
      const terminalId = findLiveTerminalId(request.windowId);
      if (terminalId !== undefined) {
        idleQueue.cancel(terminalId);
      }
      return { ok: true as const };
    },
    "workbench:model-effort-confirm": (request) => {
      modelEffort.confirm(request.windowId, request.accepted);
      return { ok: true as const };
    },
    "workbench:model-effort-settled": (request) => {
      const error = request.error?.trim();
      modelEffort.settled(
        request.windowId,
        request.ok,
        ...(error !== undefined && error !== "" ? [error] : []),
      );
      return { ok: true as const };
    },
    "workbench:list-role-manuals": async () => {
      const manuals = await listRoleManuals(resourcesDir, overridesDir);
      return { manuals };
    },
    "workbench:save-role-manual": async (request) => {
      if (!isWorkbenchRoleManualId(request.id)) {
        throw new Error("unknown role manual");
      }
      await saveRoleManualOverride(overridesDir, request.id, request.content);
      return { ok: true as const };
    },
    "workbench:reset-role-manual": async (request) => {
      if (!isWorkbenchRoleManualId(request.id)) {
        throw new Error("unknown role manual");
      }
      await resetRoleManualOverride(overridesDir, request.id);
      const manuals = await listRoleManuals(resourcesDir, overridesDir);
      const manual = manuals.find((item) => item.id === request.id);
      return { ok: true as const, content: manual?.defaultContent ?? "" };
    },
    "workbench:inbox-badges": async () => {
      const all = await layouts.readAll();
      const listed = await projects.listProjects();
      const badges: Record<
        string,
        {
          readonly unread: number;
          readonly lastReportStatus?: "done" | "blocked" | "failed" | "progress";
        }
      > = {};
      for (const current of Object.values(all)) {
        const project = listed.find((item) => item.id === current.projectId);
        if (project === undefined) {
          continue;
        }
        const records = await readThreadIndexTail(project.rootPath);
        const windowIds = Object.keys(current.windows);
        const cursorOf = new Map<string, string | undefined>();
        for (const windowId of windowIds) {
          cursorOf.set(windowId, await cursors.get(windowId));
        }
        const summary = summarizeInboxBadges(records, windowIds, (windowId) =>
          cursorOf.get(windowId),
        );
        for (const [windowId, badge] of Object.entries(summary)) {
          badges[windowId] = badge;
        }
      }
      return { badges };
    },
    "workbench:runtime-status": async (request) => {
      const root = await projectRootOf(request.projectId);
      const layout = (await layouts.readAll())[request.projectId];
      const windows: Record<
        string,
        import("../../shared-ipc/contracts").WorkbenchWindowRuntimeStatus
      > = {};
      const now = Date.now();
      for (const windowId of Object.keys(layout?.windows ?? {})) {
        const state = toolDeps().windowState(windowId);
        if (state === undefined) {
          continue;
        }
        const held = locks.of(windowId);
        windows[windowId] = {
          phase: state.phase,
          ...(state.lastOutputAt !== undefined
            ? { quietSeconds: Math.max(0, Math.floor((now - state.lastOutputAt) / 1000)) }
            : {}),
          holdingLocks: held.holding,
          waitingLocks: held.waiting,
          ...(state.lastApiError !== undefined ? { lastApiError: state.lastApiError.label } : {}),
          ...(state.memory !== undefined ? { memory: state.memory } : {}),
          online: state.online === true,
        };
      }
      const snapshot = await takeResourceSnapshot(root);
      const limits = resourceLimitsFromConfig(await config.readConfig());
      return {
        windows,
        resources: {
          ...snapshot,
          minFreeMemoryBytes: limits.memory,
          minFreeDiskBytes: limits.disk,
        },
      };
    },
    "workbench:set-online": (request) => {
      if (!request.online) {
        stopRequested.add(request.windowId);
        const wasOnline = onlineHub.requestStop(request.windowId);
        publishOnline(request.windowId);
        return {
          ok: true as const,
          delivered: wasOnline ? ("online" as const) : ("not-online" as const),
        };
      }
      if (onlineHub.isOnline(request.windowId)) {
        return { ok: true as const, delivered: "online" as const };
      }
      const delivery = deliverLine(
        request.windowId,
        "[在线监管] 请进入在线监管：循环调用 ffpane_wait_events，处理完返回的事件和消息就接着等，直到返回 stop。",
      );
      return { ok: true as const, delivered: delivery };
    },
    "workbench:list-decisions": (request) => ({
      decisions: [...decisions.values()]
        .filter((item) => item.projectId === request.projectId)
        .map(({ projectRoot: _root, ...decision }) => {
          void _root;
          return decision;
        }),
    }),
    "workbench:answer-decision": async (request) => {
      const decision = decisions.get(request.id);
      if (decision === undefined) {
        throw new Error("这件事已经处理过了。");
      }
      const choice = sanitizeThreadText(request.choice.replace(/[\r\n\t]+/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      if (choice === "") {
        throw new Error("请选一项，或写下你的决定。");
      }
      decisions.delete(request.id);
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:decision-resolved", {
          id: request.id,
          projectId: decision.projectId,
        });
      }
      await deliverDecisionAnswer(decision, choice);
      return { ok: true as const };
    },
    "workbench:list-briefs": async (request) => {
      const root = await projectRootOf(request.projectId);
      const listed = await listBriefFiles(root);
      if (!listed.ok) {
        throw new Error(listed.error);
      }
      return { briefs: listed.briefs };
    },
    "workbench:read-brief": async (request) => {
      const root = await projectRootOf(request.projectId);
      const read = await readBriefFile(root, request.relativePath);
      if (!read.ok) {
        throw new Error(read.error);
      }
      return {
        relativePath: read.relativePath,
        content: read.content,
        truncated: read.truncated,
      };
    },
    "workbench:read-threads": async (request) => {
      const root = await projectRootOf(request.projectId);
      const index = await readPanelThreadIndex(root);
      if (!index.ok) {
        throw new Error(index.error);
      }
      const limit =
        typeof request.limit === "number" && Number.isFinite(request.limit)
          ? request.limit
          : PANEL_INDEX_PAGE_LIMIT;
      const offset =
        typeof request.offset === "number" && Number.isFinite(request.offset) ? request.offset : 0;
      const page = pageNewestFirst(index.records, offset, limit);
      return {
        records: page.page.map((record) => ({
          id: record.id,
          ts: record.ts,
          from: record.from,
          to: record.to,
          kind: record.kind,
          ...(record.status !== undefined ? { status: record.status } : {}),
          text: record.text,
          ...(record.briefPath !== undefined && record.briefPath.trim() !== ""
            ? { briefPath: record.briefPath }
            : {}),
          threadFile: record.threadFile,
        })),
        hasMore: page.hasMore,
        capped: index.capped,
      };
    },
    "workbench:get-canvas": async (request) => {
      const root = await projectRootOf(request.projectId);
      ensureCanvasWatcher(root);
      const board = await loadCanvasBoard(root);
      return { board, trash: await canvasTrashView(root) };
    },
    "workbench:canvas-edit": async (request) => {
      const root = await projectRootOf(request.projectId);
      const edit = request.edit;
      const unwrap = (result: { readonly ok: boolean; readonly error?: string }): void => {
        if (!result.ok) {
          throw new Error(result.error ?? "画板操作失败。");
        }
      };
      switch (edit.kind) {
        case "set-page":
          await editCanvasBoard(root, (board) => setActivePage(board, edit.pageId));
          break;
        case "set-annotations":
          unwrap(await updateCanvasAnnotations(root, edit.path, edit.annotations));
          break;
        case "mark-rejected":
          unwrap(await markCanvasRejected(root, edit.path, edit.rejected));
          break;
        case "trash":
          unwrap(await trashCanvasImage(root, edit.path));
          break;
        case "resolve-request":
          unwrap(await resolveCanvasDeleteRequest(root, edit.path, edit.approve));
          break;
        case "restore":
          unwrap(await restoreCanvasTrash(root, edit.trashId));
          break;
        case "purge":
          unwrap(await purgeCanvasTrash(root, edit.trashId));
          break;
        default:
          throw new Error("不认识的画板操作。");
      }
      publishCanvasChanged(request.projectId);
      return { board: await loadCanvasBoard(root), trash: await canvasTrashView(root) };
    },
    "workbench:save-canvas-marked": async (request) => {
      const root = await projectRootOf(request.projectId);
      const written = await writeCanvasMarkedPreview(root, request.relativePath, request.pngBase64);
      if (!written.ok) {
        throw new Error(written.error);
      }
      return { ok: true as const, markedPath: written.relativePath };
    },
    "workbench:read-canvas-image": async (request) => {
      const root = await projectRootOf(request.projectId);
      const read = await readCanvasImageBytes(root, request.relativePath);
      if (!read.ok) {
        throw new Error(read.error);
      }
      return { mime: read.mime, dataUrl: `data:${read.mime};base64,${read.base64}` };
    },
    "workbench:remove-canvas-image": async (request) => {
      const root = await projectRootOf(request.projectId);
      const removed = await removeFromCanvasBoard(root, request.relativePath);
      if (!removed.ok) {
        throw new Error(removed.error);
      }
      publishCanvasChanged(request.projectId);
      return { board: removed.board, trash: await canvasTrashView(root) };
    },
    "workbench:open-ffpane": async (request) => {
      const root = await projectRootOf(request.projectId);
      const resolved = await resolveFfPaneFile(root, request.relativePath);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      const markdown = await assertOpenableMarkdown(resolved.absolute);
      if (!markdown.ok) {
        throw new Error(markdown.error);
      }
      const opened = await shell.openPath(resolved.absolute);
      if (opened !== "") {
        throw new Error(opened);
      }
      return { ok: true as const };
    },
    "workbench:panel-activity": async (request) => {
      const root = await projectRootOf(request.projectId);
      const index = await readPanelThreadIndex(root);
      if (!index.ok) {
        throw new Error(index.error);
      }
      const reports: Record<
        string,
        {
          readonly status: "done" | "blocked" | "failed" | "progress";
          readonly summary: string;
          readonly ts: string;
          readonly briefPath?: string;
        }
      > = {};
      for (const record of index.records) {
        if (
          record.kind !== "report" ||
          record.status === undefined ||
          (record.status !== "done" &&
            record.status !== "blocked" &&
            record.status !== "failed" &&
            record.status !== "progress")
        ) {
          continue;
        }
        reports[record.from.windowId] = {
          status: record.status,
          summary: record.text,
          ts: record.ts,
          ...(record.briefPath !== undefined && record.briefPath.trim() !== ""
            ? { briefPath: record.briefPath }
            : {}),
        };
      }
      const runningWindowIds: string[] = [];
      for (const record of options.manager.list()) {
        if (record.exited) {
          continue;
        }
        const windowId = record.metadata?.["windowId"];
        if (typeof windowId === "string" && windowId.trim() !== "") {
          runningWindowIds.push(windowId);
        }
      }
      return { runningWindowIds, reports };
    },
    "workbench:respond-config-draft": async (request) => {
      const hub = configHubs.get(request.windowId);
      if (hub === undefined) {
        return { ok: false, message: "这份草案已经不在了" };
      }
      return hub.respond({
        turnId: request.windowId,
        draftId: request.draftId,
        decision: request.decision,
        ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
      });
    },
  };

  const publishCanvasOpened = (
    projectId: string,
    openerTitle: string,
    focusPath: string,
    projectRoot: string,
  ): void => {
    ensureCanvasWatcher(projectRoot);
    const browser = options.getWindow();
    if (browser === null || browser.isDestroyed()) {
      return;
    }
    publishEvent(browser.webContents, "workbench:open-canvas", {
      projectId: projectId as ProjectId,
      openerTitle,
      focusPath,
    });
    publishEvent(browser.webContents, "workbench:canvas-changed", {
      projectId: projectId as ProjectId,
    });
  };

  const publishCanvasChanged = (projectId: string): void => {
    const browser = options.getWindow();
    if (browser !== null && !browser.isDestroyed()) {
      publishEvent(browser.webContents, "workbench:canvas-changed", {
        projectId: projectId as ProjectId,
      });
    }
  };
  /** 回收站给界面看的部分（不带回收站里的文件名）。 */
  const canvasTrashView = async (root: string) =>
    (await listCanvasTrash(root)).map((entry) => ({
      id: entry.id,
      originalPath: entry.originalPath,
      deletedBy: entry.deletedBy,
      deletedAt: entry.deletedAt,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    }));

  const projectRootOf = async (projectId: string): Promise<string> => {
    const listed = await projects.listProjects();
    const project = listed.find((item) => item.id === projectId);
    if (project === undefined) {
      throw new Error("找不到这个项目。");
    }
    return project.rootPath;
  };

  onTool = async (context) => {
    if (context.type === "inbox-digest") {
      const text = await takeInboxDigest(context.windowId, toolDeps());
      return { ok: true, result: { text } };
    }
    if (context.type !== "tool") {
      return { ok: false, error: "unsupported" };
    }
    const name = typeof context.body["name"] === "string" ? context.body["name"] : "";
    const rawArgs = context.body["arguments"];
    const args =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const result = await executeWorkbenchTool(context.windowId, name, args, toolDeps());
    return { ok: true, result };
  };

  /** 还没拍板的事。应用退出时窗口都会结束，所以只放内存。 */
  const decisions = new Map<
    string,
    import("../../shared-ipc/contracts").WorkbenchDecision & { readonly projectRoot: string }
  >();
  /** 把用户的决定作为一条「来自用户」的消息写进提问窗口的收件箱，并提醒它。 */
  const deliverDecisionAnswer = async (
    decision: import("../../shared-ipc/contracts").WorkbenchDecision & {
      readonly projectRoot: string;
    },
    choice: string,
  ): Promise<void> => {
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const record: ThreadRecord = {
      v: 1,
      id: `m-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      ts: date.toISOString(),
      projectId: decision.projectId,
      from: { windowId: USER_PARTY_ID, title: "用户", role: "none" },
      to: {
        windowId: decision.windowId,
        title: decision.windowTitle,
        role: authRegistry.get(decision.windowId)?.role ?? "none",
      },
      kind: "message",
      text: `拍板：${decision.question}\n用户的决定：${choice}`,
      ...(decision.briefPath !== undefined ? { briefPath: decision.briefPath } : {}),
      threadFile: `${day}-${teamFileSlug("拍板", decision.windowId)}.md`,
    };
    await appendThreadRecord(decision.projectRoot, record, date);
    const deps = toolDeps();
    const target = await deps.describe(decision.windowId);
    const body =
      target !== undefined && hasInboxHook(target)
        ? { id: record.id, delivery: "attached" as const }
        : { id: record.id, delivery: "summary" as const, summary: record.text };
    deps.remind(
      decision.windowId,
      (count) =>
        count <= 1
          ? buildNewMessageReminder({ title: "用户", role: "none", kind: "message", body })
          : buildCoalescedReminder(count, body),
      USER_PARTY_ID,
    );
    const records = await readThreadIndex(decision.projectRoot);
    const cursor = await cursors.get(decision.windowId);
    deps.publishInbox({
      windowId: decision.windowId,
      unread: recordsAddressedTo(records, decision.windowId, cursor).length,
    });
  };

  const toolDeps = (): WorkbenchToolDeps => ({
    nudge: (windowId) => {
      const parentId = authRegistry.get(windowId)?.parentWindowId;
      if (parentId !== undefined) {
        void teamDigest.clear(parentId, windowId);
      }
      const terminalId = findLiveTerminalId(windowId);
      if (terminalId === undefined) {
        return "not-running";
      }
      const reason = apiErrors.get(windowId)?.label;
      // 被打断或刚重启的窗口常常状态未知，「继续」是平台固定文案，未知时也直接按回车。
      return deliverLineAndWait(
        windowId,
        `[继续] 上一轮被打断了${reason !== undefined ? `（${reason}）` : ""}。从停下的地方接着做；做不了就用 ffpane_report blocked 说明原因。`,
        { allowUnknown: true },
      );
    },
    modelInfo: (windowId) => describeModel(windowId),
    restartWindow: async ({ callerId, windowId, fresh }) => {
      const caller = authRegistry.get(callerId);
      if (caller?.role !== "manager" || !authRegistry.isManagerGranted(callerId)) {
        return { ok: false, error: "只有管理者能重启窗口。" };
      }
      const facts = await modelEffortFacts(windowId);
      const node = authRegistry.get(windowId);
      const openedBy = node?.openedBy ?? facts.stored?.openedBy;
      const parentId = node?.parentWindowId ?? facts.stored?.parentWindowId;
      const openedByCaller =
        typeof openedBy === "object" && openedBy !== null
          ? openedBy.windowId === callerId
          : parentId === callerId;
      if (facts.stored === undefined || !openedByCaller) {
        return { ok: false, error: "只能重启你自己开的窗口。" };
      }
      if (facts.permission !== "read-only") {
        return {
          ok: false,
          error: "只能重启只读窗口。别的窗口请用 ffpane_set_model_effort，或请用户在那个窗口重启。",
        };
      }
      if (facts.phase === "blocked") {
        return { ok: false, error: "它在等用户批准，先不重启。" };
      }
      if (modelEffortRuns.has(windowId)) {
        return { ok: false, error: "它正在重启。" };
      }
      // 没聊过天的会话没有可续接的记录（Claude 续接空会话会报错），直接开新的。
      const resume = !fresh && facts.canResume && facts.hadConversation;
      const relaunched = await relaunchWindow(windowId, {
        resume,
        ...(resume && facts.sessionId !== undefined ? { nativeSessionId: facts.sessionId } : {}),
      });
      if (!relaunched.ok) {
        return relaunched;
      }
      permissionChangePending.delete(windowId);
      modelEffort.drop(windowId);
      const actual = await settleActualModel(windowId, relaunched.result);
      return { ok: true, how: resume ? "resume" : "fresh", ...actual };
    },
    waitEvents: async (windowId, timeoutMs) => {
      const pending = onlineHub.wait(windowId, timeoutMs);
      publishOnline(windowId);
      const outcome = await pending;
      publishOnline(windowId);
      return outcome;
    },
    requestDecision: ({ caller, question, options: choices, briefPath }) => {
      const id = `d-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const decision = {
        id,
        projectId: caller.projectId as ProjectId,
        windowId: caller.id,
        windowTitle: caller.title,
        question,
        options: [...choices],
        ...(briefPath !== undefined ? { briefPath } : {}),
        createdAt: Date.now(),
      };
      decisions.set(id, { ...decision, projectRoot: caller.projectRoot });
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:decision-requested", decision);
      }
      return { id };
    },
    now: () => Date.now(),
    snapshot: () => authRegistry.snapshot(),
    isManagerGranted: (windowId) => authRegistry.isManagerGranted(windowId),
    describe: async (windowId) => {
      const layoutsAll = await layouts.readAll();
      let found: import("@ff-pane/shared").WorkbenchWindow | undefined;
      let projectName = "";
      let projectRoot = "";
      for (const layoutEntry of Object.values(layoutsAll)) {
        const window = layoutEntry.windows[windowId];
        if (window !== undefined) {
          found = window;
          projectRoot = window.cwd;
          break;
        }
      }
      if (found === undefined) {
        return undefined;
      }
      const listed = await projects.listProjects();
      const project = listed.find((item) => item.id === found?.projectId);
      if (project !== undefined) {
        projectName = project.name;
        projectRoot = project.rootPath;
      }
      const node = authRegistry.get(windowId);
      const parentId = node?.parentWindowId ?? found.parentWindowId;
      let parentTitle: string | undefined;
      if (parentId !== undefined) {
        for (const layoutEntry of Object.values(layoutsAll)) {
          const parent = layoutEntry.windows[parentId];
          if (parent !== undefined) {
            parentTitle = parent.title;
            break;
          }
        }
      }
      return {
        id: found.id,
        title: found.title,
        projectId: found.projectId,
        projectName: projectName || found.projectId,
        projectRoot,
        role: node?.role ?? found.role ?? "none",
        permission: node?.permission ?? found.permission ?? "edit",
        openedBy: node?.openedBy ?? found.openedBy ?? "user",
        sanitizeLocked: node?.sanitizeLocked === true,
        running: findLiveTerminalId(windowId) !== undefined,
        ...(found.kind !== undefined ? { kind: found.kind } : {}),
        ...(found.watcherWindowId !== undefined ? { watcherWindowId: found.watcherWindowId } : {}),
        ...(parentId !== undefined && parentId.trim() !== "" ? { parentWindowId: parentId } : {}),
        ...(parentTitle !== undefined ? { parentTitle } : {}),
      };
    },
    setRole: (callerId, targetId, role) =>
      setWindowRole({ kind: "window", windowId: callerId }, targetId, role, roleDeps()),
    openChild: (callerId, childArgs) =>
      openChildWindow(callerId, childArgs, {
        authRegistry,
        readLayouts: () => layouts.readAll(),
        saveLayout: (next) => layouts.saveProject(next),
        launch: (input) => launchCliWindow(input, launchDeps()),
        resolveRoute: (routeInput) =>
          resolveProjectLaunchRoute({
            projectRoot: routeInput.projectRoot,
            projectId: routeInput.projectId,
            kind: routeInput.cli,
            configs: projectConfigs,
            getProvider: async (id) => {
              const provider = await providers.getProvider(id as never);
              return provider === undefined ? undefined : { id: provider.id, name: provider.name };
            },
          }),
        describeCaller: async (windowId) => {
          const layoutsAll = await layouts.readAll();
          for (const layoutEntry of Object.values(layoutsAll)) {
            const window = layoutEntry.windows[windowId];
            if (window === undefined) {
              continue;
            }
            const listed = await projects.listProjects();
            const project = listed.find((item) => item.id === window.projectId);
            const node = authRegistry.get(windowId);
            return {
              title: window.title,
              projectId: window.projectId,
              projectRoot: project?.rootPath ?? window.cwd,
              permission: node?.permission ?? window.permission ?? "edit",
            };
          }
          return undefined;
        },
        aliveCount: () => options.manager.aliveCount(),
        checkResources: async (projectRoot) =>
          describeShortage(
            await takeResourceSnapshot(projectRoot),
            resourceLimitsFromConfig(await config.readConfig()),
          ),
        maxWindows: async () => clampMaxWorkbenchWindows(await getMax()),
        publish: ({ projectId, window, managerWindowId }) => {
          const browser = options.getWindow();
          if (browser === null || browser.isDestroyed()) {
            return;
          }
          publishEvent(browser.webContents, "workbench:child-window", {
            projectId: projectId as ProjectId,
            window,
            managerWindowId,
          });
        },
      }),
    remind: (windowId, textForCount, fromWindowId, remindOptions) => {
      // 上级给这个窗口发了消息：它在上级待处理里的那一行算处理过了。
      void teamDigest.clear(fromWindowId, windowId);
      if (onlineHub.offerInbox(windowId)) {
        return "online";
      }
      const terminalId = findLiveTerminalId(windowId);
      // 对方因限流暂停或不在：不打进终端（打进去它又会去调接口），记进它的待处理，等用户叫醒它。
      if (apiErrors.isPaused(windowId) || terminalId === undefined) {
        const hasTeam = Object.values(authRegistry.snapshot()).some(
          (node) => node.parentWindowId === windowId,
        );
        if (hasTeam) {
          return holdForManager(windowId, fromWindowId, textForCount(1)).then(
            (): RemindDelivery => "held",
            (): RemindDelivery => (terminalId === undefined ? "not-running" : "failed"),
          );
        }
        if (terminalId === undefined) {
          return "not-running";
        }
      }
      if (terminalId === undefined) {
        return "not-running";
      }
      const waitSubmit = remindOptions?.waitSubmit === true;
      let settle: (result: SubmitResult) => void = () => undefined;
      const submitted = new Promise<SubmitResult>((done) => {
        settle = done;
      });
      const queued = idleQueue.enqueueInbox(
        terminalId,
        textForCount,
        waitSubmit ? settle : undefined,
      );
      if (queued.status === "dropped") {
        return "failed";
      }
      if (queued.status === "delivered") {
        if (waitSubmit) {
          // 结果由这次调用直接返回，不再另发「投递失败」提醒。
          return awaitSubmit("delivered", submitted);
        }
        inflightSenders.set(terminalId, new Set([fromWindowId]));
        return "delivered";
      }
      const senders = pendingSenders.get(terminalId) ?? new Set<string>();
      senders.add(fromWindowId);
      pendingSenders.set(terminalId, senders);
      return queuedDelivery(queued.mode);
    },
    clearReminder: (windowId) => {
      const terminalId = findLiveTerminalId(windowId);
      if (terminalId === undefined) {
        return;
      }
      if (idleQueue.dropInbox(terminalId) > 0) {
        pendingSenders.delete(terminalId);
      }
    },
    publishInbox: (notice) => {
      const browser = options.getWindow();
      if (browser === null || browser.isDestroyed()) {
        return;
      }
      publishEvent(browser.webContents, "workbench:inbox-notice", notice);
    },
    getCursor: (windowId) => cursors.get(windowId),
    setCursor: (windowId, lastReadId) => cursors.set(windowId, lastReadId),
    readOutput: async (windowId, maxBytes) => {
      const bytes = clampReadOutputBytes(maxBytes);
      let exited = false;
      let liveId: string | undefined;
      for (const record of options.manager.list()) {
        if (record.metadata?.["windowId"] !== windowId) {
          continue;
        }
        if (record.exited) {
          exited = true;
          continue;
        }
        liveId = record.id;
      }
      if (liveId === undefined) {
        return {
          running: false as const,
          status: exited ? "该窗口的终端已退出。" : "该窗口还没有启动。",
        };
      }
      return {
        running: true as const,
        status: "运行中",
        text: takeUtf8Tail(options.manager.getReplayBuffer(liveId), bytes),
      };
    },
    readScreen: async (windowId, lines) => {
      const terminalId = findLiveTerminalId(windowId);
      const record = terminalId !== undefined ? options.manager.get(terminalId) : undefined;
      if (terminalId === undefined || record === undefined) {
        return { running: false as const, status: "该窗口的终端没有运行。" };
      }
      const text = await renderTerminalText(
        options.manager.getReplayBuffer(terminalId),
        { cols: record.cols, rows: record.rows },
        lines,
      );
      return { running: true as const, status: "运行中", text };
    },
    closeDescendant: {
      findTerminalId: findLiveTerminalId,
      killTerminal: (terminalId) => {
        options.manager.kill(terminalId);
      },
      dropQueue: (terminalId) => {
        idleQueue.drop(terminalId);
      },
      revokeToken: (windowId) => {
        tokenRegistry.revoke(windowId);
      },
      releaseRuntime: (windowId) => {
        modelEffort.drop(windowId);
        void mcpRegistry.release(windowId);
        codexClaimer.cancel(windowId);
        releaseWindowHooks(windowId);
        void rolePromptTemps.release(windowId);
        void disposeConfigHub(windowId);
      },
      closeRegistered: (windowId) => {
        authRegistry.closeRegistered(windowId);
      },
      readLayouts: () => layouts.readAll(),
      saveLayout: (next) => layouts.saveProject(next),
      publishClosed: (projectId, windowId) => {
        const browser = options.getWindow();
        if (browser === null || browser.isDestroyed()) {
          return;
        }
        publishEvent(browser.webContents, "workbench:window-closed", {
          projectId: projectId as ProjectId,
          windowId,
        });
      },
    },
    searchProjectMemory: (projectRoot, query, limit) =>
      searchCallerProjectMemory(memoryIndex, projectRoot, query, limit),
    addProjectMemory: async (projectRoot, entry) => {
      await addCallerProjectMemory(memoryIndex, projectRoot, entry);
    },
    locks,
    notifyLockGranted,
    windowState: (windowId) => {
      const terminalId = findLiveTerminalId(windowId);
      if (terminalId === undefined) {
        return undefined;
      }
      const record = options.manager.get(terminalId);
      const apiError = apiErrors.get(windowId);
      const memory = options.manager.getStats(terminalId);
      return {
        phase: idleQueue.phaseOf(terminalId),
        ...(apiError !== undefined
          ? {
              lastApiError: {
                type: apiError.type,
                label: apiError.label,
                at: apiError.at,
                paused: apiError.paused,
              },
            }
          : {}),
        ...(record !== undefined
          ? { lastOutputAt: record.lastOutputAt, contained: record.contained }
          : {}),
        pendingReminders: idleQueue.pendingCount(terminalId),
        online: onlineHub.isOnline(windowId),
        ...(memory !== undefined ? { memory } : {}),
      };
    },
    closeSelfLater: (windowId) => {
      setTimeout(() => {
        void (async () => {
          const deps = toolDeps();
          const target = await deps.describe(windowId);
          const parentId = target?.parentWindowId;
          const parent = parentId !== undefined ? await deps.describe(parentId) : undefined;
          if (target === undefined || parent === undefined) {
            return;
          }
          await closeDescendantWindow(
            parent,
            target,
            authRegistry.snapshot(),
            Date.now(),
            deps.closeDescendant,
          );
        })().catch((error: unknown) => {
          console.error(`[wb-close-self] ${String(error)}`);
        });
      }, 3000);
    },
    setPermission: async (input) => {
      const all = await layouts.readAll();
      for (const layoutEntry of Object.values(all)) {
        const window = layoutEntry.windows[input.windowId];
        if (window === undefined) {
          continue;
        }
        if (!authRegistry.applyDelegatedPermission(input.windowId, input.permission)) {
          return { ok: false, error: "找不到这个窗口的登记。" };
        }
        const { permissionNeedsDowngrade: _down, ...rest } = window;
        void _down;
        await layouts.saveProject({
          ...layoutEntry,
          windows: {
            ...layoutEntry.windows,
            [input.windowId]: { ...rest, permission: input.permission },
          },
        });
        const previous = modelEffortView.get(input.windowId);
        modelEffortView.set(input.windowId, { ...previous, permission: input.permission });
        permissionChangePending.add(input.windowId);
        const facts = await modelEffortFacts(input.windowId);
        const decision = modelEffort.request(input.windowId, facts, {
          ...(window.modelOverride !== undefined ? { model: window.modelOverride } : {}),
          ...(window.effortOverride !== undefined ? { effort: window.effortOverride } : {}),
        });
        if (decision.launch) {
          const applied = await awaitModelEffortRun(input.windowId, false);
          if (applied !== undefined) {
            return {
              ok: true,
              message:
                applied.status === "applied" ? "已生效：窗口已按新权限重启。" : applied.message,
            };
          }
        }
        return { ok: true, message: decision.message };
      }
      return { ok: false, error: "找不到这个窗口。" };
    },
    setModelEffort: async (input) => {
      const parsed = parseModelEffortArgs({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
      if (!parsed.ok) {
        return parsed;
      }
      const all = await layouts.readAll();
      let found:
        | {
            readonly layout: (typeof all)[string];
            readonly window: (typeof all)[string]["windows"][string];
          }
        | undefined;
      for (const layout of Object.values(all)) {
        const window = layout.windows[input.windowId];
        if (window !== undefined) {
          found = { layout, window };
          break;
        }
      }
      if (
        found === undefined ||
        (found.window.kind !== "claude" && found.window.kind !== "codex")
      ) {
        return { ok: false, error: "找不到这个 Claude 或 Codex 窗口。" };
      }
      const node = authRegistry.get(input.windowId);
      if (node === undefined) {
        authRegistry.upsert(
          {
            id: found.window.id,
            permission: isWorkbenchPermissionLevel(found.window.permission)
              ? found.window.permission
              : DEFAULT_WORKBENCH_WINDOW_PERMISSION,
            openedBy: found.window.openedBy ?? "user",
            role: isWorkbenchRole(found.window.role) ? found.window.role : DEFAULT_WORKBENCH_ROLE,
            ...(found.window.parentWindowId !== undefined &&
            found.window.parentWindowId.trim() !== ""
              ? { parentWindowId: found.window.parentWindowId }
              : {}),
          },
          found.window.projectId,
        );
      }
      const tree = authRegistry.snapshot();
      const targetRole =
        tree[input.windowId]?.role ??
        (isWorkbenchRole(found.window.role) ? found.window.role : DEFAULT_WORKBENCH_ROLE);
      const allowed = canSetModelEffort({
        callerId: input.callerId,
        callerGranted: authRegistry.isManagerGranted(input.callerId),
        targetId: input.windowId,
        targetRole,
        tree,
      });
      if (!allowed.ok) {
        return allowed;
      }
      const nextWindow = {
        ...found.window,
        ...(parsed.model !== undefined ? { modelOverride: parsed.model } : {}),
        ...(parsed.reasoningEffort !== undefined ? { effortOverride: parsed.reasoningEffort } : {}),
      };
      await layouts.saveProject({
        ...found.layout,
        windows: { ...found.layout.windows, [input.windowId]: nextWindow },
      });
      modelEffortView.set(input.windowId, {
        ...(nextWindow.modelOverride !== undefined
          ? { modelOverride: nextWindow.modelOverride }
          : {}),
        ...(nextWindow.effortOverride !== undefined
          ? { effortOverride: nextWindow.effortOverride }
          : {}),
      });
      modelEffortRequester.set(input.windowId, input.callerId);
      const facts = await modelEffortFacts(input.windowId);
      const decision = modelEffort.request(input.windowId, facts, {
        ...(nextWindow.modelOverride !== undefined ? { model: nextWindow.modelOverride } : {}),
        ...(nextWindow.effortOverride !== undefined ? { effort: nextWindow.effortOverride } : {}),
      });
      const readOnly = facts.permission === "read-only";
      if (decision.launch) {
        const applied = await awaitModelEffortRun(input.windowId, readOnly);
        if (applied !== undefined) {
          return { ok: true, ...applied };
        }
      }
      if (decision.outcome === "confirm") {
        return { ok: true, status: "confirm", message: decision.message };
      }
      if (decision.outcome === "deferred") {
        return {
          ok: true,
          status: "recorded",
          message: `${decision.message}${
            decision.reason === "no-session" && readOnly
              ? "。它是只读窗口，可以用 ffpane_restart_window 重启让它生效"
              : decision.reason === "no-session"
                ? "。需要现在生效请用户在那个窗口重启"
                : ""
          }。`,
        };
      }
      return { ok: true, status: "queued", message: decision.message };
    },
    openPanel: (panel, openerTitle, projectId) => {
      const browser = options.getWindow();
      if (browser === null || browser.isDestroyed()) {
        return;
      }
      publishEvent(browser.webContents, "workbench:open-panel", {
        panel,
        openerTitle,
        projectId: projectId as ProjectId,
      });
    },
    openCanvas: async (input) => {
      const placed = await placeImageOnBoard(input.projectRoot, input.imagePath, {
        ...(input.rowId !== undefined ? { rowId: input.rowId } : {}),
        ...(input.asNewVersion === true ? { asNewVersion: true } : {}),
      });
      if (!placed.ok) {
        return placed;
      }
      const revision = await describeCanvasRevision(input.projectRoot, placed.relativePath);
      publishCanvasOpened(
        input.projectId,
        input.openerTitle,
        placed.relativePath,
        input.projectRoot,
      );
      return {
        ok: true as const,
        relativePath: placed.relativePath,
        ...(revision !== undefined ? { revision } : {}),
      };
    },
    generateImage: async (input) => {
      const outcome = await generateProjectImage(
        {
          projectRoot: input.projectRoot,
          prompt: input.prompt,
          ...(input.sourceImagePath !== undefined
            ? { sourceImagePath: input.sourceImagePath }
            : {}),
          ...(input.rowId !== undefined ? { rowId: input.rowId } : {}),
          ...(input.asNewVersion === true ? { asNewVersion: true } : {}),
        },
        {
          stores: {
            readConfig: () => config.readConfig(),
            updateConfig: (patch) => config.updateConfig(patch),
            storeSecret: (plaintext) => secrets.storeSecret(plaintext),
            revealSecret: (ref) => secrets.revealSecret(ref),
            deleteSecret: (ref) => secrets.deleteSecret(ref),
            hasSecret: (ref) => secrets.hasSecret(ref),
            maskedTail: (ref) => secrets.maskedTail(ref),
          },
        },
      );
      if (!outcome.ok) {
        return outcome;
      }
      publishCanvasOpened(
        input.projectId,
        input.openerTitle,
        outcome.relativePath,
        input.projectRoot,
      );
      return outcome;
    },
    deleteCanvasFile: async (caller, imagePath, reason) => {
      const result = await requestCanvasDelete(caller.projectRoot, imagePath, caller.title, reason);
      if (result.ok) {
        publishCanvasChanged(caller.projectId);
      }
      return result;
    },
    exportCanvasImage: async (caller, imagePath, targetPath, overwrite) => {
      const result = await exportCanvasImage(caller.projectRoot, imagePath, targetPath, overwrite);
      if (result.ok) {
        publishCanvasChanged(caller.projectId);
      }
      return result;
    },
  });

  return {
    handlers,
    mcpRegistry,
    codexClaimer,
    tokenRegistry,
    authRegistry,
    idleQueue,
    modelEffort,
    rolePromptTemps,
    releaseConfigHub: disposeConfigHub,
    noteWindowExit,
    dispose: async () => {
      clearInterval(stallTimer);
      clearInterval(promptTimer);
      apiErrors.dispose();
      onlineHub.dispose();
      for (const windowId of [...codexTails.keys()]) {
        stopCodexTail(windowId);
      }
      await control.close();
      idleQueue.dispose();
      codexClaimer.dispose();
      tokenRegistry.clear();
      authRegistry.clear();
      await mcpRegistry.releaseAll();
      await rolePromptTemps.releaseAll();
      for (const windowId of [...configHubs.keys()]) {
        await disposeConfigHub(windowId);
      }
      if (ownsMemoryIndex) {
        memoryIndex.close();
      }
    },
  };
}

/** 根据 terminal metadata.windowId 释放 MCP 临时文件、吊销令牌，并取消 Codex 认领。 */
export function releaseMcpForTerminalMetadata(
  registry: WorkbenchMcpTempRegistry,
  metadata: Readonly<Record<string, unknown>> | undefined,
  claimer?: CodexSessionClaimer,
  tokenRegistry?: WindowTokenRegistry,
): void {
  const windowId = metadata?.["windowId"];
  if (typeof windowId === "string" && windowId.trim() !== "") {
    void registry.release(windowId);
    claimer?.cancel(windowId);
    tokenRegistry?.revoke(windowId);
    releaseWindowHooks(windowId);
  }
}
