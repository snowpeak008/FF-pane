/**
 * 工作台 CLI 启动 IPC（T10.4 / T10.4' / T10.5'）。
 */

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
import { createWorkbenchAuthRegistry, type WorkbenchAuthRegistry } from "./auth-registry";
import {
  deleteCanvasImageFile,
  describeCanvasRevision,
  loadCanvasBoard,
  placeImageOnBoard,
  readCanvasImageBytes,
  removeFromCanvasBoard,
  saveCanvasBoard,
  writeCanvasMarkedPreview,
} from "./canvas-files";
import { ensureCanvasWatcher } from "./canvas-watcher";
import { closeDescendantWindow } from "./close-descendant";
import { CodexSessionClaimer, resolveCodexHome } from "./codex-claim";
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
import { createIdleDeliverQueue, type IdleDeliverQueue } from "./idle-deliver";
import { createInboxCursorStore, inboxCursorPath } from "./inbox-cursor";
import { assertLaunchCliIpcSafe, launchCliWindow, WorkbenchMcpTempRegistry } from "./launch-cli";
import { decideManagerGrantRestore } from "./manager-grant";
import { cleanupStaleWorkbenchMcpDirs } from "./mcp-temp";
import {
  executeWorkbenchTool,
  type RemindDelivery,
  takeInboxDigest,
  type WorkbenchToolDeps,
} from "./mcp-tools";
import {
  canSetModelEffort,
  createModelEffortController,
  type ModelEffortController,
  parseModelEffortArgs,
  withModelEffortOverrides,
} from "./model-effort";
import { createNamedLocks, type LockGrant } from "./named-locks";
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
import { sanitizeReminderTitle } from "./remind";
import { resolveProjectLaunchRoute } from "./resolve-config";
import { describeShortage, takeResourceSnapshot } from "./resource-guard";
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
import { readThreadIndex, readThreadIndexTail, summarizeInboxBadges } from "./thread-store";

