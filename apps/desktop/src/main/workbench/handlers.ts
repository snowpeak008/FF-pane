/**
 * 工作台 CLI 启动 IPC（T10.4 / T10.4' / T10.5'）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowTokenRegistry, type WindowTokenRegistry } from "@ff-pane/core";
import {
  clampMaxWorkbenchWindows,
  isWorkbenchPermissionLevel,
  type Provider,
} from "@ff-pane/shared";
import {
  createConfigStore,
  createProfileStore,
  createProjectSettingsStore,
  createProviderStore,
  initGlobalLayout,
  resolveGlobalLayout,
  resolveProjectLayout,
} from "@ff-pane/storage";
import type { BrowserWindow } from "electron";
import type { InvokeHandlers } from "../../shared-ipc/server";
import { publishEvent } from "../../shared-ipc/server";
import { resolveGlobalRoot } from "../data-root";
import { createSafeStorageBackend, createSecretStore, resolveSecretsFile } from "../secrets";
import { WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX } from "../terminal/handlers";
import type { PtyManager } from "../terminal/manager";
import { createWorkbenchAuthRegistry, type WorkbenchAuthRegistry } from "./auth-registry";
import { CodexSessionClaimer } from "./codex-claim";
import { assertLaunchCliIpcSafe, launchCliWindow, WorkbenchMcpTempRegistry } from "./launch-cli";
import { cleanupStaleWorkbenchMcpDirs } from "./mcp-temp";

export interface WorkbenchCliLayer {
  readonly handlers: Pick<InvokeHandlers, "workbench:launch-cli">;
  readonly mcpRegistry: WorkbenchMcpTempRegistry;
  readonly codexClaimer: CodexSessionClaimer;
  readonly tokenRegistry: WindowTokenRegistry;
  readonly authRegistry: WorkbenchAuthRegistry;
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
  const codexClaimer = new CodexSessionClaimer();
  const tokenRegistry = createWindowTokenRegistry();
  const authRegistry = options.authRegistry ?? createWorkbenchAuthRegistry();
  const getMax =
    options.getMaxWorkbenchWindows ?? (async () => (await config.readConfig()).maxWorkbenchWindows);

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
        },
        {
          manager: options.manager,
          getProfile: (id) => profiles.getProfile(id as never),
          getProvider: async (id) => {
            const provider = await providers.getProvider(id as never);
            return provider as Provider | undefined;
          },
          revealSecret: async (ref) => {
            try {
              return await secrets.revealSecret(ref as never);
            } catch {
              return undefined;
            }
          },
          getMaxWorkbenchWindows: getMax,
          isKnowledgeToolEnabled: async (projectRoot) => {
            try {
              const projectLayout = resolveProjectLayout(projectRoot);
              const settings = await createProjectSettingsStore(
                projectLayout.projectFile,
              ).readSettings();
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
          clampMax: clampMaxWorkbenchWindows,
          limitErrorPrefix: WORKBENCH_WINDOW_LIMIT_ERROR_PREFIX,
          codexClaimer,
          onCodexSessionClaimed: (windowId, nativeSessionId) => {
            const window = options.getWindow();
            if (window === null || window.isDestroyed()) {
              return;
            }
            publishEvent(window.webContents, "workbench:session-claimed", {
              windowId,
              nativeSessionId,
            });
          },
        },
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
      };
    },
  };

  return {
    handlers,
    mcpRegistry,
    codexClaimer,
    tokenRegistry,
    authRegistry,
    dispose: async () => {
      codexClaimer.dispose();
      tokenRegistry.clear();
      authRegistry.clear();
      await mcpRegistry.releaseAll();
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
  }
}
