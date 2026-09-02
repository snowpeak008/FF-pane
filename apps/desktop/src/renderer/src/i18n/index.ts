/**
 * i18next 装配（T0.3）：语言解析顺序 = 用户已保存的选择 → 系统语言 → zh-CN 回退；
 * 缺失 key 由 fallbackLng 回退 zh-CN。系统语言经 IPC 取自主进程 app.getLocale()。
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { type ChangeLanguage, createLanguageChanger } from "./change-language";
import {
  type LanguageSetting,
  resolveLanguageSetting,
  resolveUiLanguage,
  type SupportedLanguage,
} from "./resolve";
import { resources } from "./resources";

/**
 * **缺 key 回退**：某语言包缺某个 key 时，用哪本语言包的文案顶上。
 *
 * 与 FALLBACK_LANGUAGE（解析回退：该给用户显示哪种语言）是两个不同问题，
 * 故单独声明而非复用——两者今后可以各自变化，不该被一个常量绑死。
 *
 * 取 zh-CN 的理由：中文是本项目的基准语言（设计文档、AI 输出语言默认值皆然），
 * 语言包按中文先写、其余语言由它翻译而来，缺 key 时顶上来的应当是那本最全的。
 * 对现有 zh / en 两语言无任何实际影响——locales-parity 与 check-i18n 已保证两者
 * key 集合完全一致，永远走不到这条回退；它的意义在将来的第三种语言。
 */
const MISSING_KEY_FALLBACK_LANGUAGE: SupportedLanguage = "zh-CN";

/**
 * 语言选择持久化：Phase 0 暂存 localStorage；Phase 1 文件存储层（T1.2）落地后
 * 迁移到全局 config.json（~/.aiworkbench/config.json，项目设计计划 §10.1）——计划内分阶段交付。
 *
 * 存的是**设置值**（"system" / "zh-CN" / "en-US"），不是解析结果：T8.1 之前只存具体语言，
 * 于是「跟随系统」只能由「键根本不存在」表达——用户选过一次就再也回不去（§9.1 的
 * 设置项本来就是三态）。现在 "system" 是一个可以被显式写入的值。
 */
const STORAGE_KEY = "ffpane.ui-language";

function readSavedLanguage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch (thrown) {
    // 开发者日志英文（check-i18n 扫描约定）；读不到就按「跟随系统」走
    console.error("[renderer] language setting read failed:", thrown);
    return null;
  }
}

/** 当前的界面语言设置（三态）。设置页据此显示选中项。 */
export function readUiLanguageSetting(): LanguageSetting {
  return resolveLanguageSetting(readSavedLanguage());
}

async function fetchSystemLocale(): Promise<string> {
  try {
    const { locale } = await window.ffpane.invoke("app:get-locale");
    return locale;
  } catch (thrown) {
    // 开发者日志英文（check-i18n 扫描约定）；检测失败按解析顺序继续降级
    console.error("[renderer] system locale detection failed:", thrown);
    return "";
  }
}

/** 初始化 i18next 并绑定 react-i18next，必须在 React 挂载前 await 完成。 */
export async function initI18n(): Promise<void> {
  const language = resolveUiLanguage(readSavedLanguage(), await fetchSystemLocale());
  await i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: MISSING_KEY_FALLBACK_LANGUAGE,
    interpolation: {
      // React 渲染层自带 XSS 转义，i18next 不再二次转义
      escapeValue: false,
    },
  });
  document.documentElement.lang = i18next.language;
  i18next.on("languageChanged", (lng) => {
    document.documentElement.lang = lng;
  });
}

function writeSavedLanguage(setting: LanguageSetting): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, setting);
  } catch (thrown) {
    console.error("[renderer] language setting write failed:", thrown);
  }
}

/**
 * 切换界面语言设置：立即生效（react-i18next 触发重渲染）并持久化。
 *
 * 选「跟随系统」时要现问一次系统语言再切——此刻不能只把键删掉了事：
 * 用户从 en-US 切回跟随系统，界面必须当场变成系统语言，而不是等下次启动。
 *
 * 快速连续切换的竞态（T8.1 验收登记）由 change-language.ts 的序号守卫处理：等 IPC
 * 期间用户又选了别的，过期的那次不再 changeLanguage（返回 false）。这里只做装配——
 * 三件副作用（localStorage / IPC / i18next）注入进去，时序逻辑本身可在 node 环境单测。
 */
export const changeUiLanguage: ChangeLanguage = createLanguageChanger({
  persist: writeSavedLanguage,
  fetchSystemLocale,
  applyLanguage: async (language) => {
    await i18next.changeLanguage(language);
  },
});
