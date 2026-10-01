/**
 * 工作台 CLI 窗口启动器（T10.4）：在 PTY 中直接跑 Claude Code / Codex。
 * 密钥只经 env；renderer 不得传入 args/env/可执行路径。
 * Windows：解析 npm shim 真实目标，参数数组直启，绕开 cmd.exe。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildAgentEnv,
  buildCodexMcpOverrides,
  type McpStdioServerSpec,
  resolveDirectCliTarget,
  resolveHookNodeExecutable,
} from "@ff-pane/adapters";
import {
  FF_PANE_WB_PIPE_ENV,
  FF_PANE_WINDOW_TOKEN_ENV,
  injectTokenIntoMcpServers,
  type WindowTokenRegistry,
} from "@ff-pane/core";
import {
  DEFAULT_WORKBENCH_ROLE,
  isWorkbenchRole,
  type ProjectId,
  resolveDispatchedReasoningEffort,
  type WorkbenchPermissionLevel,
  type WorkbenchRole,
  workbenchKindToRuntime,
} from "@ff-pane/shared";
import { resolveRuntimeConfigOverrides, resolveRuntimeEnv } from "../session/env";
import { createKnowledgeAuditPath, resolveKnowledgeMcpServer } from "../session/knowledge-tool";
import type { PtyManager } from "../terminal/manager";
import type { TerminalRecord } from "../terminal/types";
import type { WorkbenchAuthRegistry } from "./auth-registry";
import {
  assertSecretAbsent,
  assertTokenAbsent,
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
  CLAUDE_INTERACTIVE_COMMAND,
  CODEX_INTERACTIVE_COMMAND,
} from "./cli-args";
import type { CodexSessionClaimer } from "./codex-claim";
import {
  prepareWindowHooks,
  releaseWindowHooks,
  resolveWorkbenchHookScriptPath,
} from "./hook-launch";
import type { IdleDeliverQueue } from "./idle-deliver";
import { createWindowLaunchGate } from "./launch-gate";
import { buildWorkbenchMcpSpec, WORKBENCH_MCP_SERVER_NAME } from "./mcp-server-spec";
import {
  type WorkbenchMcpTempFile,
  WorkbenchMcpTempRegistry,
  writeWorkbenchClaudeMcpFile,
} from "./mcp-temp";
import type { LaunchCliRoute } from "./resolve-config";

/** initialPrompt IPC 上限（字节按 UTF-16 码元计；更长内容走 T10.7 briefs）。 */
export const MAX_INITIAL_PROMPT_CHARS = 32 * 1024;

export class WorkbenchCliLaunchError extends Error {
  readonly code:
    | "profile-not-found"
    | "route-missing"
    | "provider-not-found"
    | "unsupported-runtime"
    | "cli-missing"
    | "cli-unresolvable"
    | "ipc-rejected"
    | "limit"
    | "invalid"
    | "prompt-too-long";

  constructor(code: WorkbenchCliLaunchError["code"], message: string) {
    super(message);
    this.name = "WorkbenchCliLaunchError";
    this.code = code;
  }
}

export interface LaunchCliWindowInput {
  readonly windowId: string;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly kind: "claude" | "codex";
  /** 已按项目配置解析好的这一路。本机登录不带 providerId。 */
  readonly route: LaunchCliRoute;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly initialPrompt?: string;
  /** true = 续接（Claude 用 nativeSessionId；Codex 有 id 用 id，否则打开选择器）。 */
  readonly resume?: boolean;
  /** 渲染端已保存的原生会话 id（续接时传入）。 */
  readonly nativeSessionId?: string;
  /** T10.5：窗口权限等级（缺省 edit）。 */
  readonly permission?: WorkbenchPermissionLevel;
  /** T10.6：窗口角色。登记表已有角色时以登记表为准。 */
  readonly role?: WorkbenchRole;
}

export interface LaunchCliWindowResult {
  readonly terminal: TerminalRecord;
  readonly kind: "claude" | "codex";
  readonly nativeSessionId?: string;
  /** Codex：已开始后台认领会话 id。 */
  readonly claimingSession?: boolean;
  /** Codex 续接且无 id：已打开 resume 选择器。 */
  readonly resumePicker?: boolean;
  readonly configName: string;
  readonly connectionMode: "local_cli" | "relay";
  readonly providerName?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly command: string;
  readonly args: readonly string[];
  /** T10.5'：实际生效权限（可能被祖先封顶）。 */
  readonly effectivePermission: WorkbenchPermissionLevel;
  /** T10.5'：请求权限高于祖先上限时为 true。 */
  readonly permissionCapped: boolean;
  /** 装上了 node 直启的回合信号时为 auto；否则投递一直要手动确认。 */
  readonly turnSignal: "auto" | "manual";
}

