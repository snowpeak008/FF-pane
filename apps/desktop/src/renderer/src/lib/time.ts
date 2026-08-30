/**
 * 时间格式化（设计系统 §6.5）：列表用相对时间（"3 分钟前"），
 * hover 显示绝对时间（本地时区）。纯函数、可注入 now，便于单测。
 *
 * 本地化交给 Intl（不进语言包）：locale 传 i18n 当前语言即可。
 */

/** 相对时间的单位阶梯（由大到小），值为该单位对应的毫秒数。 */
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/**
 * 相对时间（"3 分钟前" / "in 2 days"）。
 * @param then 目标时刻（epoch 毫秒）
 * @param locale BCP 47 语言（i18n 当前语言）
 * @param now 参照"现在"（默认 Date.now），单测可注入
 */
export function formatRelativeTime(then: number, locale: string, now: number = Date.now()): string {
  const diff = then - now; // 过去为负、将来为正
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  // 不足一分钟：numeric:"auto" 下 format(0,"second") 给出"现在"/"now"
  return rtf.format(0, "second");
}

/** 绝对时间（本地时区，中等日期 + 短时间），用于 tooltip 全量展示。 */
export function formatAbsoluteTime(then: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(then);
}
