import {
  isProjectConfigScopeOpen,
  type ProjectConfig,
  type ProjectConfigId,
} from "@ff-pane/shared";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ErrorState } from "../../../components/states/ErrorState";
import { LoadingState } from "../../../components/states/LoadingState";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../components/ui/Dialog";
import { invokeQuery, queryData } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { ConfigEditorDialog } from "./ConfigEditorDialog";

const selectClass = "rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-fg";

export function ConfigsSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("configs:list");
  const { state: providerState } = useInvokeQuery("providers:list");
  const { state: projectState } = useInvokeQuery("projects:list");
  const configs = queryData(state) ?? [];
  const providers = queryData(providerState) ?? [];
  const projects = queryData(projectState) ?? [];
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectConfig | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectConfig | null>(null);
  const [pendingDefault, setPendingDefault] = useState<ProjectConfig | null>(null);
  const [replacement, setReplacement] = useState("");
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const openCreate = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (config: ProjectConfig): void => {
    setEditing(config);
    setEditorOpen(true);
  };

  const setDefault = async (id: ProjectConfigId): Promise<void> => {
    const settled = await invokeQuery("configs:set-default", { id });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setPendingDefault(null);
    refetch();
  };

  const askSetDefault = (config: ProjectConfig): void => {
    if (!isProjectConfigScopeOpen(config.projectIds)) {
      setPendingDefault(config);
      return;
    }
    void setDefault(config.id);
  };

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) {
      return;
    }
    setDeleteError(undefined);
    const settled = await invokeQuery("configs:delete", {
      id: pendingDelete.id,
      ...(pendingDelete.isDefault && replacement !== ""
        ? { newDefaultId: replacement as ProjectConfigId }
        : {}),
    });
    if (settled.status === "error") {
      setDeleteError(
        settled.error.code === "config-scope-blocked"
          ? t("settings.configs.scopeBlocked", {
              names: settled.error.reason ?? settled.error.message,
            })
          : settled.error.message,
      );
      return;
    }
    setPendingDelete(null);
    refetch();
  };

  return (
    <section className="flex flex-col gap-3" data-testid="settings-configs">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-fg">{t("settings.configs.title")}</h2>
          <p className="text-xs text-fg-muted">{t("settings.configs.subtitle")}</p>
        </div>
        <Button type="button" size="sm" data-testid="config-new" onClick={openCreate}>
          <Plus aria-hidden size={14} />
          {t("settings.configs.new")}
        </Button>
      </div>
      {state.status === "loading" ? <LoadingState variant="list" /> : null}
      {state.status === "error" ? (
        <ErrorState
          summary={t("settings.configs.loadError")}
          error={state.error}
          onRetry={refetch}
        />
      ) : null}
      {state.status === "success" && configs.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("settings.configs.empty")}</p>
      ) : null}
      {configs.map((config) => {
        const last = configs.length <= 1;
        return (
          <Card
            key={config.id}
            padding="compact"
            className="flex items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{config.name}</span>
                {config.isDefault ? (
                  <Badge data-testid={`config-default-badge-${config.id}`}>
                    {t("settings.configs.defaultBadge")}
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-xs text-fg-muted">
                {config.claude !== undefined ? "Claude" : ""}
                {config.claude !== undefined && config.codex !== undefined ? " · " : ""}
                {config.codex !== undefined ? "Codex" : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {config.isDefault ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`config-set-default-${config.id}`}
                  onClick={() => askSetDefault(config)}
                >
                  <Star aria-hidden size={14} />
                  {t("settings.configs.setDefault")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                iconOnly
                aria-label={t("settings.configs.editLabel", { name: config.name })}
                data-testid={`config-edit-${config.id}`}
                onClick={() => openEdit(config)}
              >
                <Pencil aria-hidden size={14} />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                iconOnly
                disabled={last}
                title={last ? t("settings.configs.lastCannotDelete") : undefined}
                aria-label={t("settings.configs.removeLabel", { name: config.name })}
                data-testid={`config-delete-${config.id}`}
                onClick={() => {
                  setDeleteError(undefined);
                  setReplacement("");
                  setPendingDelete(config);
                }}
              >
                <Trash2 aria-hidden size={14} />
              </Button>
            </div>
          </Card>
        );
      })}
      <ConfigEditorDialog
        open={editorOpen}
        config={editing}
        providers={providers}
        projects={projects}
        onOpenChange={setEditorOpen}
        onSaved={(savedName) => {
          refetch();
          toast.success(t("settings.configs.saved", { name: savedName }));
        }}
      />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <DialogContent data-testid="config-delete-dialog">
          <DialogHeader
            title={
              pendingDelete?.isDefault === true
                ? t("settings.configs.deleteDefaultTitle")
                : t("settings.configs.removeLabel", { name: pendingDelete?.name ?? "" })
            }
            description={
              pendingDelete?.isDefault === true
                ? t("settings.configs.deleteDefaultHint")
                : undefined
            }
          />
          <DialogBody className="flex flex-col gap-2">
            {pendingDelete?.isDefault === true ? (
              <select
                className={selectClass}
                data-testid="config-delete-replacement"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
              >
                <option value="">{t("settings.configs.deleteReplacement")}</option>
                {configs
                  .filter((item) => item.id !== pendingDelete.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            ) : null}
            {pendingDelete?.isDefault === true &&
            !isProjectConfigScopeOpen(
              configs.find((item) => item.id === replacement)?.projectIds,
            ) ? (
              <p className="text-sm text-fg" data-testid="config-delete-clears-scope">
                {t("settings.configs.promoteClearsScope")}
              </p>
            ) : null}
            {deleteError !== undefined ? (
              <p className="text-sm text-danger-text" role="alert">
                {deleteError}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="config-delete-confirm"
              disabled={pendingDelete?.isDefault === true && replacement === ""}
              onClick={() => void confirmDelete()}
            >
              {t("settings.configs.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={pendingDefault !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefault(null);
          }
        }}
      >
        <DialogContent data-testid="config-promote-dialog">
          <DialogHeader
            title={t("settings.configs.promoteTitle")}
            description={t("settings.configs.promoteClearsScope")}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDefault(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="config-promote-confirm"
              onClick={() => {
                if (pendingDefault !== null) {
                  void setDefault(pendingDefault.id);
                }
              }}
            >
              {t("settings.configs.setDefault")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