export interface LaunchCliWindowDeps {
  readonly manager: PtyManager;
  readonly getProvider: (id: string) => Promise<
    | {
        readonly id: string;
        readonly name: string;
        readonly templateId: string;
        readonly baseUrl?: string;
        readonly apiKeyRef?: string;
        readonly defaultModelId?: string;
        readonly extraEnv?: Readonly<Record<string, string>>;
        readonly options?: Readonly<Record<string, string>>;
      }
    | undefined
  >;
  readonly revealSecret: (ref: string) => Promise<string | undefined>;
  readonly getMaxWorkbenchWindows: () => number | Promise<number>;
  readonly isKnowledgeToolEnabled: (projectRoot: string) => Promise<boolean>;
  readonly getKnowledgeToolSettings: () => Promise<
    | {
        readonly command?: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
        readonly serverName?: string;
      }
    | undefined
  >;
  readonly indexDbFile: string;
  readonly moduleDir: string;
  readonly mcpRegistry: WorkbenchMcpTempRegistry;
  readonly clampMax: (value: unknown) => number;
  readonly limitErrorPrefix: string;
  readonly codexClaimer?: CodexSessionClaimer;
  readonly onCodexSessionClaimed?: (windowId: string, nativeSessionId: string) => void;
  readonly now?: () => number;
  /** T10.5：窗口身份令牌注册表。 */
  readonly tokenRegistry: WindowTokenRegistry;
  /** T10.5'：权威权限树（封顶）；缺省则按请求权限启动。 */
  readonly authRegistry?: WorkbenchAuthRegistry;
  /**
   * T10.6：按角色合成系统提示。
   * Claude 返回临时文件路径；Codex 返回要追加的 developer_instructions 正文。
   */
  readonly loadRoleInjection?: (input: {
    readonly windowId: string;
    readonly role: WorkbenchRole;
    readonly runtime: "claude-code" | "codex";
  }) => Promise<{
    readonly claudePromptFile?: string;
    readonly developerInstructions?: string;
  }>;
  /** 控制通道管道名。写入 CLI 环境 FF_PANE_WB_PIPE，不进 argv。 */
  readonly controlPipe?: string;
  /** 启动成功后登记空闲投递会话（无 initialPrompt 仍保持未知，直到 hook）。 */
  readonly idleQueue?: IdleDeliverQueue;
  /** PTY 已起来、权威表已写回之后。用来恢复管理权，失败不得当成启动失败。 */
  readonly onWindowLaunched?: (windowId: string) => Promise<void> | void;
  /** 观察型 hook 脚本。缺省按打包态选 resources 或 moduleDir 下的 workbench-hook.mjs。 */
  readonly hookScriptPath?: string;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}

export { WorkbenchMcpTempRegistry };

/** IPC：拒绝 renderer 传入 args/env/可执行路径/父级等危险字段；校验 initialPrompt 长度。 */
export function assertLaunchCliIpcSafe(request: object): void {
  const raw = request as Record<string, unknown>;
  for (const key of [
    "args",
    "env",
    "shell",
    "executable",
    "command",
    "file",
    "path",
    "parentWindowId",
    "openedBy",
  ] as const) {
    if (raw[key] !== undefined) {
      throw new WorkbenchCliLaunchError(
        "ipc-rejected",
        `workbench:launch-cli rejects field "${key}" from renderer`,
      );
    }
  }
  const prompt = raw["initialPrompt"];
  if (typeof prompt === "string" && prompt.length > MAX_INITIAL_PROMPT_CHARS) {
    throw new WorkbenchCliLaunchError(
      "prompt-too-long",
      `initialPrompt exceeds ${MAX_INITIAL_PROMPT_CHARS} characters`,
    );
  }
}

function resolveCliCommand(runtime: "claude-code" | "codex"): string {
  return runtime === "claude-code" ? CLAUDE_INTERACTIVE_COMMAND : CODEX_INTERACTIVE_COMMAND;
}

