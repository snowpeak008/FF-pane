/**
 * i18next 装配（T0.3）：语言解析顺序 = 用户已保存的选择 → 系统语言 → en-US 回退；
 * 缺失 key 由 fallbackLng 回退 en-US。系统语言经 IPC 取自主进程 app.getLocale()。
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { FALLBACK_LANGUAGE, resolveUiLanguage, type SupportedLanguage } from "./resolve";
import { resources } from "./resources";

/**
 * 语言选择持久化：Phase 0 暂存 localStorage；Phase 1 文件存储层（T1.2）落地后
 * 迁移到全局 config.json（~/.aiworkbench/config.json，项目设计计划 §10.1）——计划内分阶段交付。
 */
const STORAGE_KEY = "ffpane.ui-language";

function readSavedLanguage(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
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
    fallbackLng: FALLBACK_LANGUAGE,
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

/** 切换 UI 语言：立即生效（react-i18next 触发重渲染）并持久化选择。 */
export function changeUiLanguage(language: SupportedLanguage): void {
  window.localStorage.setItem(STORAGE_KEY, language);
  void i18next.changeLanguage(language);
}
