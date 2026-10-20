import {
  DEFAULT_MAX_WORKBENCH_WINDOWS,
  DEFAULT_MIN_FREE_DISK_MB,
  DEFAULT_MIN_FREE_MEMORY_MB,
  MAX_WORKBENCH_WINDOWS_OPTIONS,
  MIN_FREE_DISK_MB_OPTIONS,
  MIN_FREE_MEMORY_MB_OPTIONS,
} from "@ff-pane/shared";
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

  const save = async (patch: Parameters<typeof invokeQuery<"config:update">>[1]): Promise<void> => {
    const settled = await invokeQuery("config:update", patch);
    if (settled.status === "error") {
      toast.error(t("settings.workbenchLimit.error"), { description: settled.error.message });
      return;
    }
    refetch();
  };
  const memoryMb = config?.workbenchMinFreeMemoryMb ?? DEFAULT_MIN_FREE_MEMORY_MB;
  const diskMb = config?.workbenchMinFreeDiskMb ?? DEFAULT_MIN_FREE_DISK_MB;
  const withCurrent = (values: readonly number[], current: number): readonly number[] =>
    values.includes(current) ? values : [...values, current].toSorted((a, b) => a - b);
  const mbLabel = (mb: number): string =>
    mb === 0
      ? t("settings.workbenchLimit.noCheck")
      : t("settings.workbenchLimit.gb", { gb: mb / 1024 });

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
      {config !== undefined ? (
        <>
          <SettingRow
            htmlFor="setting-min-free-memory"
            label={t("settings.workbenchLimit.memoryLabel")}
            description={t("settings.workbenchLimit.memoryHint")}
          >
            <select
              id="setting-min-free-memory"
              className={selectClass}
              value={memoryMb}
              onChange={(e) => void save({ workbenchMinFreeMemoryMb: Number(e.target.value) })}
            >
              {withCurrent(MIN_FREE_MEMORY_MB_OPTIONS, memoryMb).map((value) => (
                <option key={value} value={value}>
                  {mbLabel(value)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            htmlFor="setting-min-free-disk"
            label={t("settings.workbenchLimit.diskLabel")}
            description={t("settings.workbenchLimit.diskHint")}
          >
            <select
              id="setting-min-free-disk"
              className={selectClass}
              value={diskMb}
              onChange={(e) => void save({ workbenchMinFreeDiskMb: Number(e.target.value) })}
            >
              {withCurrent(MIN_FREE_DISK_MB_OPTIONS, diskMb).map((value) => (
                <option key={value} value={value}>
                  {mbLabel(value)}
                </option>
              ))}
            </select>
          </SettingRow>
        </>
      ) : null}
    </section>
  );
}
