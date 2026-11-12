/**
 * Claude 窗口走中转来源时，把地址、模型写进本窗口的 `--settings`（来源注入修复计划）。
 *
 * 只放进程环境不够：Claude 启动后读 `~/.claude/settings.json` 和项目 `.claude/settings*.json`
 * 的 `env`，会盖掉进程环境里的 ANTHROPIC_*。`--settings` 的优先级比这几份都高。
 *
 * 密钥不写进文件：文件里把 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 清空，
 * 改用 apiKeyHelper 跑一条固定命令，从本窗口进程环境 FF_PANE_CLAUDE_KEY 里读出来。
 * 清空是必须的：留着用户 settings 里的 AUTH_TOKEN，它会压过 apiKeyHelper。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_OFFICIAL_BASE_URL } from "@ff-pane/shared";

/** 密钥只在本窗口进程环境里，apiKeyHelper 从这里读。 */
export const CLAUDE_KEY_ENV = "FF_PANE_CLAUDE_KEY";
/** 钩子脚本收到这个名字时只打印密钥，不上报、不连管道。 */
export const CLAUDE_KEY_HELPER_EVENT = "ApiKey";

/** Claude 拿来选后端、认证的变量。不是本来源给的值一律清空。 */
const ROUTE_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_REGION",
  "AWS_PROFILE",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
] as const;

/** 选了模型就全设成它，子 agent 和 opus/sonnet/haiku 别名也不会落到用户 settings 里的模型名。 */
const MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

const SECRET_KEYS = new Set<string>(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

/** 用户 / 项目 settings 里这类键也清空（如 ANTHROPIC_CUSTOM_MODEL_OPTION、模型显示名）。 */
function isRoutingEnvName(name: string): boolean {
  return /^ANTHROPIC_/i.test(name) || /^CLAUDE_CODE_USE_/i.test(name);
}

export interface ClaudeProviderSettings {
  readonly env: Readonly<Record<string, string>>;
  readonly apiKeyHelper?: string;
}

/**
 * 纯函数。injectEnv 是来源解析出的环境（含密钥）；密钥键在结果里只会是空串。
 * existingEnvNames：用户和项目 settings 里已有的 env 键名，命中路由类的一并清空。
 */
export function buildClaudeProviderSettings(input: {
  readonly injectEnv: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly apiKeyHelper?: string;
  readonly existingEnvNames?: readonly string[];
}): ClaudeProviderSettings {
  const env: Record<string, string> = {};
  for (const name of input.existingEnvNames ?? []) {
    if (isRoutingEnvName(name)) {
      env[name] = "";
    }
  }
  for (const name of ROUTE_KEYS) {
    env[name] = "";
  }
  for (const [name, value] of Object.entries(input.injectEnv)) {
    if (!SECRET_KEYS.has(name)) {
      env[name] = value;
    }
  }
  if ((env["ANTHROPIC_BASE_URL"] ?? "") === "") {
    env["ANTHROPIC_BASE_URL"] = ANTHROPIC_OFFICIAL_BASE_URL;
  }
  const model = input.model?.trim() || input.injectEnv["ANTHROPIC_MODEL"]?.trim() || "";
  for (const name of MODEL_KEYS) {
    env[name] = model;
  }
  return {
    env,
    ...(input.apiKeyHelper !== undefined ? { apiKeyHelper: input.apiKeyHelper } : {}),
  };
}

/**
 * apiKeyHelper 命令：有 node 就跑钩子脚本的 ApiKey 模式；没有就用系统自带的 PowerShell
 * （Claude 在 Windows 上不展开 `$变量`）。命令里只有固定路径和变量名，没有密钥。
 */
export function claudeKeyHelperCommand(input: {
  readonly nodePath?: string | undefined;
  readonly scriptPath: string;
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
}): string {
  if (input.nodePath !== undefined && input.nodePath.trim() !== "") {
    return `"${input.nodePath}" "${input.scriptPath}" ${CLAUDE_KEY_HELPER_EVENT}`;
  }
  if ((input.platform ?? process.platform) === "win32") {
    const root = input.systemRoot?.trim() || "C:\\Windows";
    const ps = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return `"${ps}" -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:${CLAUDE_KEY_ENV})"`;
  }
  return `printf %s "$${CLAUDE_KEY_ENV}"`;
}

function envNamesIn(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const env = (parsed as { env?: unknown }).env;
      if (env !== null && typeof env === "object") {
        return Object.keys(env);
      }
    }
  } catch {
    // 没有或读不了就当没有
  }
  return [];
}

/** 用户 settings 与项目 settings 里 env 的键名（只读键名，不读值）。 */
export function readClaudeSettingsEnvNames(input: {
  readonly cwd: string;
  readonly configDir?: string;
}): string[] {
  const configDir = input.configDir?.trim() || join(homedir(), ".claude");
  const files = [
    join(configDir, "settings.json"),
    join(input.cwd, ".claude", "settings.json"),
    join(input.cwd, ".claude", "settings.local.json"),
  ];
  return [...new Set(files.flatMap(envNamesIn))];
}
