/**
 * 模型 → 上下文窗口注册表（T9.8 ②，编译期常量）。
 *
 * 数据来源是**公开规格**（各厂商模型文档标称的上下文窗口），不做任何在线查询
 * （合同红线：私有模型窗口在线查询不做）。数字会随厂商发新模型漂移——漂移时改这里
 * 一处即可，消费方只经 {@link resolveContextWindow} 取值。
 *
 * 三级回退（source 字段如实标注来路，UI 据此决定是否标「估算」）：
 * 1. `model`——模型 ID 命中已知模式，取公开规格值（非估算）；
 * 2. `runtime`——模型缺省（cli_login 允许不填模型，T9.2 ④）但 Runtime 已知，
 *    按该 CLI 默认模型的公开规格给保守值（估算）；
 * 3. `fallback`——两者都对不上，给保守默认 {@link DEFAULT_CONTEXT_WINDOW_TOKENS}（估算）。
 */

/**
 * 未知模型的保守默认窗口（128K）。
 * 取当前主流模型的**下界**而非中位数：宁可提醒来得早，也不要在真 128K 的模型上
 * 按 400K 算、等提醒出现时上下文早已溢出。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** 上下文阈值提醒的出厂默认（用量达窗口 70% 时提示轻装重开，可在设置页调整）。 */
export const DEFAULT_CONTEXT_WARN_PERCENT = 70;

/** 阈值设置项的候选档位（设置页下拉；存量自定义值仍原样呈现）。 */
export const CONTEXT_WARN_PERCENT_OPTIONS = [50, 60, 70, 80, 90] as const;

/** 窗口取值的来路（UI 据此标注估算）。 */
export type ContextWindowSource = "model" | "runtime" | "fallback";

/** resolveContextWindow 的结果：窗口大小 + 来路。 */
export interface ContextWindowResolution {
  /** 窗口大小（token）。 */
  readonly tokens: number;
  /** 取值来路：model = 公开规格命中；runtime / fallback = 估算，UI 须标注。 */
  readonly source: ContextWindowSource;
}

/**
 * 已知模型模式表（顺序即优先级——特化条目在前，泛化条目在后）。
 * 模式按小写子串/正则匹配模型 ID：各家 CLI 的模型 ID 形态不一
 * （"claude-sonnet-4-5" / "gpt-5-codex" / "qwen3-coder-plus"…），锚定家族名而非全名。
 * 数值一律取该家族当前公开规格的标称窗口。
 */
const MODEL_WINDOW_PATTERNS: readonly (readonly [RegExp, number])[] = [
  // OpenAI：GPT-5 家族（含 gpt-5-codex）公开规格 400K；gpt-4.1 标称 1M；gpt-4o 128K
  [/gpt-5/, 400_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-4o/, 128_000],
  // Anthropic：Claude 全家族标称 200K
  [/claude/, 200_000],
  // Google：Gemini 1.5/2.x Pro 标称 1M（1,048,576）
  [/gemini/, 1_048_576],
  // DeepSeek：V3 / R1 标称 128K
  [/deepseek/, 128_000],
  // Qwen：Qwen3-Coder 标称 256K（262,144）
  [/qwen/, 262_144],
  // xAI：grok-code-fast / grok-4 标称 256K
  [/grok/, 256_000],
] as const;

/**
 * Runtime → 保守窗口（cli_login 缺省模型时的回退，T9.2 ④）。
 * 取各 CLI **默认模型**的公开规格；默认模型不明的家一律保守默认。
 * 键为适配器注册键（KNOWN_RUNTIMES 的裸键；未列出的 Runtime 走 fallback）。
 */
const RUNTIME_WINDOW_DEFAULTS: Readonly<Record<string, number>> = {
  // codex CLI 默认 gpt-5-codex（400K）
  codex: 400_000,
  // claude-code 默认 Claude 家族（200K）
  "claude-code": 200_000,
  // gemini-cli 默认 Gemini Pro/Flash（1M）
  "gemini-cli": 1_048_576,
  // qwen-code 默认 Qwen3-Coder（256K）
  "qwen-code": 262_144,
  // grok-build 默认 grok-code 家族（256K）
  "grok-build": 256_000,
  // opencode / aider / iflow / generic-exec：默认模型随用户配置漂移，保守默认
};

/**
 * 解析模型的上下文窗口。
 *
 * @param model 模型 ID（Profile.model ?? Provider.defaultModel 的折算值；可缺省）
 * @param runtime 适配器注册键（模型缺省时按 Runtime 给保守估算；可缺省）
 */
export function resolveContextWindow(
  model: string | null | undefined,
  runtime?: string | null,
): ContextWindowResolution {
  if (model !== null && model !== undefined && model.trim() !== "") {
    const normalized = model.toLowerCase();
    for (const [pattern, tokens] of MODEL_WINDOW_PATTERNS) {
      if (pattern.test(normalized)) {
        return { tokens, source: "model" };
      }
    }
    // 模型给了但不认识：保守默认（不看 Runtime——用户显式选的模型才是事实源，
    // 按 Runtime 默认模型取窗口会在「codex 上跑第三方小模型」时给出 400K 的误导值）
    return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: "fallback" };
  }
  if (runtime !== null && runtime !== undefined) {
    const tokens = RUNTIME_WINDOW_DEFAULTS[runtime];
    if (tokens !== undefined) {
      return { tokens, source: "runtime" };
    }
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: "fallback" };
}
