/**
 * 子进程环境变量清洗（W2.1a，开发计划 v1.3 修订）。
 *
 * 动机（T2.0 实测）：Agent CLI 会自动吸收用户 shell 里的 Provider 凭证——
 * OpenCode 把 `OPENAI_*` / `ANTHROPIC_*` 直接当成可用 Provider
 * （docs/adapters/opencode.md §8.3），Gemini CLI 在有 `GEMINI_API_KEY` 时
 * 绕过 OAuth 登录态（docs/adapters/gemini-cli.md §6）。后果是 Run 的实际
 * Provider / 模型与 FF-pane 的 Profile 配置不一致，且用户全局密钥被计费。
 *
 * 对策：默认从子进程环境剥掉 API key 类变量，再叠加本 Run 的显式注入表；
 * 注入优先——显式注入的 `OPENAI_API_KEY` 不会被剥掉。
 */

/// <reference types="node" />

import process from "node:process";

/**
 * 需要剥离的环境变量名模式（大小写不敏感，故意不带 /g：共享 RegExp 用 test
 * 时 lastIndex 会串味）。
 *
 * 收录原则：只收"会改变 CLI 认证/Provider 选择"的变量。前缀型（OPENAI_ 等）
 * 连同 BASE_URL / ORG 一起剥，因为半套配置比没有配置更危险（密钥来自 FF-pane
 * 注入、地址却来自用户 shell）。
 *
 * 故意不剥的例子：`GOOGLE_GENAI_USE_GCA` 只是"复用已有 OAuth 登录态"的开关，
 * 不携带外部凭证，剥掉反而会把已登录的 CLI 误判为未登录。
 */
export const API_KEY_ENV_PATTERNS: readonly RegExp[] = [
  /^OPENAI_/i,
  /^AZURE_OPENAI_/i,
  /^ANTHROPIC_/i,
  // Claude Code 的后端切换开关 + 订阅 token（docs/adapters/claude-code.md §6）。
  /^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX)$/i,
  /^GEMINI_API_KEY$/i,
  /^GOOGLE_(?:API_KEY|APPLICATION_CREDENTIALS|GENAI_USE_VERTEXAI|CLOUD_PROJECT|CLOUD_LOCATION)$/i,
  /^VERTEXAI_/i,
  // qwen-code 的 OPENAI_MODEL 别名（qwen-code.md §7）：OPENAI_MODEL 已被 ^OPENAI_
  // 剥掉，别名不剥等于留后门——密钥来自 FF-pane 注入、模型却来自用户 shell。
  /^QWEN_MODEL$/i,
  // iFlow 全前缀剥（iflow.md §5.5）：认证/路由五形态（API_KEY/BASE_URL/MODEL_NAME/
  // MODEL/URL——CT() 认大小写四形态，大小写不敏感正则双杀）、IFLOW_HOME/IFLOW_CONFIG_DIR
  // 数据目录劫持、IFLOW_CLI_SYSTEM_SETTINGS_PATH 配置劫持、IFLOW_CLI_NO_RELAUNCH
  // 行为开关，调研清单要求全剥。适配器注入的三件套经「注入优先于清洗」放行。
  /^IFLOW_/i,
  /^OPENROUTER_/i,
  /^DEEPSEEK_/i,
  /^MOONSHOT_/i,
  /^DASHSCOPE_/i,
  /^ZHIPUAI?_/i,
  /^GROQ_/i,
  /^MISTRAL_/i,
  /^COHERE_/i,
  /^TOGETHER_/i,
  /^FIREWORKS_/i,
  /^PERPLEXITY_/i,
  /^XAI_/i,
  /^OLLAMA_API_KEY$/i,
  /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)$/i,
  // 兜底：任何 *_API_KEY / *_ACCESS_TOKEN / *_SECRET_KEY 形态的自定义变量。
  /(?:^|_)API_KEYS?$/i,
  /(?:^|_)(?:ACCESS|AUTH|BEARER)_TOKEN$/i,
  /(?:^|_)SECRET_(?:KEY|ACCESS_KEY)$/i,
];

/** 名字是否命中清洗模式。 */
export function isApiKeyEnvName(name: string): boolean {
  return API_KEY_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/** buildAgentEnv 的可选项。 */
export interface AgentEnvOptions {
  /** 基底环境，默认 process.env。 */
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  /** 显式注入表，优先于清洗。 */
  readonly inject?: Readonly<Record<string, string>> | undefined;
  /** 是否执行清洗，默认 true。 */
  readonly stripApiKeyEnv?: boolean | undefined;
}

/** buildAgentEnv 的结果。 */
export interface AgentEnvResult {
  readonly env: NodeJS.ProcessEnv;
  /** 实际被剥掉的变量名（已排序，便于日志比对；不含值）。 */
  readonly strippedNames: readonly string[];
}

/** 构造子进程环境：基底 → 剥 API key 类变量 → 叠加显式注入表。 */
export function buildAgentEnv(options: AgentEnvOptions = {}): AgentEnvResult {
  const base = options.baseEnv ?? process.env;
  const inject = options.inject ?? {};
  const env: NodeJS.ProcessEnv = { ...base };
  const strippedNames: string[] = [];

  if (options.stripApiKeyEnv ?? true) {
    for (const name of Object.keys(env)) {
      if (Object.hasOwn(inject, name)) {
        continue;
      }
      if (isApiKeyEnvName(name)) {
        delete env[name];
        strippedNames.push(name);
      }
    }
  }

  for (const [name, value] of Object.entries(inject)) {
    env[name] = value;
  }

  return { env, strippedNames: strippedNames.sort() };
}
