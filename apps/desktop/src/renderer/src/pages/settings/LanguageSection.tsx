import { AI_OUTPUT_LANGUAGES, type AiOutputLanguage } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { InlineLoading } from "../../components/states/LoadingState";
import { inputVariants } from "../../components/ui/input.variants";
import { changeUiLanguage } from "../../i18n";
import { FALLBACK_LANGUAGE, isSupportedLanguage, type SupportedLanguage } from "../../i18n/resolve";
import { LANGUAGE_OPTIONS } from "../../i18n/resources";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { SettingRow } from "./SettingRow";

const selectClass = cn(inputVariants({}), "w-48 cursor-pointer");

/**
 * 语言设置区（W3.2b / 设计文档 §9）：界面语言（§9.1）与 AI 输出语言（§9.2）互不影响。
 * 界面语言即时生效并持久化 localStorage（i18n 既有机制）；
 * AI 输出语言写全局 config.json（主进程 Prompt 组装 T4.1 消费），故经 config:update。
 */
export function LanguageSection(): ReactElement {
  const { t, i18n } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const config = queryData(state);

  // i18n.language 恒为受支持值（initI18n 只喂 resolveUiLanguage 的结果）；
  // 这条兜底用注册表的回退语言，不再各处硬编码具体语言标签。
  const currentUi: SupportedLanguage = isSupportedLanguage(i18n.language)
    ? i18n.language
    : FALLBACK_LANGUAGE;

  const onOutputChange = async (language: AiOutputLanguage): Promise<void> => {
    const settled = await invokeQuery("config:update", { aiOutputLanguage: language });
    if (settled.status === "error") {
      toast.error(t("settings.outputLanguage.error"), { description: settled.error.message });
      return;
    }
    refetch();
  };

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-fg">{t("settings.language.title")}</h2>

      <SettingRow htmlFor="setting-ui-language" label={t("settings.language.label")}>
        <select
          id="setting-ui-language"
          className={selectClass}
          value={currentUi}
          onChange={(e) => changeUiLanguage(e.target.value as SupportedLanguage)}
        >
          {/* 标签用各语言的自称（endonym），不经 t()：语言选项的名字不该随当前界面语言变，
              且这样新增语言就不必再往每一本语言包补一条 languageName（见 i18n/resources.ts）。 */}
          {LANGUAGE_OPTIONS.map(({ code, label }) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        htmlFor="setting-output-language"
        label={t("settings.outputLanguage.label")}
        description={t("settings.outputLanguage.hint")}
      >
        {state.status === "error" ? (
          <span className="text-xs text-danger-text">{t("settings.outputLanguage.loadError")}</span>
        ) : config === undefined ? (
          <InlineLoading />
        ) : (
          <select
            id="setting-output-language"
            className={selectClass}
            value={config.aiOutputLanguage}
            onChange={(e) => void onOutputChange(e.target.value as AiOutputLanguage)}
          >
            {/* AI 输出语言仍走 t(languageName)：它不绑语言包（可以有没有界面翻译的输出语言），
                故没有"自称"可取，其名字只能由语言包提供。这是与上面界面语言选择器的刻意分歧。 */}
            {AI_OUTPUT_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {t(`settings.languageName.${lang}`)}
              </option>
            ))}
          </select>
        )}
      </SettingRow>
    </section>
  );
}
