/**
 * 用户内容改动台账（计划 docs/用户内容可插拔与agy工具插件计划.md §3）。
 *
 * FF-pane 凡是写进用户自己内容的东西（现在只有 agy 的 ffpane 工具插件），都在这里记一笔：
 * 改了什么、在哪、哪个版本写的。台账丢了也不影响清理：清理认「固定名字 + 归属标记」，台账只是记录。
 * 本文件只做纯逻辑和读写，不碰任何用户目录。
 */

import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "@ff-pane/storage";

export const USER_MODS_FILE_NAME = "user-mods.json";

/** 改动种类。以后有别的（比如别的 CLI 的插件），在这里加。 */
export type UserModKind = "agy-plugin";

export interface UserModEntry {
  readonly kind: UserModKind;
  /** 稳定名字（插件名），跨版本按它认。 */
  readonly name: string;
  /** 写到了哪。 */
  readonly path: string;
  /** 写入内容摘要。 */
  readonly digest: string;
  /** 写入它的 FF-pane 版本（仅记录，清理不看版本）。 */
  readonly writtenBy: string;
  readonly installedAt: number;
  readonly updatedAt: number;
  /** 最近一次自动更新失败的原因；成功后清掉。 */
  readonly lastError?: string;
}

export interface UserModsLedger {
  readonly version: 1;
  readonly entries: readonly UserModEntry[];
}

export const EMPTY_LEDGER: UserModsLedger = { version: 1, entries: [] };

function isEntry(value: unknown): value is UserModEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    raw["kind"] === "agy-plugin" &&
    typeof raw["name"] === "string" &&
    raw["name"] !== "" &&
    typeof raw["path"] === "string" &&
    typeof raw["digest"] === "string" &&
    typeof raw["writtenBy"] === "string" &&
    typeof raw["installedAt"] === "number" &&
    typeof raw["updatedAt"] === "number"
  );
}

/** 宽松解析：文件缺失、损坏、有看不懂的条目，都当没有，不抛。 */
export function parseLedger(text: string | undefined): UserModsLedger {
  if (text === undefined || text.trim() === "") {
    return EMPTY_LEDGER;
  }
  try {
    const raw = JSON.parse(text) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) {
      return EMPTY_LEDGER;
    }
    return { version: 1, entries: raw.entries.filter(isEntry) };
  } catch {
    return EMPTY_LEDGER;
  }
}

export function findEntry(
  ledger: UserModsLedger,
  kind: UserModKind,
  name: string,
): UserModEntry | undefined {
  return ledger.entries.find((entry) => entry.kind === kind && entry.name === name);
}

export function upsertEntry(ledger: UserModsLedger, entry: UserModEntry): UserModsLedger {
  const others = ledger.entries.filter(
    (item) => !(item.kind === entry.kind && item.name === entry.name),
  );
  return { version: 1, entries: [...others, entry] };
}

export function removeEntry(
  ledger: UserModsLedger,
  kind: UserModKind,
  name: string,
): UserModsLedger {
  return {
    version: 1,
    entries: ledger.entries.filter((item) => !(item.kind === kind && item.name === name)),
  };
}

export async function readLedger(file: string): Promise<UserModsLedger> {
  try {
    return parseLedger(await readFile(file, "utf8"));
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function writeLedger(file: string, ledger: UserModsLedger): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`);
}
