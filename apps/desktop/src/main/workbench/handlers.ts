/**
 * 工作台 CLI 启动 IPC（T10.4 / T10.4' / T10.5'）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowTokenRegistry, type WindowTokenRegistry } from "@ff-pane/core";
import {
  clampMaxWorkbenchWindows,
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  isWorkbenchRoleManualId,
  type ProjectId,
  type Provider,
} from "@ff-pane/shared";
import {
  createConfigStore,
  createProfileStore,
  createProjectRegistry,
  createProjectSettingsStore,
  createProviderStore,
  createWorkbenchLayoutStore,
  initGlobalLayout,
  resolveGlobalLayout,
  resolveProjectLayout,
} from "@ff-pane/storage";
import { app, type BrowserWindow, shell } from "electron";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { publishEvent } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import { WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX } from "../terminal/handlers";
import type { PtyManager } from "../terminal/manager";
import { createWorkbenchAuthRegistry, type WorkbenchAuthRegistry } from "./auth-registry";
import { CodexSessionClaimer } from "./codex-claim";
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
    | "workbench:list-role-manuals"
    | "workbench:save-role-manual"
    | "workbench:reset-role-manual"
    | "workbench:inbox-badges"
    | "workbench:list-briefs"
    | "workbench:read-brief"
    | "workbench:read-threads"
    | "workbench:open-ffpane"
    | "workbench:panel-activity"
  >;
  readonly mcpRegistry: WorkbenchMcpTempRegistry;
  readonly codexClaimer: CodexSessionClaimer;
  readonly tokenRegistry: WindowTokenRegistry;
  readonly authRegistry: WorkbenchAuthRegistry;
  readonly idleQueue: IdleDeliverQueue;
  readonly rolePromptTemps: RolePromptTempRegistry;
  readonly dispose: () => Promise<void>;
}

export interface WorkbenchCliLayerOptions {
  readonly manager: PtyManager;
  readonly getWindow: () => BrowserWindow | null;
  readonly getMaxWorkbenchWindows?: () => number | Promise<number>;
  /** 与 data 层共享的权威权限表；缺省则本层自建。 */
  readonly authRegistry?: WorkbenchAuthRegistry;
}

function mainModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * 装配 workbench:launch-cli；读全局数据根上的 Profile / Provider / 密钥。
 */
export async function createWorkbenchCliLayer(
  options: WorkbenchCliLayerOptions,
): Promise<WorkbenchCliLayer> {
  await cleanupStaleWorkbenchMcpDirs();

  const layout = await initGlobalLayout(resolveGlobalRoot());
  const profiles = createProfileStore(layout.profilesFile);
  const providers = createProviderStore(layout.providersFile);
  const config = createConfigStore(layout.configFile);
  const secrets = createSecretStore({
    backend: createSafeStorageBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  const mcpRegistry = new WorkbenchMcpTempRegistry();
  const rolePromptTemps = new RolePromptTempRegistry();
  const codexClaimer = new CodexSessionClaimer();
  const tokenRegistry = createWindowTokenRegistry();
  const authRegistry = options.authRegistry ?? createWorkbenchAuthRegistry();
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
      if (terminalId === undefined) {
        return;
      }
      idleQueue.noteHook(terminalId, signal, {
        ...(meta?.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
        ...(meta?.toolDigest !== undefined ? { toolDigest: meta.toolDigest } : {}),
      });
    },
    log: (message) => {
      console.error(`[wb-control] ${message}`);
    },
  });

  const lastProfileByRuntime = new Map<string, string>();
  const projects = createProjectRegistry(layout.projectsFile);
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
    getProfile: (id: string) => profiles.getProfile(id as never),
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
      readonly runtime: "claude-code" | "codex";
    }) => {
      const text = await composeWindowRolePrompt(resourcesDir, overridesDir, role);
      if (runtime === "claude-code") {
        const filePath = writeClaudeRolePromptFile(windowId, text);
        rolePromptTemps.track(windowId, filePath);
        return { claudePromptFile: filePath };
      }
      return { developerInstructions: text };
    },
    clampMax: clampMaxWorkbenchWindows,
    limitErrorPrefix: WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX,
    codexClaimer,
    controlPipe: control.address,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    idleQueue,
    onProfileUsed: (profileId: string, runtime: "claude-code" | "codex") => {
      lastProfileByRuntime.set(runtime, profileId);
    },
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
    onWindowLaunched: (windowId: string) =>
      reconcileManagerGrant(windowId).catch((error: unknown) => {
        console.error(`[wb-grant] ${String(error)}`);
      }),
  });

  const handlers: WorkbenchCliLayer["handlers"] = {
    "workbench:launch-cli": async (request) => {
      assertLaunchCliIpcSafe(request);
      const permission =
        request.permission !== undefined && isWorkbenchPermissionLevel(request.permission)
          ? request.permission
          : undefined;
      const result = await launchCliWindow(
        {
          windowId: request.windowId,
          projectId: request.projectId,
          projectRoot: request.projectRoot,
          profileId: request.profileId,
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
        profileName: result.profileName,
        ...(result.model !== undefined ? { model: result.model } : {}),
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
          resolveProfileId: async (cli, profileId) => {
            const runtime = cli === "claude" ? "claude-code" : "codex";
            const all = await profiles.listProfiles();
            if (profileId !== undefined && profileId.trim() !== "") {
              const found = all.find((item) => item.id === profileId && item.runtime === runtime);
              return found !== undefined
                ? { ok: true, profileId: found.id }
                : { ok: false, error: "找不到该 CLI 的启动配置。" };
            }
            const recent = lastProfileByRuntime.get(runtime);
            if (recent !== undefined && all.some((item) => item.id === recent)) {
              return { ok: true, profileId: recent };
            }
            const fallback = all.find((item) => item.runtime === runtime);
            return fallback !== undefined
              ? { ok: true, profileId: fallback.id }
              : { ok: false, error: "还没有适用于该 CLI 的启动配置。" };
          },
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
          void mcpRegistry.release(windowId);
          codexClaimer.cancel(windowId);
          releaseWindowHooks(windowId);
          void rolePromptTemps.release(windowId);
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
    rolePromptTemps,
    dispose: async () => {
      await control.close();
      idleQueue.dispose();
      codexClaimer.dispose();
      tokenRegistry.clear();
      authRegistry.clear();
      await mcpRegistry.releaseAll();
      await rolePromptTemps.releaseAll();
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
