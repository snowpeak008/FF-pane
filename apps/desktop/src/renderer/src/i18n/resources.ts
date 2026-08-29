/**
 * 语言包装配：仓库根 locales/*.json 经 vite 静态导入打进 renderer bundle。
 * 新增语言 = 新增 locales/<tag>.json + 在此登记 + 扩充 resolve.ts 的 SUPPORTED_LANGUAGES。
 */
import enUS from "../../../../../../locales/en-US.json";
import zhCN from "../../../../../../locales/zh-CN.json";
import type { SupportedLanguage } from "./resolve";

/** i18next resources：每种语言一个默认命名空间（translation）。 */
export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
} as const satisfies Record<SupportedLanguage, { translation: unknown }>;

/** 语言切换控件的选项：label 取各语言包内的自称（endonym），不随当前 UI 语言翻译。 */
export const LANGUAGE_OPTIONS: readonly {
  readonly code: SupportedLanguage;
  readonly label: string;
}[] = [
  { code: "zh-CN", label: zhCN.settings.language.displayName },
  { code: "en-US", label: enUS.settings.language.displayName },
];
