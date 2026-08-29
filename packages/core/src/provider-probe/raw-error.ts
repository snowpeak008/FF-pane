/**
 * 失败原文的组装规则（W1.5c，设计文档 §4.2——错误原文直接展示，不做"友好化"包装）：
 * - HTTP 失败：状态行 + 响应体原文，仅做长度截断（RAW_ERROR_MAX_LENGTH），内容不改写。
 * - 网络层失败：沿 cause 链收集每层原始 message（undici 把底层 socket 错误包在
 *   TypeError("fetch failed").cause 里，直接透出最外层 message 等于什么都没说）。
 * - 唯一的改写例外是密钥红线（§4.3）：所有输出对传入的明文 key 做兜底替换
 *   （redactSecret）——即使上游服务把请求头回显进错误体，key 也不会进入返回值。
 */

/** 响应体进入 rawError 前保留的最大字符数，超出部分截断并标注原文长度。 */
export const RAW_ERROR_MAX_LENGTH = 2000;

/** 明文 key 被兜底脱敏后的占位标记。 */
export const REDACTED_KEY_PLACEHOLDER = "【已脱敏：API key】";

/** 超长文本截断：保留前 RAW_ERROR_MAX_LENGTH 字符并标注原文总长，不足则原样返回。 */
export function truncateRawText(text: string): string {
  if (text.length <= RAW_ERROR_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, RAW_ERROR_MAX_LENGTH)}\n……（已截断，原文共 ${text.length} 字符）`;
}

/** 把文本中出现的明文 secret 全部替换为占位标记；secret 为空则原样返回。 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") {
    return text;
  }
  return text.split(secret).join(REDACTED_KEY_PLACEHOLDER);
}

/** 单个错误节点的原文：Error 取 name + message，其余值序列化兜底。 */
function formatErrorNode(error: unknown): string {
  if (error instanceof Error) {
    const prefix = error.name === "" || error.name === "Error" ? "" : `${error.name}: `;
    const message = error.message === "" ? "（无错误信息）" : error.message;
    return `${prefix}${message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * 沿 cause 链收集各层原始 message，用 " ← " 串联（外层在前）。
 * AggregateError（undici 多地址连接失败的形态）额外展开 errors 列表。
 * 深度上限 8 层，防御自引用 cause。
 */
export function describeCauseChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    parts.push(formatErrorNode(current));
    if (current instanceof AggregateError && current.errors.length > 0) {
      parts.push(current.errors.map(formatErrorNode).join(" | "));
      break;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" ← ");
}
