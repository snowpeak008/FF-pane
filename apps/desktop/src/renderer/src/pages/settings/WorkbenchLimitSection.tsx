import { DEFAULT_MAX_WORKBENCH_WINDOWS, MAX_WORKBENCH_WINDOWS_OPTIONS } from "@ff-pane/shared";
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
 * 工作台窗口上限（T10.2）：同时运行的终端窗口数，主进程强制校验。
 */
export function WorkbenchLimitSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const config = queryData(state);

  const onChange = async (max: number): Promise<void> => {
    const settled = await invokeQuery("config:update", { maxWorkbenchWindows: max });
    if (settled.status === "error") {
      toast.error(t("settings.workbenchLimit.error"), { description: settled.error.message });
      return;
    }
    refetch();
  };

  const current = config?.maxWorkbenchWindows ?? DEFAULT_MAX_WORKBENCH_WINDOWS;
  const options: readonly number[] = !MAX_WORKBENCH_WINDOWS_OPTIONS.some(
    (value) => value === current,
  )
    ? [...MAX_WORKBENCH_WINDOWS_OPTIONS, current].toSorted((a, b) => a - b)
    : MAX_WORKBENCH_WINDOWS_OPTIONS;

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-fg">{t("settings.workbenchLimit.title")}</h2>
      <SettingRow
        htmlFor="setting-max-workbench-windows"
        label={t("settings.workbenchLimit.label")}
        description={t("settings.workbenchLimit.hint")}
      >
        {state.status === "error" ? (
          <span className="text-xs text-danger-text">{t("settings.workbenchLimit.loadError")}</span>
        ) : config === undefined ? (
          <InlineLoading />
        ) : (
          <select
            id="setting-max-workbench-windows"
            className={selectClass}
            value={current}
            onChange={(e) => void onChange(Number(e.target.value))}
          >
            {options.map((value) => (
              <option key={value} value={value}>
                {t("settings.workbenchLimit.option", { count: value })}
              </option>
            ))}
          </select>
        )}
      </SettingRow>
    </section>
  );
}
