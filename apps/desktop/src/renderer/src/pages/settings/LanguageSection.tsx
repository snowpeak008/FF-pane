import { AI_OUTPUT_LANGUAGES, type AiOutputLanguage } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { InlineLoading } from "../../components/states/LoadingState";
import { inputVariants } from "../../components/ui/input.variants";
import { changeUiLanguage } from "../../i18n";
import {
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../../i18n/resolve";
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

  const currentUi: SupportedLanguage = isSupportedLanguage(i18n.language) ? i18n.language : "en-US";

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
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {t(`settings.languageName.${lang}`)}
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