async function resolveKnowledgeServers(
  deps: LaunchCliWindowDeps,
  projectRoot: string,
): Promise<Readonly<Record<string, McpStdioServerSpec>>> {
  if (!(await deps.isKnowledgeToolEnabled(projectRoot))) {
    return {};
  }
  try {
    const auditPath = await createKnowledgeAuditPath();
    const settings = await deps.getKnowledgeToolSettings();
    const { serverName, spec } = resolveKnowledgeMcpServer({
      moduleDir: deps.moduleDir,
      indexDbFile: deps.indexDbFile,
      auditPath,
      ...(settings !== undefined ? { settings } : {}),
    });
    return { [serverName]: spec };
  } catch {
    return {};
  }
}

const cliLaunchGate = createWindowLaunchGate();

/**
 * 组装并启动 CLI 窗口。返回的 args 可供单测快照；密钥不在其中。
 * 同一 windowId 已有启动在飞时，后来的调用复用那一次，不再开第二个 PTY。
 */
export function launchCliWindow(
  input: LaunchCliWindowInput,
  deps: LaunchCliWindowDeps,
): Promise<LaunchCliWindowResult> {
  return cliLaunchGate.run(input.windowId, () => launchCliWindowBody(input, deps));
}

async function launchCliWindowBody(
  input: LaunchCliWindowInput,
  deps: LaunchCliWindowDeps,
): Promise<LaunchCliWindowResult> {
  const kind = input.kind;
  const runtime = workbenchKindToRuntime(kind);
  const route = input.route;
  let provider: Awaited<ReturnType<LaunchCliWindowDeps["getProvider"]>>;
  if (route.connectionMode === "relay") {
    if (route.providerId === undefined || route.providerId.trim() === "") {
      throw new WorkbenchCliLaunchError("provider-not-found", "relay route is missing a provider");
    }
    provider = await deps.getProvider(route.providerId);
    if (provider === undefined) {
      throw new WorkbenchCliLaunchError(
        "provider-not-found",
        `provider not found: ${route.providerId}`,
      );
    }
  }

  const max = deps.clampMax(await deps.getMaxWorkbenchWindows());
  if (deps.manager.aliveCount() >= max) {
    throw new WorkbenchCliLaunchError("limit", `${deps.limitErrorPrefix} ${max}`);
  }

  if (input.initialPrompt !== undefined && input.initialPrompt.length > MAX_INITIAL_PROMPT_CHARS) {
    throw new WorkbenchCliLaunchError(
      "prompt-too-long",
      `initialPrompt exceeds ${MAX_INITIAL_PROMPT_CHARS} characters`,
    );
  }

  const command = resolveCliCommand(runtime);
  const model = route.model?.trim() || undefined;
  const effort = resolveDispatchedReasoningEffort({
    runtime,
    reasoningEffort: route.reasoningEffort,
  });
  const connectionMode = route.connectionMode;

  let secret: string | undefined;
  let injectEnv: Record<string, string> = {};
  let configOverrides: Record<string, string> = {};
  if (connectionMode === "local_cli") {
    if (effort !== undefined && runtime === "codex") {
      configOverrides = { model_reasoning_effort: JSON.stringify(effort) };
    }
  } else if (provider !== undefined) {
    if (provider.apiKeyRef !== undefined && provider.apiKeyRef.length > 0) {
      secret = await deps.revealSecret(provider.apiKeyRef);
    }
    injectEnv = resolveRuntimeEnv({
      runtime,
      provider: provider as never,
      ...(secret !== undefined ? { apiKeyPlaintext: secret } : {}),
      connectionMode,
      ...(model !== undefined ? { model } : {}),
    });
    configOverrides = resolveRuntimeConfigOverrides({
      runtime,
      provider: provider as never,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      connectionMode,
    });
  }

  const mcpServers: Record<string, McpStdioServerSpec> = {
    ...(await resolveKnowledgeServers(deps, input.projectRoot)),
    [WORKBENCH_MCP_SERVER_NAME]: buildWorkbenchMcpSpec(deps.moduleDir),
  };
  const requestedPermission: WorkbenchPermissionLevel = input.permission ?? "edit";
  const launchAuth = deps.authRegistry?.resolveLaunch(input.windowId, requestedPermission) ?? {
    effective: requestedPermission,
    capped: false,
    cycle: false,
  };
  const permission = launchAuth.cycle ? "read-only" : launchAuth.effective;
  const permissionCapped =
    launchAuth.capped || launchAuth.cycle || permission !== requestedPermission;
  const registered = deps.authRegistry?.get(input.windowId);
  const role: WorkbenchRole =
    registered?.role ?? (isWorkbenchRole(input.role) ? input.role : DEFAULT_WORKBENCH_ROLE);
  if (deps.authRegistry !== undefined && registered === undefined) {
    deps.authRegistry.upsert(
      {
        id: input.windowId,
        permission,
        openedBy: "user",
        role,
      },
      input.projectId,
    );
  }
  const roleInjection =
    deps.loadRoleInjection !== undefined
      ? await deps.loadRoleInjection({ windowId: input.windowId, role, runtime })
      : {};
  const windowToken = deps.tokenRegistry.issue(input.windowId);
  const probed = resolveDirectCliTarget(command, [], process.env);
  const nodePath = resolveHookNodeExecutable(process.env, probed);
  const scriptPath =
    deps.hookScriptPath ??
    resolveWorkbenchHookScriptPath({
      isPackaged: deps.isPackaged === true,
      resourcesPath: deps.resourcesPath ?? "",
      moduleDir: deps.moduleDir,
    });
  const hooks = prepareWindowHooks({
    windowId: input.windowId,
    nodePath,
    scriptPath,
  });
  const releaseFailedLaunch = async (): Promise<void> => {
    releaseWindowHooks(input.windowId);
    deps.tokenRegistry.revoke(input.windowId);
    if (mcpTemp !== undefined) {
      await deps.mcpRegistry.release(input.windowId);
    }
  };

  let mcpTemp: WorkbenchMcpTempFile | undefined;
  const cwd = (input.cwd?.trim() || input.projectRoot).trim();

  let nativeSessionId: string | undefined = input.nativeSessionId?.trim() || undefined;
  let args: string[];
  let claimingSession = false;
  let resumePicker = false;

  if (runtime === "claude-code") {
    let serversForMcp = mcpServers;
    if (Object.keys(mcpServers).length > 0) {
      // 文件只写 ${FF_PANE_WINDOW_TOKEN}；真实值仅在 CLI 进程 env，由 Claude 展开后交给 MCP
      serversForMcp = injectTokenIntoMcpServers(mcpServers, windowToken, "claude-env-expand");
      mcpTemp = writeWorkbenchClaudeMcpFile(serversForMcp);
      deps.mcpRegistry.track(input.windowId, mcpTemp);
    }
    const resuming = input.resume === true && nativeSessionId !== undefined;
    if (!resuming) {
      nativeSessionId = randomUUID();
    }
    args = buildInteractiveClaudeArgs({
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(resuming && nativeSessionId !== undefined
        ? { resumeSessionId: nativeSessionId }
        : nativeSessionId !== undefined
          ? { sessionId: nativeSessionId }
          : {}),
      permission,
      ...(mcpTemp !== undefined ? { mcpConfigPath: mcpTemp.path, strictMcp: true } : {}),
      ...(roleInjection.claudePromptFile !== undefined
        ? { appendSystemPromptFile: roleInjection.claudePromptFile }
        : {}),
      ...(hooks.settingsPath !== undefined ? { settingsFile: hooks.settingsPath } : {}),
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    });
  } else {
    let serversForMcp = mcpServers;
    if (Object.keys(mcpServers).length > 0) {
      serversForMcp = injectTokenIntoMcpServers(mcpServers, windowToken, "codex-forward");
    }
    const mcpOverrides =
      Object.keys(serversForMcp).length > 0 ? buildCodexMcpOverrides(serversForMcp) : {};
    const mergedOverrides = { ...configOverrides, ...mcpOverrides };
    const resuming = input.resume === true;
    if (resuming && nativeSessionId === undefined) {
      resumePicker = true;
    }
    args = buildInteractiveCodexArgs({
      cwd,
      ...(model !== undefined ? { model } : {}),
      permission,
      ...(Object.keys(mergedOverrides).length > 0 ? { configOverrides: mergedOverrides } : {}),
      ...(resuming ? { resume: true } : {}),
      ...(resuming && nativeSessionId !== undefined ? { resumeSessionId: nativeSessionId } : {}),
      ...(roleInjection.developerInstructions !== undefined
        ? { developerInstructions: roleInjection.developerInstructions }
        : {}),
      ...(hooks.notifyArgv.length > 0 ? { notifyArgv: hooks.notifyArgv } : {}),
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    });
  }

  try {
    assertSecretAbsent(secret, [
      ...args,
      roleInjection.developerInstructions ?? "",
      roleInjection.claudePromptFile ?? "",
    ]);
    assertTokenAbsent(windowToken, args);
    if (mcpTemp !== undefined) {
      const mcpContents = readFileSync(mcpTemp.path, "utf8");
      assertSecretAbsent(secret, [mcpContents]);
      // Claude MCP 临时文件不得含令牌明文（仅 ${FF_PANE_WINDOW_TOKEN} 占位符）
      assertTokenAbsent(windowToken, [mcpContents]);
    }
    if (roleInjection.claudePromptFile !== undefined) {
      const promptBody = readFileSync(roleInjection.claudePromptFile, "utf8");
      assertSecretAbsent(secret, [promptBody]);
      assertTokenAbsent(windowToken, [promptBody]);
    }
    for (const hookFile of hooks.files) {
      const hookBody = readFileSync(hookFile, "utf8");
      assertSecretAbsent(secret, [hookBody]);
      assertTokenAbsent(windowToken, [hookBody]);
    }
  } catch (error) {
    await releaseFailedLaunch();
    throw error;
  }

  const direct = resolveDirectCliTarget(command, args, process.env);
  if (direct === undefined) {
    await releaseFailedLaunch();
    throw new WorkbenchCliLaunchError(
      process.platform === "win32" ? "cli-unresolvable" : "cli-missing",
      process.platform === "win32"
        ? `Cannot resolve ${command} to a native executable or node script (refusing cmd.exe fallback)`
        : `CLI not found on PATH: ${command}`,
    );
  }

  const { env } = buildAgentEnv({ inject: injectEnv, stripApiKeyEnv: true });
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      stringEnv[key] = value;
    }
  }
  stringEnv[FF_PANE_WINDOW_TOKEN_ENV] = windowToken;
  if (deps.controlPipe !== undefined && deps.controlPipe.trim() !== "") {
    stringEnv[FF_PANE_WB_PIPE_ENV] = deps.controlPipe;
  }

  const startedAtMs = deps.now?.() ?? Date.now();
  let terminal: TerminalRecord;
  try {
    terminal = deps.manager.create({
      cwd,
      direct: {
        file: direct.file,
        args: direct.args,
        label: direct.resolvedCommand,
      },
      env: stringEnv,
      cols: input.cols,
      rows: input.rows,
      metadata: {
        windowId: input.windowId,
        projectId: input.projectId,
        kind,
        configId: route.configId,
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      },
    });
  } catch (error) {
    await releaseFailedLaunch();
    throw error;
  }

  // 把本窗生效权限写回权威表（保留已有父级；顶层无父）
  if (deps.authRegistry !== undefined) {
    const prior = deps.authRegistry.get(input.windowId);
    deps.authRegistry.upsert(
      {
        id: input.windowId,
        permission,
        openedBy: prior?.openedBy ?? "user",
        ...(prior?.parentWindowId !== undefined ? { parentWindowId: prior.parentWindowId } : {}),
        ...(prior?.parentClosed === true ? { parentClosed: true } : {}),
        ...(permissionCapped ? { permissionNeedsDowngrade: true } : {}),
        role,
      },
      input.projectId,
    );
  }

  deps.idleQueue?.attach(terminal.id, {
    windowId: input.windowId,
    initialPrompt: input.initialPrompt !== undefined && input.initialPrompt.trim() !== "",
  });

  if (runtime === "codex" && input.resume !== true && deps.codexClaimer !== undefined) {
    claimingSession = true;
    const claimer = deps.codexClaimer;
    const windowId = input.windowId;
    // 同步启动认领（首行扫描已廉价）；假 CLI 秒退时也能在 cancel 前完成认领
    void claimer
      .start({ windowId, cwd, startedAtMs })
      .then((id) => {
        if (id === undefined) {
          return;
        }
        deps.onCodexSessionClaimed?.(windowId, id);
      })
      .catch(() => undefined);
  }

  await deps.onWindowLaunched?.(input.windowId);
  return {
    terminal,
    kind,
    ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    ...(claimingSession ? { claimingSession: true } : {}),
    ...(resumePicker ? { resumePicker: true } : {}),
    configName: route.configName,
    connectionMode,
    ...(route.providerName !== undefined ? { providerName: route.providerName } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    command: direct.resolvedCommand,
    args: [...direct.args],
    effectivePermission: permission,
    permissionCapped,
    turnSignal: nodePath === undefined ? "manual" : "auto",
  };
}

/** 主进程模块目录（knowledge-mcp.js 与 main 同目录）。 */
export function resolveMainModuleDir(importMetaUrl = import.meta.url): string {
  return dirname(fileURLToPath(importMetaUrl));
}
