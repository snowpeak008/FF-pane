/**
 * 文件名派生（W1.2b）：plan 文件名由 PlanVersion 派生，task / run 文件（目录）名
 * 由 ID 派生并做文件系统安全化。
 *
 * ID 安全化策略（W1.2b 决策）：百分号编码而非剔除或哈希。
 * - 保留字符集之外的字符逐个编码为 UTF-8 字节的 %XX（大写十六进制），
 *   '%' 自身也编码（%25），因此映射单射：不同 ID 永不落到同一文件名，
 *   且可无损还原（但读取从不依赖还原——JSON 内的 id 字段才是权威）。
 * - 中文等非 ASCII 字符在三大平台文件名中均合法，保留原样以维持可读性
 *   （与 W1.2a 的中文路径支持一致）。
 * - 编码对象：Windows 禁用字符 < > : " / \ | ? *、控制字符、'%'；
 *   以及结尾处的 '.' 与 ' '（Windows 会剥掉名字结尾的点与空格，
 *   run-<id> 目录名以 ID 结尾，必须编码防止塌缩）。
 * - 已知边界：Windows 文件系统大小写不敏感，仅大小写不同的两个 ID 会在
 *   Windows 上落到同一文件；规避责任在 ID 生成侧（本系统生成的 ID 大小写稳定）。
 */

const UTF8_ENCODER = new TextEncoder();

/** Windows 文件名禁用的可见字符 + '%'（保证编码单射）。 */
const UNSAFE_VISIBLE_CHARS = '<>:"/\\|?*%';

function isUnsafeChar(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return true;
  }
  return UNSAFE_VISIBLE_CHARS.includes(char);
}

function encodeChar(char: string): string {
  let encoded = "";
  for (const byte of UTF8_ENCODER.encode(char)) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * 将实体 ID 安全化为可作文件（目录）名组成部分的字符串（策略见模块注释）。
 * 纯函数、全函数（任意字符串输入都有输出）、单射（不同输入必得不同输出）。
 */
export function sanitizeIdForFileName(id: string): string {
  let sanitized = "";
  for (const char of id) {
    sanitized += isUnsafeChar(char) ? encodeChar(char) : char;
  }
  // 结尾的 '.' / ' ' 逐个编码（编码产物只含 %、十六进制位，不会再引入结尾点/空格）
  let end = sanitized.length;
  while (end > 0 && (sanitized.charAt(end - 1) === "." || sanitized.charAt(end - 1) === " ")) {
    end -= 1;
  }
  const head = sanitized.slice(0, end);
  let tail = "";
  for (const char of sanitized.slice(end)) {
    tail += encodeChar(char);
  }
  return head + tail;
}

/**
 * 计划正文（渲染视图）文件名：plan-v<N>.md（设计文档 §10.2）。
 * 版本合法性（≥1 的整数）由 savePlan / loadPlan 在有路径上下文处校验。
 */
export function planMdFileName(version: number): string {
  return `plan-v${version}.md`;
}

/** 计划权威数据文件名：plan-v<N>.meta.json（设计文档 §10.2）。 */
export function planMetaFileName(version: number): string {
  return `plan-v${version}.meta.json`;
}

/** 任务记录文件名：task-<id>.json（设计文档 §10.2），ID 经安全化。 */
export function taskFileName(id: string): string {
  return `task-${sanitizeIdForFileName(id)}.json`;
}

/** Run 记录目录名：run-<id>（设计文档 §10.2），ID 经安全化。 */
export function runDirName(id: string): string {
  return `run-${sanitizeIdForFileName(id)}`;
}
