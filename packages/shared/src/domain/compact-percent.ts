/**
 * 管理者窗口的压缩比例（T10.20）。
 * 缺省表示不指定，启动时不传，用命令行自己的默认。
 */

/** 滑块下限（含）。再低时，命令行可能刚压完又满。 */
export const MIN_MANAGER_COMPACT_PERCENT = 50;

/** 滑块上限（含）。再高会比 Claude / Codex 默认更晚才压。 */
export const MAX_MANAGER_COMPACT_PERCENT = 90;

/**
 * Grok 自己大约到这个比例就压。
 * 滑块可以画到 90，传给这一次进程时不超过这里，避免更晚才压。
 */
export const GROK_COMPACT_PERCENT_CAP = 85;

/** 用户勾上「指定比例」时滑块先停在这里。不指定才是默认。 */
export const MANAGER_COMPACT_PERCENT_WHEN_ENABLED = 70;

/**
 * 只接受 50 到 90 的整数。
 * 缺省、小数、带单位的字符串一律当成不指定。
 */
export function parseManagerCompactPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < MIN_MANAGER_COMPACT_PERCENT || value > MAX_MANAGER_COMPACT_PERCENT) {
    return undefined;
  }
  return value;
}
