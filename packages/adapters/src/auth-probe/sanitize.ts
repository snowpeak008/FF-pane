/**
 * 探测输出的脱敏与截断（W1.5d）。
 *
 * detail 会进入 UI 与日志，依据设计文档 §4.3"密钥永远不进入日志文件"，
 * 对 CLI 输出做三步处理：剥 ANSI 色码 → 敏感模式替换 → 长度截断。
 * 方向宁严勿松：误伤可读性的代价远小于泄露 token。
 */

/** detail 中输出摘录的最大长度（字符）。 */
export const MAX_DETAIL_EXCERPT_LENGTH = 300;

const REDACTED = "[REDACTED]";

/** ANSI 转义序列（opencode auth list 实测带色码）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 ANSI 转义需要匹配 ESC 控制符
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * 敏感模式清单（对已剥 ANSI 的文本逐一替换）：
 * 1. OpenAI/Anthropic 风格 key（sk-…）；
 * 2. Google API key（AIza…）；
 * 3. JWT（eyJ….…．…）；
 * 4. Bearer 头；
 * 5. key=value / "key": "value" 形式的凭证字段（保留字段名，抹值）；
 * 6. 兜底：40+ 位无空白的 base64/hex 长串（token 形态的最后防线）。
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];

/** 凭证字段名（匹配 key: value / key = value，保留字段名）。 */
const CREDENTIAL_FIELD_PATTERN =
  /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|authorization)["']?\s*[:=]\s*)["']?[^\s"',;}]{6,}["']?/gi;

/**
 * 对 CLI 输出做脱敏 + 折行 + 截断，产出可安全展示的单行摘录。
 * 空输出返回空字符串。
 */
export function sanitizeOutputExcerpt(
  raw: string,
  maxLength: number = MAX_DETAIL_EXCERPT_LENGTH,
): string {
  let text = raw.replace(ANSI_PATTERN, "");
  text = text.replace(CREDENTIAL_FIELD_PATTERN, `$1${REDACTED}`);
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}…(已截断)`;
  }
  return text;
}

/** 仅剥 ANSI 色码（判定规则做模式匹配前使用，不改动其余内容）。 */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_PATTERN, "");
}
