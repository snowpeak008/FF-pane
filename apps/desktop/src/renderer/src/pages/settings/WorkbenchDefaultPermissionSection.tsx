/**
 * 工作台「新窗口默认权限」设置（T10.5）。
 */

import {
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  WORKBENCH_PERMISSION_LEVELS,
  type WorkbenchPermissionLevel,
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

const selectClass = cn(inputVariants({}), "w-56 cursor-pointer");

export function WorkbenchDefaultPermissionSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const config = queryData(state);

  const onChange = async (permission: WorkbenchPermissionLevel): Promise<void> => {
    const settled = await invokeQuery("config:update", {
      defaultWorkbenchPermission: permission,
    });
    if (settled.status === "error") {
      toast.error(t("settings.workbenchPermission.error"), {
        description: settled.error.message,
      });
      return;
    }
    refetch();
  };

  const current = config?.defaultWorkbenchPermission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-fg">{t("settings.workbenchPermission.title")}</h2>
      <SettingRow
        htmlFor="setting-default-workbench-permission"
        label={t("settings.workbenchPermission.label")}
        description={t("settings.workbenchPermission.hint")}
      >
        {state.status === "error" ? (
          <span className="text-xs text-danger-text">
            {t("settings.workbenchPermission.loadError")}
          </span>
        ) : config === undefined ? (
          <InlineLoading />
        ) : (
          <select
            id="setting-default-workbench-permission"
            className={selectClass}
            data-testid="setting-default-workbench-permission"
            value={current}
            onChange={(e) => void onChange(e.target.value as WorkbenchPermissionLevel)}
          >
            {WORKBENCH_PERMISSION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`workbench.permission.level.${level}`)}
              </option>
            ))}
          </select>
        )}
      </SettingRow>
    </section>
  );
}
