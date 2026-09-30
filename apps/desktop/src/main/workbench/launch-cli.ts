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
} from "@ff-pane/adapters";
import {
  type AgentProfile,
  type ProjectId,
  resolveConnectionMode,
  resolveDispatchedReasoningEffort,
  runtimeToWorkbenchKind,
  workbenchKindToRuntime,
} from "@ff-pane/shared";
import { resolveRuntimeConfigOverrides, resolveRuntimeEnv } from "../session/env";
import { createKnowledgeAuditPath, resolveKnowledgeMcpServer } from "../session/knowledge-tool";
import type { PtyManager } from "../terminal/manager";
import type { TerminalRecord } from "../terminal/types";
import {
  assertSecretAbsent,
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
  CLAUDE_INTERACTIVE_COMMAND,
  CODEX_INTERACTIVE_COMMAND,
} from "./cli-args";
import type { CodexSessionClaimer } from "./codex-claim";
import {
  type WorkbenchMcpTempFile,
  WorkbenchMcpTempRegistry,
  writeWorkbenchClaudeMcpFile,
} from "./mcp-temp";

/** initialPrompt IPC 上限（字节按 UTF-16 码元计；更长内容走 T10.7 briefs）。 */
export const MAX_INITIAL_PROMPT_CHARS = 32 * 1024;

export class WorkbenchCliLaunchError extends Error {
  readonly code:
    | "profile-not-found"
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
  readonly profileId: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly initialPrompt?: string;
  /** true = 续接（Claude 用 nativeSessionId；Codex 有 id 用 id，否则打开选择器）。 */
  readonly resume?: boolean;
  /** 渲染端已保存的原生会话 id（续接时传入）。 */
  readonly nativeSessionId?: string;
}

export interface LaunchCliWindowResult {
  readonly terminal: TerminalRecord;
  readonly kind: "claude" | "codex";
  readonly nativeSessionId?: string;
  /** Codex：已开始后台认领会话 id。 */
  readonly claimingSession?: boolean;
  /** Codex 续接且无 id：已打开 resume 选择器。 */
  readonly resumePicker?: boolean;
  readonly profileName: string;
  readonly model?: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface LaunchCliWindowDeps {
  readonly manager: PtyManager;
  readonly getProfile: (id: string) => Promise<AgentProfile | undefined>;
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
}

export { WorkbenchMcpTempRegistry };

/** IPC：拒绝 renderer 传入 args/env/可执行路径等危险字段；校验 initialPrompt 长度。 */
export function assertLaunchCliIpcSafe(request: object): void {
  const raw = request as Record<string, unknown>;
  for (const key of ["args", "env", "shell", "executable", "command", "file", "path"] as const) {
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

/**
 * 组装并启动 CLI 窗口。返回的 args 可供单测快照；密钥不在其中。
 */
export async function launchCliWindow(
  input: LaunchCliWindowInput,
  deps: LaunchCliWindowDeps,
): Promise<LaunchCliWindowResult> {
  const profile = await deps.getProfile(input.profileId);
  if (profile === undefined) {
    throw new WorkbenchCliLaunchError("profile-not-found", `profile not found: ${input.profileId}`);
  }
  const kind = runtimeToWorkbenchKind(profile.runtime);
  if (kind === undefined) {
    throw new WorkbenchCliLaunchError(
      "unsupported-runtime",
      `profile runtime ${profile.runtime} is not a workbench CLI`,
    );
  }
  const runtime = workbenchKindToRuntime(kind);
  const provider = await deps.getProvider(profile.providerId);
  if (provider === undefined) {
    throw new WorkbenchCliLaunchError(
      "provider-not-found",
      `provider not found: ${profile.providerId}`,
    );
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
  const model =
    profile.model?.trim() ||
    (provider.defaultModelId !== undefined && provider.defaultModelId.trim() !== ""
      ? provider.defaultModelId.trim()
      : undefined);
  const effort = resolveDispatchedReasoningEffort({
    runtime,
    reasoningEffort: profile.reasoningEffort,
  });
  const connectionMode = resolveConnectionMode(profile.connectionMode, provider.templateId);

  let secret: string | undefined;
  if (
    connectionMode !== "local_cli" &&
    provider.apiKeyRef !== undefined &&
    provider.apiKeyRef.length > 0
  ) {
    secret = await deps.revealSecret(provider.apiKeyRef);
  }

  const injectEnv = resolveRuntimeEnv({
    runtime,
    provider: provider as never,
    ...(secret !== undefined ? { apiKeyPlaintext: secret } : {}),
    connectionMode,
    ...(model !== undefined ? { model } : {}),
  });
  const configOverrides = resolveRuntimeConfigOverrides({
    runtime,
    provider: provider as never,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    connectionMode,
  });

  const mcpServers = await resolveKnowledgeServers(deps, input.projectRoot);
  let mcpTemp: WorkbenchMcpTempFile | undefined;
  const cwd = (input.cwd?.trim() || input.projectRoot).trim();

  let nativeSessionId: string | undefined = input.nativeSessionId?.trim() || undefined;
  let args: string[];
  let claimingSession = false;
  let resumePicker = false;

  if (runtime === "claude-code") {
    if (Object.keys(mcpServers).length > 0) {
      mcpTemp = writeWorkbenchClaudeMcpFile(mcpServers);
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
      ...(mcpTemp !== undefined ? { mcpConfigPath: mcpTemp.path, strictMcp: true } : {}),
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    });
  } else {
    const mcpOverrides =
      Object.keys(mcpServers).length > 0 ? buildCodexMcpOverrides(mcpServers) : {};
    const mergedOverrides = { ...configOverrides, ...mcpOverrides };
    const resuming = input.resume === true;
    if (resuming && nativeSessionId === undefined) {
      resumePicker = true;
    }
    args = buildInteractiveCodexArgs({
      cwd,
      ...(model !== undefined ? { model } : {}),
      ...(Object.keys(mergedOverrides).length > 0 ? { configOverrides: mergedOverrides } : {}),
      ...(resuming ? { resume: true } : {}),
      ...(resuming && nativeSessionId !== undefined ? { resumeSessionId: nativeSessionId } : {}),
      ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    });
  }

  assertSecretAbsent(secret, args);
  if (mcpTemp !== undefined) {
    assertSecretAbsent(secret, [readFileSync(mcpTemp.path, "utf8")]);
  }

  const direct = resolveDirectCliTarget(command, args, process.env);
  if (direct === undefined) {
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
        profileId: profile.id,
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      },
    });
  } catch (error) {
    if (mcpTemp !== undefined) {
      await deps.mcpRegistry.release(input.windowId);
    }
    throw error;
  }

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

  return {
    terminal,
    kind,
    ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    ...(claimingSession ? { claimingSession: true } : {}),
    ...(resumePicker ? { resumePicker: true } : {}),
    profileName: profile.name,
    ...(model !== undefined ? { model } : {}),
    command: direct.resolvedCommand,
    args: [...direct.args],
  };
}

/** 主进程模块目录（knowledge-mcp.js 与 main 同目录）。 */
export function resolveMainModuleDir(importMetaUrl = import.meta.url): string {
  return dirname(fileURLToPath(importMetaUrl));
}
