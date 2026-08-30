/**
 * 全局设置（设计文档 §10.1 config.json 的领域形态）。
 * 界面语言 / 主题当前由渲染层 localStorage 承载（分阶段迁移，见 i18n/theme 注释）；
 * 本类型只收「主进程也要读」的设置：AI 输出语言全局默认（Prompt 组装 T4.1 消费）、
 * 默认权限预设（新建 Profile 的起点，§7）。
 */

import type { AiOutputLanguage } from "./language.js";
import type { PermissionEnvelope } from "./permission.js";

/** 全局设置（config.json 的领域形态）。 */
export interface GlobalConfig {
  /** 设计文档 §9.2 —— AI 输出语言的全局默认（Profile / 项目可覆盖）。 */
  readonly aiOutputLanguage: AiOutputLanguage;
  /** 设计文档 §7 / §4.4 —— 新建 Profile 时预填的默认权限信封。 */
  readonly defaultPermissionPreset: PermissionEnvelope;
}

/** AI 输出语言的出厂默认（产品中文优先）。 */
export const DEFAULT_AI_OUTPUT_LANGUAGE: AiOutputLanguage = "zh-CN";

/**
 * 默认权限预设（出厂）：保守起点——项目内可读、不可写、禁 Shell、禁网络、
 * 危险操作恒需逐次确认。用户在设置页 / Profile 里按需放宽。
 */
export const DEFAULT_PERMISSION_PRESET: PermissionEnvelope = {
  readPaths: ["**"],
  writePaths: [],
  shell: "forbidden",
  network: false,
  // 类型固定为 true：任何信封都不能关闭危险操作确认（§7 第 5 项）
  dangerousOpsRequireApproval: true,
};

/** 出厂默认全局设置（config.json 不存在时的回退值）。 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  aiOutputLanguage: DEFAULT_AI_OUTPUT_LANGUAGE,
  defaultPermissionPreset: DEFAULT_PERMISSION_PRESET,
};
