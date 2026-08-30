/**
 * 错误原文提取（设计系统 §6.2 错误态）。
 *
 * 硬性要求：错误态必须显示**错误原文**，禁止把错误吞掉只显示"出错了"。
 * 本模块把任意 catch 到的值（Error / 字符串 / IPC 回传的普通对象）压成一段
 * 可复制的纯文本，交给 ErrorState 以 font-mono 渲染。
 *
 * 纯函数、无 DOM 依赖，由 tests/ui-components.test.ts 直接覆盖。
 */

/** cause 链的展开上限，避免自引用导致无限递归。 */
const MAX_CAUSE_DEPTH = 4;

function stringifyUnknown(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    // 循环引用等无法序列化的值退回 String()
    return String(value);
  }
}

function formatOne(error: unknown): string {
  if (typeof error === "string") {
    return error.trim();
  }
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack.trim() : "";
    if (stack.length > 0) {
      return stack;
    }
    const message = error.message.trim();
    return message.length > 0 ? `${error.name}: ${message}` : error.name;
  }
  if (error === null || error === undefined) {
    return "";
  }
  return stringifyUnknown(error).trim();
}

/**
 * 把任意抛出物格式化为可复制的错误原文；无内容时返回空串（调用方据此隐藏原文区）。
 * Error 优先取 stack（含首行的 `Name: message`），并沿 cause 链追加上游原因。
 */
export function formatErrorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    const text = formatOne(current);
    if (text.length > 0) {
      parts.push(depth === 0 ? text : `Caused by: ${text}`);
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return parts.join("\n");
}

/** 是否有可展示的错误原文。 */
export function hasErrorDetail(error: unknown): boolean {
  return formatErrorDetail(error).length > 0;
}

/**
 * 一行人类可读概括：Error 取 message，字符串取首行，其余取原文首行。
 * 页面通常会传更贴合业务的概括文案（如"读取项目列表失败"），此函数是兜底。
 */
export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
    return error.name;
  }
  const [firstLine] = formatErrorDetail(error).split("\n");
  return firstLine ?? "";
}
