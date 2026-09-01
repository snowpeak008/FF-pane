/**
 * 语言包装配：仓库根 locales/*.json 经 vite 静态导入打进 renderer bundle。
 * 新增语言 = 新增 locales/<tag>.json + 在此登记（resources 与 ENDONYMS 两处，缺一即编译失败）
 * + 扩充领域层注册表 UI_LANGUAGES（@ff-pane/shared，resolve.ts 的 SUPPORTED_LANGUAGES 即它）。
 */
import enUS from "../../../../../../locales/en-US.json";
import zhCN from "../../../../../../locales/zh-CN.json";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./resolve";

/** i18next resources：每种语言一个默认命名空间（translation）。 */
export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
} as const satisfies Record<SupportedLanguage, { translation: unknown }>;

/**
 * 各语言的自称（endonym），取自语言包内部，不随当前 UI 语言翻译。
 * satisfies 是这里的守卫：新增语言忘了登记自称，本行即编译失败。
 *
 * 界面语言选择器（设置页 LanguageSection）的具体语言选项用它作标签：
 * 刻意不经 t()——语言选项的名字不该随当前界面语言变，且这样新增语言
 * 无需再往每一本语言包补一条 languageName（那是漏改无检查会红的一处）。
 * 选择器里的「跟随系统」是例外，它是一句说明而非某种语言的名字，照常经 t()。
 */
export const LANGUAGE_ENDONYMS = {
  "zh-CN": zhCN.settings.language.displayName,
  "en-US": enUS.settings.language.displayName,
} as const satisfies Record<SupportedLanguage, string>;

/** 具体语言的选项列表（顺序随注册表）；「跟随系统」由设置页另行置顶。 */
export const LANGUAGE_OPTIONS: readonly {
  readonly code: SupportedLanguage;
  readonly label: string;
}[] = SUPPORTED_LANGUAGES.map((code) => ({ code, label: LANGUAGE_ENDONYMS[code] }));
