import type { PermissionEnvelope } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PermissionEnvelopeEditor } from "./PermissionEnvelopeEditor";

/**
 * 默认权限预设区（W3.2b / 设计文档 §7）：新建 Profile 时预填的信封。
 * 编辑后显式保存（非即时）——权限是敏感设置，避免手滑即改。
 */
export function DefaultPermissionSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const config = queryData(state);
  const [draft, setDraft] = useState<PermissionEnvelope | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // 以查询到的值为基线，本地草稿承载未保存编辑
  const value = draft ?? config?.defaultPermissionPreset;
  const dirty =
    draft !== undefined &&
    config !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(config.defaultPermissionPreset);

  const save = async (): Promise<void> => {
    if (draft === undefined) {
      return;
    }
    setSaving(true);
    const settled = await invokeQuery("config:update", { defaultPermissionPreset: draft });
    setSaving(false);
    if (settled.status === "error") {
      toast.error(t("settings.defaultPermission.error"), { description: settled.error.message });
      return;
    }
    setDraft(undefined);
    refetch();
    toast.success(t("settings.defaultPermission.saved"));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-fg">{t("settings.defaultPermission.title")}</h2>
        <p className="text-xs text-fg-muted">{t("settings.defaultPermission.subtitle")}</p>
      </div>

      {state.status === "loading" ? <LoadingState variant="detail" rows={3} /> : null}

      {state.status === "error" ? (
        <ErrorState error={state.error} onRetry={refetch} className="min-h-0" />
      ) : null}

      {value !== undefined ? (
        <>
          <PermissionEnvelopeEditor idPrefix="default-perm" value={value} onChange={setDraft} />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={() => void save()}
              disabled={!dirty || saving}
              loading={saving}
            >
              {t("common.save")}
            </Button>
            {dirty ? (
              <Button variant="ghost" size="md" onClick={() => setDraft(undefined)}>
                {t("common.cancel")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
