/**
 * config.json 持久化（全局设置，设计文档 §10.1）：整文件原子读写 + 部分更新。
 *
 * 设计决策（镜像 W1.5a providers/store）：
 * - 整文件结构 `{ version, config }`；文件不存在 = 出厂默认（首次 update 自动建档）。
 * - readConfig 永远返回完整 GlobalConfig：缺失文件 / 缺失字段一律补 DEFAULT_GLOBAL_CONFIG，
 *   调用方拿到的永远是可直接用的完整设置（不需处理 undefined 字段）。
 * - updateConfig 是「读全 → 浅合并补丁 → 原子写回」，返回合并后的完整设置。
 * - JSON 语法损坏由 W1.2a 隔离并上抛 StorageCorruptJsonError；结构不符抛 ConfigFileInvalidError。
 */

import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { ConfigFileInvalidError } from "./errors.js";

/** config.json 的当前格式版本。 */
export const CONFIG_FILE_VERSION = 1;

/** config.json 的整文件结构：版本字段 + 设置对象。 */
export interface ConfigFile {
  readonly version: typeof CONFIG_FILE_VERSION;
  readonly config: GlobalConfig;
}

/** 全局设置存取接口（消费方：设置页、Prompt 组装 T4.1）。 */
export interface ConfigStore {
  /** 读取完整全局设置。文件 / 字段缺失一律补出厂默认。 */
  readConfig(): Promise<GlobalConfig>;
  /** 浅合并补丁并原子写回，返回合并后的完整设置。 */
  updateConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig>;
}

/** 读入整文件；not-found 归一为出厂默认，结构不符抛 typed error。 */
async function loadConfig(configFile: string): Promise<GlobalConfig> {
  const result = await readJson<unknown>(configFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return DEFAULT_GLOBAL_CONFIG;
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigFileInvalidError(configFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly config?: unknown };
  if (file.version !== CONFIG_FILE_VERSION) {
    throw new ConfigFileInvalidError(
      configFile,
      `不支持的 version：${String(file.version)}（当前支持 ${CONFIG_FILE_VERSION}）`,
    );
  }
  const stored = (
    typeof file.config === "object" && file.config !== null ? file.config : {}
  ) as Partial<GlobalConfig>;
  // 缺失字段补默认：读出来永远是完整设置（JSON 边界，字段写入时已受控）
  return { ...DEFAULT_GLOBAL_CONFIG, ...stored };
}

async function saveConfig(configFile: string, config: GlobalConfig): Promise<void> {
  const file: ConfigFile = { version: CONFIG_FILE_VERSION, config };
  await writeJsonAtomic(configFile, file);
}

/**
 * 创建绑定到指定 config.json 路径的 ConfigStore。
 * 接线示例：`createConfigStore(resolveGlobalLayout(root).configFile)`。
 */
export function createConfigStore(configFile: string): ConfigStore {
  return {
    readConfig: () => loadConfig(configFile),

    async updateConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
      const current = await loadConfig(configFile);
      const merged: GlobalConfig = { ...current, ...patch };
      await saveConfig(configFile, merged);
      return merged;
    },
  };
}
