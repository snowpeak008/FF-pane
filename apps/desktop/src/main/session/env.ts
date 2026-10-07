/**
 * Run 级密钥注入映射（T4.2 / T10.3）。
 *
 * claude-code / codex：委托 @ff-pane/core resolveProviderInjection（表驱动）。
 * 其它 Runtime：保留旧 switch 路径（Grok 等本阶段不改坏）。
 */

import { ProviderInjectionError, resolveProviderInjection } from "@ff-pane/core";
import {
  type ConnectionMode,
  isLocalLoginProvider,
  type Provider,
  type ProviderTemplateCli,
  type RuntimeId,
  resolveConnectionMode,
  resolveDispatchedReasoningEffort,
} from "@ff-pane/shared";

/** 各 Runtime 读取 API 密钥的环境变量名（旧路径 / 非 claude·codex）。 */
export function runtimeApiKeyEnvVar(runtime: RuntimeId): string | undefined {
  switch (runtime) {
    case "codex":
      return "OPENAI_API_KEY";
    case "claude-code":
      return "ANTHROPIC_API_KEY";
    case "gemini-cli":
      return "GEMINI_API_KEY";
    case "grok-build":
      return "XAI_API_KEY";
    case "aider":
      return "OPENAI_API_KEY";
    case "qwen-code":
      return "OPENAI_API_KEY";
    case "iflow":
      return "IFLOW_API_KEY";
    default:
      return undefined;
  }
}

function runtimeBaseUrlEnvVar(runtime: RuntimeId): string | undefined {
  switch (runtime) {
    case "iflow":
      return "IFLOW_BASE_URL";
    case "codex":
    case "aider":
    case "qwen-code":
      return "OPENAI_BASE_URL";
    case "claude-code":
      return "ANTHROPIC_BASE_URL";
    case "gemini-cli":
      return "GEMINI_API_BASE";
    case "grok-build":
      return "XAI_BASE_URL";
    default:
      return undefined;
  }
}

function asTemplateCli(runtime: RuntimeId): ProviderTemplateCli | undefined {
  if (
    runtime === "claude-code" ||
    runtime === "codex" ||
    runtime === "grok" ||
    runtime === "deepseek"
  ) {
    return runtime;
  }
  return undefined;
}

/** 旧路径：非 claude/codex Runtime 的 env 组装。 */
function resolveLegacyRuntimeEnv(input: {
  readonly runtime: RuntimeId;
  readonly provider: Provider;
  readonly apiKeyPlaintext?: string;
  readonly connectionMode?: ConnectionMode;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const { runtime, provider, apiKeyPlaintext } = input;
  const mode = resolveConnectionMode(input.connectionMode, provider.templateId);

  if (mode === "local_cli" || isLocalLoginProvider(provider)) {
    return env;
  }

  if (apiKeyPlaintext !== undefined && apiKeyPlaintext.length > 0) {
    const keyVar = runtimeApiKeyEnvVar(runtime);
    if (keyVar !== undefined) {
      env[keyVar] = apiKeyPlaintext;
    }
  }

  if (provider.baseUrl !== undefined && provider.baseUrl.length > 0) {
    const urlVar = runtimeBaseUrlEnvVar(runtime);
    if (urlVar !== undefined) {
      env[urlVar] = provider.baseUrl;
    }
  }

  return env;
}

/**
 * 组装本轮运行时配置覆盖（AdapterTurnContext.configOverrides）。
 * claude-code / codex 走解析器；其它 Runtime 仅可能带 reasoning effort（codex 已含）。
 */
export function resolveRuntimeConfigOverrides(input: {
  readonly runtime: RuntimeId;
  readonly provider: Provider;
  readonly reasoningEffort?: string;
  readonly connectionMode?: ConnectionMode;
}): Record<string, string> {
  const { runtime, provider } = input;
  const mode = resolveConnectionMode(input.connectionMode, provider.templateId);
  const overrides: Record<string, string> = {};

  const cli = asTemplateCli(runtime);
  if (cli !== undefined && mode === "relay" && !isLocalLoginProvider(provider)) {
    try {
      const injection = resolveProviderInjection({
        provider,
        cli,
        ...(provider.defaultModelId !== undefined ? { model: provider.defaultModelId } : {}),
      });
      Object.assign(overrides, injection.configOverrides);
    } catch (error) {
      if (!(error instanceof ProviderInjectionError)) {
        throw error;
      }
      // unsupported-cli / missing-base-url：不写路由（与旧行为一致）
    }
  }

  const effort = resolveDispatchedReasoningEffort({
    runtime,
    reasoningEffort: input.reasoningEffort,
  });
  if (effort !== undefined && runtime === "codex") {
    overrides["model_reasoning_effort"] = JSON.stringify(effort);
  }
  return overrides;
}

/**
 * 组装本轮注入环境变量。
 * claude-code / codex → resolveProviderInjection；其它 Runtime 走旧路径。
 */
export function resolveRuntimeEnv(input: {
  readonly runtime: RuntimeId;
  readonly provider: Provider;
  readonly apiKeyPlaintext?: string;
  readonly connectionMode?: ConnectionMode;
  readonly model?: string;
}): Record<string, string> {
  const { runtime, provider, apiKeyPlaintext } = input;
  const mode = resolveConnectionMode(input.connectionMode, provider.templateId);

  if (mode === "local_cli") {
    return {};
  }

  if (isLocalLoginProvider(provider)) {
    const cli = asTemplateCli(runtime);
    if (cli !== undefined) {
      try {
        return { ...resolveProviderInjection({ provider, cli }).env };
      } catch {
        return {};
      }
    }
    return {};
  }

  const cli = asTemplateCli(runtime);
  if (cli !== undefined) {
    try {
      const injection = resolveProviderInjection({
        provider,
        cli,
        ...(apiKeyPlaintext !== undefined ? { secret: apiKeyPlaintext } : {}),
        ...(input.model !== undefined
          ? { model: input.model }
          : provider.defaultModelId !== undefined
            ? { model: provider.defaultModelId }
            : {}),
      });
      return { ...injection.env };
    } catch (error) {
      if (
        error instanceof ProviderInjectionError &&
        (error.code === "unsupported-cli" || error.code === "missing-base-url")
      ) {
        return resolveLegacyRuntimeEnv(input);
      }
      throw error;
    }
  }

  return resolveLegacyRuntimeEnv(input);
}
