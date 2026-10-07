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
import { CodexSessionClaimer } from "./codex-claim";
import { createWorkbenchConfigDraftActions } from "./config-draft-apply";
import { isConfigToolAuthorized, shouldAttachConfigTool } from "./config-tool-attach";
import {
  createWorkbenchControlServer,
  WORKBENCH_TOOL_MAX_REQUEST_BYTES,
  type WorkbenchControlRequestContext,
} from "./control-channel";
import { releaseWindowHooks } from "./hook-launch";
import { createIdleDeliverQueue, type IdleDeliverQueue } from "./idle-deliver";
import { createInboxCursorStore, inboxCursorPath } from "./inbox-cursor";
import { assertLaunchCliIpcSafe, launchCliWindow, WorkbenchMcpTempRegistry } from "./launch-cli";
import { decideManagerGrantRestore } from "./manager-grant";
import { cleanupStaleWorkbenchMcpDirs } from "./mcp-temp";
import { executeWorkbenchTool } from "./mcp-tools";
import {
  canSetModelEffort,
  createModelEffortController,
  type ModelEffortController,
  parseModelEffortArgs,
  withModelEffortOverrides,
} from "./model-effort";
import { openChildWindow } from "./open-child";
import { clampReadOutputBytes, takeUtf8Tail } from "./output-text";
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
import { resolveProjectLaunchRoute } from "./resolve-config";
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
import { readThreadIndexTail, summarizeInboxBadges } from "./thread-store";

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
    | "workbench:list-briefs"
    | "workbench:read-brief"
    | "workbench:read-threads"
    | "workbench:open-ffpane"
    | "workbench:panel-activity"
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

  const idleQueue = createIdleDeliverQueue({
    isIdle: (terminalId, quietMs) => options.manager.isIdle(terminalId, quietMs),
    isAlive: (terminalId) => {
      const record = options.manager.get(terminalId);
      return record !== undefined && record.exited !== true;
    },
    write: (terminalId, data) => {
      options.manager.write(terminalId, data);
    },
    now: () => Date.now(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
    onDeferred: (outcome) => {
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
  const control = await createWorkbenchControlServer({
    tokens: tokenRegistry,
    maxRequestBytes: WORKBENCH_TOOL_MAX_REQUEST_BYTES,
    onRequest: (context) => onTool(context),
    onHook: (windowId, signal, meta) => {
      const terminalId = findLiveTerminalId(windowId);
      if (terminalId !== undefined) {
        idleQueue.noteHook(terminalId, signal, {
          ...(meta?.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
          ...(meta?.toolDigest !== undefined ? { toolDigest: meta.toolDigest } : {}),
        });
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
    idleQueue,
    onCodexSessionClaimed: (windowId: string, nativeSessionId: string) => {
      const window = options.getWindow();
      if (window === null || window.isDestroyed()) {
        return;
      }
      publishEvent(window.webContents, "workbench:session-claimed", {
        windowId,
        nativeSessionId,
      });
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
    { readonly modelOverride?: string; readonly effortOverride?: string }
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
              : undefined;
      if (kind === undefined) {
        throw new Error("kind must be claude, codex, or grok");
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
        },
        launchDeps(),
      );
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

  const projectRootOf = async (projectId: string): Promise<string> => {
    const listed = await projects.listProjects();
    const project = listed.find((item) => item.id === projectId);
    if (project === undefined) {
      throw new Error("找不到这个项目。");
    }
    return project.rootPath;
  };

  onTool = async (context) => {
    if (context.type !== "tool") {
      return { ok: false, error: "unsupported" };
    }
    const name = typeof context.body["name"] === "string" ? context.body["name"] : "";
    const rawArgs = context.body["arguments"];
    const args =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const result = await executeWorkbenchTool(context.windowId, name, args, {
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
                return provider === undefined
                  ? undefined
                  : { id: provider.id, name: provider.name };
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
      remind: (windowId, textForCount) => {
        const terminalId = findLiveTerminalId(windowId);
        if (terminalId === undefined) {
          return;
        }
        idleQueue.enqueueInbox(terminalId, textForCount);
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
          ...(parsed.reasoningEffort !== undefined
            ? { effortOverride: parsed.reasoningEffort }
            : {}),
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
    });
    return { ok: true, result };
  };

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
    dispose: async () => {
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
