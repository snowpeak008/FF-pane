/**
 * IPC 错误的用户文案翻译层（T9.2 ①）——纯函数，无 React / i18next 依赖，可直接单测。
 *
 * 分工（与 errors.ts / ErrorState 的关系）：
 * - errors.ts 负责「从任意抛出物提取字段」（code / field / reason / violations）；
 * - 本模块负责「code + field → 用户可读文案」的查表翻译：命中已知错误码给
 *   i18n 概括 + 字段定位，原始技术 message 收进可展开的「技术详情」折叠区
 *   （§4.2「错误原文必须可见可复制」从「唯一呈现」降为「折叠可见」，不丢原文）；
 * - **无 code / 未知 code 一律回退现状显示**（translated=false，调用方直接展示
 *   message）——向后兼容是硬要求，旧错误与第三方错误的呈现一个字都不变。
 *
 * 翻译函数经参数注入（ErrorTranslate：键不存在返回 undefined），组件侧以
 * i18next.exists + t 包一层；单测注入假翻译表即可覆盖全部分支。
 */

import type { IpcErrorInfo } from "./errors";

/** 翻译函数：键不存在返回 undefined（本层据此判定「该码是否已登记文案」）。 */
export type ErrorTranslate = (key: string, params?: Record<string, unknown>) => string | undefined;

/** 翻译结果。 */
export interface HumanizedIpcError {
  /** 是否命中结构化翻译；false = 调用方按现状直接展示 message。 */
  readonly translated: boolean;
  /** 用户可读概括（translated=false 时为原始 message）。 */
  readonly summary: string;
  /** 字段定位（已翻译的字段名 + 裸原因），无字段信息时缺席。 */
  readonly fieldNotes: readonly string[];
  /** 原始技术 message（进「技术详情」折叠区；恒有——原文不丢是纪律）。 */
  readonly technicalDetail: string;
}

/** 错误码 → 文案键（locales `errors.codes.*`）。键名即错误码（storage/core 判别字段或错误类名）。 */
const CODE_KEY_PREFIX = "errors.codes";

/** 字段名 → 字段标签键（locales `errors.fields.*`）。 */
const FIELD_KEY_PREFIX = "errors.fields";

/** 字段定位行的格式键（"{{field}}：{{reason}}" / 只有字段名时用 fieldOnly）。 */
const FIELD_NOTE_KEY = "errors.fieldNote";
const FIELD_ONLY_KEY = "errors.fieldOnly";

/**
 * 翻译单个字段定位行：字段名查表（未登记的字段原样展示——camelCase 领域字段
 * 本身可读），带裸原因则拼「字段：原因」。
 */
function fieldNote(translate: ErrorTranslate, field: string, reason?: string): string {
  const label = translate(`${FIELD_KEY_PREFIX}.${field}`) ?? field;
  if (reason !== undefined && reason.length > 0) {
    return translate(FIELD_NOTE_KEY, { field: label, reason }) ?? `${label}: ${reason}`;
  }
  return translate(FIELD_ONLY_KEY, { field: label }) ?? label;
}

/**
 * 把 IpcErrorInfo 翻译为用户可读形态。
 *
 * 判定顺序：code 在文案表里有登记 → 结构化翻译（概括 + 逐字段定位）；
 * 否则回退（translated=false，summary = 原始 message）。
 */
export function humanizeIpcError(
  error: IpcErrorInfo,
  translate: ErrorTranslate,
): HumanizedIpcError {
  const summary = translate(`${CODE_KEY_PREFIX}.${error.code}`);
  if (summary === undefined) {
    return {
      translated: false,
      summary: error.message,
      fieldNotes: [],
      technicalDetail: error.message,
    };
  }
  const fieldNotes: string[] = [];
  if (error.violations !== undefined && error.violations.length > 0) {
    for (const violation of error.violations) {
      fieldNotes.push(fieldNote(translate, violation.field, violation.reason));
    }
  } else if (error.field !== undefined) {
    fieldNotes.push(fieldNote(translate, error.field, error.reason));
  }
  return { translated: true, summary, fieldNotes, technicalDetail: error.message };
}