export interface WorkbenchCliLayer {
  readonly handlers: Pick<
    InvokeHandlers,
    | "workbench:launch-cli"
    | "workbench:set-role"
    | "workbench:set-permission"
    | "workbench:deliver-now"
    | "workbench:deliver-cancel"
    | "workbench:model-effort-settled"
    | "workbench:list-role-manuals"
    | "workbench:save-role-manual"
    | "workbench:reset-role-manual"
    | "workbench:inbox-badges"
    | "workbench:runtime-status"
    | "workbench:list-briefs"
    | "workbench:read-brief"
    | "workbench:read-threads"
    | "workbench:open-ffpane"
    | "workbench:panel-activity"
    | "workbench:get-canvas"
    | "workbench:save-canvas"
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
    readonly mode: "manual" | "blocked" | "busy" | "clear";
  }): void => {
    const window = options.getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    publishEvent(window.webContents, "workbench:deliver-pending", notice);
  };

  const locks = createNamedLocks();
  /** 平台主动报告的状态，发给监管者（有的话）或上级。只发固定文案，不带终端正文。 */
  const notifyOverseer = async (windowId: string, what: string): Promise<void> => {
    let found: import("@ff-pane/shared").WorkbenchWindow | undefined;
    for (const current of Object.values(await layouts.readAll())) {
      found = current.windows[windowId];
      if (found !== undefined) {
        break;
      }
    }
    if (found === undefined) {
      return;
    }
    const parentId = authRegistry.get(windowId)?.parentWindowId ?? found.parentWindowId;
    const candidates = [found.watcherWindowId, parentId];
    for (const overseer of candidates) {
      if (overseer === undefined || overseer === windowId) {
        continue;
      }
      const terminalId = findLiveTerminalId(overseer);
      if (terminalId === undefined) {
        continue;
      }
      idleQueue.enqueue({
        terminalId,
        text: `[状态] ${sanitizeReminderTitle(found.title)}（${windowId}）${what}`,
        tag: overseer,
      });
      return;
    }
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
  /** 最近一次因 API 错误中断的类型和时间。下一次正常结束时清掉。 */
  const lastApiError = new Map<string, { readonly type: string; readonly at: number }>();
  const API_ERROR_TEXT: Readonly<Record<string, string>> = {
    rate_limit: "账号限流（429）",
    overloaded: "服务过载",
    authentication_failed: "认证失败",
    oauth_org_not_allowed: "组织不允许",
    account_on_hold: "账号被暂停",
    billing_error: "计费问题",
    invalid_request: "请求无效",
    model_not_found: "找不到模型",
    server_error: "服务端错误",
    max_output_tokens: "输出超长",
    cloud_credential_error: "云凭据错误",
  };
  const noteApiError = (windowId: string, errorType: string): void => {
    const previous = lastApiError.get(windowId);
    lastApiError.set(windowId, { type: errorType, at: Date.now() });
    // 同一类错误连着来只报一次，免得限流时刷屏。
    if (previous?.type === errorType) {
      return;
    }
    const label = API_ERROR_TEXT[errorType] ?? `API 错误（${errorType}）`;
    void notifyOverseer(
      windowId,
      `这一轮因${label}中断，已经停下。它持有的锁还在；限流的话等一会儿再发消息让它继续，或请用户处理。`,
    );
  };
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
      if (idleQueue.phaseOf(record.id) !== "busy" || now - record.lastOutputAt < STALL_NOTICE_MS) {
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
  const stallTimer = setInterval(checkStalls, 30_000);
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
    const terminalId = findLiveTerminalId(grant.windowId);
    if (terminalId === undefined) {
      return;
    }
    idleQueue.enqueue({
      terminalId,
      text: `[锁] 轮到你了，你已拿到锁 ${grant.name}，可以开始用。用完调用 ffpane_lock release。`,
      tag: grant.windowId,
    });
  };
  const noteWindowExit = (
    windowId: string,
    exit: { readonly exitCode: number; readonly killed: boolean },
  ): void => {
    clearPermissionTimer(windowId);
    lastApiError.delete(windowId);
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
          idleQueue.enqueue({ terminalId: senderTerminal, text, tag: senderId });
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
  const API_ERROR_SAME_TURN_MS = 1500;
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
    if (signal === "stop" && meta?.errorType !== undefined) {
      noteApiError(windowId, meta.errorType);
    } else if (signal === "stop") {
      const stopAt = Date.now();
      const recent = lastApiError.get(windowId);
      // 同一轮的正常结束信号和出错信号可能先后到（Codex 的 notify 立刻到，rollout 里的错误稍后读到）。
      // 刚出过错就不清，也不再报「空闲没汇报」。
      if (recent === undefined || stopAt - recent.at > API_ERROR_SAME_TURN_MS) {
        setTimeout(() => {
          const after = lastApiError.get(windowId);
          if (after !== undefined && after.at >= stopAt - API_ERROR_SAME_TURN_MS) {
            return;
          }
          lastApiError.delete(windowId);
          void noteIdleWithoutReport(windowId).catch(() => undefined);
        }, API_ERROR_SAME_TURN_MS);
      }
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
    return {
      running: terminalId !== undefined,
      phase: terminalId !== undefined ? idleQueue.phaseOf(terminalId) : ("unknown" as const),
      canResume: terminalId !== undefined && sessionId !== undefined && sessionId.trim() !== "",
      needsConfirm: role === "manager" || permission === "yolo",
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
      const storedWindow = (await layouts.readAll())[request.projectId]?.windows[request.windowId];
      modelEffort.noteLaunchRead(request.windowId, generationBeforeRead);
      const route = withModelEffortOverrides(resolved.route, storedWindow);
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
          ...(request.resume === true ? { resume: true } : {}),
          ...(request.nativeSessionId !== undefined
            ? { nativeSessionId: request.nativeSessionId }
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
    "workbench:deliver-now": (request) => {
      const terminalId = findLiveTerminalId(request.windowId);
      if (terminalId === undefined) {
        return { ok: false as const, reason: "unknown-window" as const };
      }
      const result = idleQueue.deliverNow(terminalId);
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
        };
      }
      const snapshot = await takeResourceSnapshot(root);
      return { windows, resources: snapshot };
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
      return { board };
    },
    "workbench:save-canvas": async (request) => {
      const root = await projectRootOf(request.projectId);
      if (request.board.v !== 1) {
        throw new Error("不支持的画板版本。");
      }
      await saveCanvasBoard(root, request.board);
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:canvas-changed", {
          projectId: request.projectId,
        });
      }
      return { ok: true as const };
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
      const browser = options.getWindow();
      if (browser !== null && !browser.isDestroyed()) {
        publishEvent(browser.webContents, "workbench:canvas-changed", {
          projectId: request.projectId,
        });
      }
      return { board: removed.board };
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

  const toolDeps = (): WorkbenchToolDeps => ({
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
          describeShortage(await takeResourceSnapshot(projectRoot)),
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
    remind: (windowId, textForCount, fromWindowId): RemindDelivery => {
      const terminalId = findLiveTerminalId(windowId);
      if (terminalId === undefined) {
        return "not-running";
      }
      const queued = idleQueue.enqueueInbox(terminalId, textForCount);
      if (queued.status === "dropped") {
        return "failed";
      }
      if (queued.status === "delivered") {
        inflightSenders.set(terminalId, new Set([fromWindowId]));
        return "delivered";
      }
      const senders = pendingSenders.get(terminalId) ?? new Set<string>();
      senders.add(fromWindowId);
      pendingSenders.set(terminalId, senders);
      return queued.mode === "manual"
        ? "queued-manual"
        : queued.mode === "blocked"
          ? "queued-blocked"
          : "queued-busy";
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
      const apiError = lastApiError.get(windowId);
      const memory = options.manager.getStats(terminalId);
      return {
        phase: idleQueue.phaseOf(terminalId),
        ...(apiError !== undefined
          ? {
              lastApiError: {
                type: apiError.type,
                label: API_ERROR_TEXT[apiError.type] ?? apiError.type,
                at: apiError.at,
              },
            }
          : {}),
        ...(record !== undefined
          ? { lastOutputAt: record.lastOutputAt, contained: record.contained }
          : {}),
        pendingReminders: idleQueue.pendingCount(terminalId),
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
        const facts = await modelEffortFacts(input.windowId);
        const decision = modelEffort.request(input.windowId, facts, {
          ...(window.modelOverride !== undefined ? { model: window.modelOverride } : {}),
          ...(window.effortOverride !== undefined ? { effort: window.effortOverride } : {}),
        });
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
      const facts = await modelEffortFacts(input.windowId);
      const decision = modelEffort.request(input.windowId, facts, {
        ...(nextWindow.modelOverride !== undefined ? { model: nextWindow.modelOverride } : {}),
        ...(nextWindow.effortOverride !== undefined ? { effort: nextWindow.effortOverride } : {}),
      });
      return { ok: true, message: decision.message };
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
    deleteCanvasFile: async (projectRoot, imagePath) =>
      deleteCanvasImageFile(projectRoot, imagePath),
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
