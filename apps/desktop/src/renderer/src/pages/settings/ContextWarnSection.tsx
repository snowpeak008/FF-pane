import { CONTEXT_WARN_PERCENT_OPTIONS } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { InlineLoading } from "../../components/states/LoadingState";
import { inputVariants } from "../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { SettingRow } from "./SettingRow";

const selectClass = cn(inputVariants({}), "w-48 cursor-pointer");

/**
 * 上下文阈值设置区（T9.8 ②）：会话用量达到窗口该百分比时，会话页横幅提示
 * 「建议轻装重开」。全局设置（config.json contextWarnPercent，默认 70），
 * 照 LanguageSection 的 AI 输出语言款式：config:get 读 → config:update 写 →
 * 失败 toast → refetch。档位下拉（CONTEXT_WARN_PERCENT_OPTIONS）；存量自定义值
 * （手改 config.json）不在档位里时补一个当前值选项如实呈现，不悄悄改写。
 */
export function ContextWarnSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const config = queryData(state);

  const onChange = async (percent: number): Promise<void> => {
    const settled = await invokeQuery("config:update", { contextWarnPercent: percent });
    if (settled.status === "error") {
      toast.error(t("settings.contextWarn.error"), { description: settled.error.message });
      return;
    }
    refetch();
  };

  const current = config?.contextWarnPercent;
  const options: readonly number[] =
    current !== undefined && !CONTEXT_WARN_PERCENT_OPTIONS.some((value) => value === current)
      ? [...CONTEXT_WARN_PERCENT_OPTIONS, current].toSorted((a, b) => a - b)
      : CONTEXT_WARN_PERCENT_OPTIONS;

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-fg">{t("settings.contextWarn.title")}</h2>
      <SettingRow
        htmlFor="setting-context-warn-percent"
        label={t("settings.contextWarn.label")}
        description={t("settings.contextWarn.hint")}
      >
        {state.status === "error" ? (
          <span className="text-xs text-danger-text">{t("settings.contextWarn.loadError")}</span>
        ) : current === undefined ? (
          <InlineLoading />
        ) : (
          <select
            id="setting-context-warn-percent"
            className={selectClass}
            value={current}
            onChange={(e) => void onChange(Number(e.target.value))}
          >
            {options.map((value) => (
              <option key={value} value={value}>
                {t("settings.contextWarn.optionPercent", { percent: value })}
              </option>
            ))}
          </select>
        )}
      </SettingRow>
    </section>
  );
}
