import { AI_OUTPUT_LANGUAGES, type AiOutputLanguage } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { InlineLoading } from "../../components/states/LoadingState";
import { inputVariants } from "../../components/ui/input.variants";
import { changeUiLanguage, readUiLanguageSetting } from "../../i18n";
import { isSupportedLanguage, type LanguageSetting } from "../../i18n/resolve";
import { LANGUAGE_ENDONYMS, LANGUAGE_OPTIONS } from "../../i18n/resources";
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

  // 选中项是**设置值**（三态），不是当前生效的语言：选「跟随系统」而系统恰好是中文时，
  // 下拉该显示「跟随系统」而非「简体中文」——否则用户没法确认自己到底选没选跟随。
  // 持久化在 i18n 模块（localStorage），这里存一份本地态只为让下拉即时回显。
  const [setting, setSetting] = useState<LanguageSetting>(readUiLanguageSetting);

  const onUiChange = (next: LanguageSetting): void => {
    setSetting(next);
    void changeUiLanguage(next);
  };

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

      <SettingRow
        htmlFor="setting-ui-language"
        label={t("settings.language.label")}
        // 只在「跟随系统」下说明当前生效的是哪种语言：选了具体语言时下拉本身就是答案，
        // 再写一遍是废话（与主题设置区那行 resolved 说明同一取舍）。
        {...(setting === "system" && isSupportedLanguage(i18n.language)
          ? {
              description: t("settings.language.resolved", {
                language: LANGUAGE_ENDONYMS[i18n.language],
              }),
            }
          : {})}
      >
        <select
          id="setting-ui-language"
          className={selectClass}
          value={setting}
          onChange={(e) => onUiChange(e.target.value as LanguageSetting)}
        >
          {/* 「跟随系统」经 t()：它是一句说明，不是某种语言的名字。
              具体语言用各自的自称（endonym）且不经 t()——语言选项的名字不该随当前界面
              语言变，且这样新增语言就不必再往每一本语言包补一条 languageName。
              两者的分工见 i18n/resources.ts。 */}
          <option value="system">{t("settings.language.system")}</option>
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
