/**
 * 草案值的密钥形状检测（T9.2 ⑤，T9.1 验收裁定落地）。
 *
 * 裁定口径（主管理员 2026-09-06，T9.1 验收 §5 第一行）：**值层面不加拦截**
 * （误伤面不划算——正常名称/URL 可能含 key 形状片段），只在确认对话框给一行
 * 黄色警示「该值疑似密钥，密钥不应经 AI 填写」，用户仍可自行决定。
 *
 * 形状清单从严于误伤方向收窄：只认**常见密钥前缀**（sk- / Bearer 等），不做
 * 长串熵检测——警示的存在理由是提醒「AI 往展示字段里塞了疑似密钥的东西」，
 * 不是当第二道校验。纯函数，无 DOM 依赖，单测直接覆盖。
 */

/**
 * 常见密钥形状（前缀类）：
 * - `sk-…`（OpenAI/Anthropic 风格 secret key）；
 * - `Bearer <token>`（HTTP 授权头整段被塞进值里）；
 * - `AIza…`（Google API key）；
 * - `xai-…`（xAI）；
 * - `ghp_` / `gho_` / `github_pat_`（GitHub token）；
 * - JWT 三段式（eyJ 开头、两个点分隔）。
 */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bAIza[A-Za-z0-9_-]{16,}/,
  /\bxai-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho)_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
];

/** 单个字符串值是否命中密钥形状。 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 递归扫描草案对象的全部字符串值，任一命中即 true。
 * 草案形状是 ConfigDraftPayload.draft（纯数据、无循环引用——经 IPC 结构化克隆而来），
 * 深度上限防御性封顶。
 */
export function draftContainsSecretShape(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (typeof value === "string") {
    return looksLikeSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => draftContainsSecretShape(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => draftContainsSecretShape(item, depth + 1));
  }
  return false;
}
