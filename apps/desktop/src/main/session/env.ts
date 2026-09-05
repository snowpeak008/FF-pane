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
    // grok 的凭据解析顺序里 XAI_API_KEY 是全局兜底（grok-build.md §5），
    // 且它正落在「密钥只经 env 下发」的红线内。cli_login 型 Provider 走
    // 用户自己的 `grok login` 登录态，本函数的返回值对其无效（上层不注入）。
    case "grok-build":
      return "XAI_API_KEY";
    // aider 的认证完全由 litellm 按 Provider 读环境变量，没有 cli_login 登录态可用
    // （aider.md §5.2）。默认走 OpenAI 兼容链路的标准变量名；用别家 Provider 时
    // 由 Profile 侧的自定义配置覆盖。
    // 注意：这个变量是 aider 唯一的认证材料来源，缺席会让它进 onboarding 并唤起
    // 浏览器（§7.3 坑 1），故适配器在 startTurn 里对它做启动前快速失败。
    case "aider":
      return "OPENAI_API_KEY";
    // qwen-code 走 --auth-type openai 兼容协议（适配器默认下发；qwen OAuth 免费层
    // 2026-04-15 已废止，qwen-code.md §6）：密钥变量与 codex/aider 同名，覆盖
    // ModelStudio/Dashscope/OpenRouter 等一切 OpenAI 兼容端点。
    case "qwen-code":
      return "OPENAI_API_KEY";
    // opencode 的 Provider 在其自身配置内声明；generic-exec 由 Profile 的自定义
    // 配置决定，均不由本层按固定变量名注入。
    default:
      return undefined;
  }
}

/**
 * 各 Runtime 读取自定义 base_url 的环境变量名（仅 openai 兼容链路需要）。
 *
 * aider 也用 `OPENAI_BASE_URL` 而非 `OPENAI_API_BASE`：实测（aider.md §5.2）
 * litellm 优先取 `OPENAI_BASE_URL`，它**会压过** aider 自己的 `--openai-api-base`
 * 参数。既然优先级最高的那个就是它，注入它才能保证路由确定。
 * qwen-code 同用 `OPENAI_BASE_URL`（真机实测生效，qwen-code.md §6——指向
 * Dashscope/ModelStudio/OpenRouter 等端点的唯一 env 通道）。
 */
function runtimeBaseUrlEnvVar(runtime: RuntimeId): string | undefined {
  return runtime === "codex" || runtime === "aider" || runtime === "qwen-code"
    ? "OPENAI_BASE_URL"
    : undefined;
}

/** 单 Provider 每轮临时装配的 codex model_provider 槽名（无跨轮共享，故固定即可）。 */
const CODEX_PROVIDER_SLUG = "ffpane";

/**
 * 组装本轮运行时配置覆盖（AdapterTurnContext.configOverrides）。
 *
 * 目前仅 codex 需要：把一个 openai_compatible Provider 装配成 codex 的自定义
 * model_provider 路由，使 codex 走 Provider 的 base_url + 由 env_key 指向的 OPENAI_API_KEY，
 * 而非其内置 openai/ChatGPT 登录（后者会覆盖裸 OPENAI_BASE_URL，实测 §T4.5 验收）。
 *
 * 值按 codex `-c` 的 TOML 语义：model_provider 用裸 slug；name/base_url/env_key 为
 * 基本字符串，用 JSON.stringify 产出合法带引号串（含转义）。cli_login / 非 codex / 非
 * openai_compatible / 无 baseUrl → 返回空表（无覆盖）。
 */
export function resolveRuntimeConfigOverrides(input: {
  readonly runtime: RuntimeId;
  readonly provider: Provider;
}): Record<string, string> {
  const { runtime, provider } = input;
  if (
    runtime !== "codex" ||
    provider.type !== "openai_compatible" ||
    provider.baseUrl === undefined ||
    provider.baseUrl.length === 0
  ) {
    return {};
  }
  const slug = CODEX_PROVIDER_SLUG;
  const name = provider.name.length > 0 ? provider.name : slug;
  return {
    model_provider: slug,
    [`model_providers.${slug}.name`]: JSON.stringify(name),
    [`model_providers.${slug}.base_url`]: JSON.stringify(provider.baseUrl),
    // env_key 指向 resolveRuntimeEnv 为 codex 注入的密钥变量（下方常量），二者必须一致。
    [`model_providers.${slug}.env_key`]: JSON.stringify("OPENAI_API_KEY"),
  };
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
