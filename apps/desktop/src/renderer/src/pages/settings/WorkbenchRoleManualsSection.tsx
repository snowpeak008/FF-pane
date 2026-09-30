/**
 * 工作台角色说明书（T10.6）：查看、覆盖副本、恢复默认。
 */

import { WORKBENCH_ROLE_MANUAL_IDS, type WorkbenchRoleManualId } from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { InlineLoading } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";
import { inputVariants } from "../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { SettingRow } from "./SettingRow";

const selectClass = cn(inputVariants({}), "w-56 cursor-pointer");

export function WorkbenchRoleManualsSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("workbench:list-role-manuals");
  const manuals = queryData(state)?.manuals ?? [];
  const [selected, setSelected] = useState<WorkbenchRoleManualId>("base");
  const current = manuals.find((item) => item.id === selected);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (current !== undefined) {
      setDraft(current.content);
    }
  }, [current]);

  const save = async (): Promise<void> => {
    const settled = await invokeQuery("workbench:save-role-manual", {
      id: selected,
      content: draft,
    });
    if (settled.status === "error") {
      toast.error(t("settings.workbenchRoles.error"), { description: settled.error.message });
      return;
    }
    toast.success(t("settings.workbenchRoles.saved"));
    refetch();
  };

  const reset = async (): Promise<void> => {
    const settled = await invokeQuery("workbench:reset-role-manual", { id: selected });
    if (settled.status === "error") {
      toast.error(t("settings.workbenchRoles.error"), { description: settled.error.message });
      return;
    }
    setDraft(settled.data.content);
    toast.success(t("settings.workbenchRoles.resetDone"));
    refetch();
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-fg">{t("settings.workbenchRoles.title")}</h2>
      <p className="text-xs text-fg-muted">{t("settings.workbenchRoles.hint")}</p>
      {state.status === "error" ? (
        <span className="text-xs text-danger-text">{t("settings.workbenchRoles.loadError")}</span>
      ) : manuals.length === 0 ? (
        <InlineLoading />
      ) : (
        <>
          <SettingRow
            htmlFor="setting-workbench-role-manual"
            label={t("settings.workbenchRoles.pick")}
            description={
              current?.source === "override"
                ? t("settings.workbenchRoles.source.override")
                : t("settings.workbenchRoles.source.default")
            }
          >
            <select
              id="setting-workbench-role-manual"
              className={selectClass}
              data-testid="setting-workbench-role-manual"
              value={selected}
              onChange={(event) => setSelected(event.target.value as WorkbenchRoleManualId)}
            >
              {WORKBENCH_ROLE_MANUAL_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`settings.workbenchRoles.manual.${id}`)}
                </option>
              ))}
            </select>
          </SettingRow>
          <Textarea
            data-testid="setting-workbench-role-manual-text"
            rows={12}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="setting-workbench-role-save"
              onClick={() => void save()}
            >
              {t("settings.workbenchRoles.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="setting-workbench-role-reset"
              onClick={() => void reset()}
            >
              {t("settings.workbenchRoles.reset")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
