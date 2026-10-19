/**
 * 全局生图设置。所有项目、所有窗口共用这一份，不按项目分开。
 *
 * 只存方案，以及中转站的地址、模型名、密钥引用。密钥明文不进这个类型，
 * 也不进 config.json。
 *
 * 本地 SD 不在 {@link IMAGE_GEN_MODES} 里（计划 §6：程序留位置，界面先不出现）。
 * 以后加方案时在这个数组末尾追加一个成员；中转站字段放在 relay，不跟某一种 mode 绑死，
 * 换方案时才能原样留在磁盘上。
 */

import type { ApiKeyRef } from "./common.js";

/** 设置页下拉的三项，顺序固定。缺省（字段不存在）= 第一项。 */
export const IMAGE_GEN_MODES = ["off", "codex_subscription", "relay"] as const;

/** 生图方案。 */
export type ImageGenMode = (typeof IMAGE_GEN_MODES)[number];

/** 已保存的中转站。没有明文密钥。 */
export interface ImageGenRelaySettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyRef: ApiKeyRef;
}

/**
 * 生图设置。整个字段可缺省，缺省 = {@link imageGenModeOf} 的 off。
 * relay 与 mode 无关：选回「先不生图」或 Codex 订阅时也不删。
 */
export interface ImageGenSettings {
  readonly mode: ImageGenMode;
  readonly relay?: ImageGenRelaySettings;
}

/** 运行时守卫：只接受界面上的三项。 */
export function isImageGenMode(value: unknown): value is ImageGenMode {
  return typeof value === "string" && (IMAGE_GEN_MODES as readonly string[]).includes(value);
}

/** 缺省 = 先不生图。 */
export function imageGenModeOf(settings: ImageGenSettings | undefined): ImageGenMode {
  return settings?.mode ?? "off";
}

/**
 * 地址必须是 http 或 https。
 * 不用 URL 构造器：shared 的编译目标没有 DOM / Node 类型。
 */
export function isHttpImageGenBaseUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 只留下地址、模型名、密钥引用。明文密钥字段（apiKey 等）一律丢掉。
 * 三项缺一则整段中转站不保留。
 */
export function sanitizeImageGenRelay(raw: unknown): ImageGenRelaySettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const baseUrl = readTrimmedString(record, "baseUrl");
  const model = readTrimmedString(record, "model");
  const apiKeyRef = readTrimmedString(record, "apiKeyRef");
  if (baseUrl === undefined || model === undefined || apiKeyRef === undefined) {
    return undefined;
  }
  return {
    baseUrl,
    model,
    apiKeyRef: apiKeyRef as ApiKeyRef,
  };
}

/**
 * 收成可落盘的生图设置。不认识的方案当成 off，但已有的中转站仍留下。
 * 完全没有可用内容时返回 undefined（缺省 = off）。
 */
export function sanitizeImageGenSettings(raw: unknown): ImageGenSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const rawMode = record["mode"];
  const mode: ImageGenMode = isImageGenMode(rawMode) ? rawMode : "off";
  const relay = sanitizeImageGenRelay(record["relay"]);
  if (!isImageGenMode(rawMode) && relay === undefined) {
    return undefined;
  }
  if (relay !== undefined) {
    return { mode, relay };
  }
  return { mode };
}

/**
 * 把补丁合并进现有生图设置。
 * 补丁没带 relay 时留下原来的中转站；补丁里的明文密钥不进入结果。
 */
export function mergeImageGenSettings(
  current: ImageGenSettings | undefined,
  patch: unknown,
): ImageGenSettings | undefined {
  const base = sanitizeImageGenSettings(current);
  if (patch === undefined) {
    return base;
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return base;
  }
  const record = patch as Record<string, unknown>;
  const rawMode = record["mode"];
  const mode: ImageGenMode = isImageGenMode(rawMode) ? rawMode : (base?.mode ?? "off");
  const relay = Object.hasOwn(record, "relay")
    ? (sanitizeImageGenRelay(record["relay"]) ?? base?.relay)
    : base?.relay;
  const modeRecognized = isImageGenMode(rawMode);
  if (!modeRecognized && relay === undefined && base === undefined) {
    return undefined;
  }
  if (relay !== undefined) {
    return { mode, relay };
  }
  return { mode };
}
