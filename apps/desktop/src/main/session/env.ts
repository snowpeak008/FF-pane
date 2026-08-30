/**
 * Run 级密钥注入映射（T4.2，设计文档 §4.3 密钥红线）。
 *
 * 唯一的密钥下发通道是 AdapterTurnContext.env（见 adapter.ts）。本模块把
 * Provider 的密钥引用解密所得明文，按 Runtime 约定的环境变量名装进注入表。
 * 纯逻辑：解密动作由调用方（持有 secrets store）完成后把明文传进来，
 * 本模块不接触密钥库、不记录明文。
 */

import type { Provider, RuntimeId } from "@ff-pane/shared";

/** 各 Runtime 读取 API 密钥的环境变量名（CLI 自管登录态的 Runtime 返回 undefined）。 */
export function runtimeApiKeyEnvVar(runtime: RuntimeId): string | undefined {
  switch (runtime) {
    case "codex":
      return "OPENAI_API_KEY";
    case "claude-code":
      return "ANTHROPIC_API_KEY";
    case "gemini-cli":
      return "GEMINI_API_KEY";
    // opencode 的 Provider 在其自身配置内声明；generic-exec 由 Profile 的自定义
    // 配置决定，均不由本层按固定变量名注入。
    default:
      return undefined;
  }
}

/** 各 Runtime 读取自定义 base_url 的环境变量名（仅 openai 兼容链路需要）。 */
function runtimeBaseUrlEnvVar(runtime: RuntimeId): string | undefined {
  return runtime === "codex" ? "OPENAI_BASE_URL" : undefined;
}

/**
 * 组装本轮注入环境变量。
 * - cli_login 类型的 Provider 不注入密钥（凭证由 CLI 自管，§4.2）。
 * - 无解密明文（未配置密钥 / 解密失败）时该变量缺席，交由 Runtime 自身报错，
 *   不静默塞空串。
 * - base_url 仅在 Provider 显式配置且 Runtime 支持时注入。
 */
export function resolveRuntimeEnv(input: {
  readonly runtime: RuntimeId;
  readonly provider: Provider;
  readonly apiKeyPlaintext?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const { runtime, provider, apiKeyPlaintext } = input;

  if (
    provider.type !== "cli_login" &&
    apiKeyPlaintext !== undefined &&
    apiKeyPlaintext.length > 0
  ) {
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
