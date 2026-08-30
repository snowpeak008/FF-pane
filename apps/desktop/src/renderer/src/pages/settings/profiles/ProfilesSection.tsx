import type { AgentProfile } from "@ff-pane/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../../components/states/EmptyState";
import { ErrorState } from "../../../components/states/ErrorState";
import { LoadingState } from "../../../components/states/LoadingState";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { invokeQuery } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { ProfileEditorDialog } from "./ProfileEditorDialog";

/**
 * 设置页 · Agent Profile 管理区（W3.2b / 设计文档 §4.4）。
 * Profile = Runtime + Provider + 模型 + 默认角色 + 权限预设 + 输出语言；
 * 项目角色绑定引用 Profile（换 AI = 换绑定）。
 */
export function ProfilesSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("profiles:list");
  const { state: providersState } = useInvokeQuery("providers:list");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | undefined>(undefined);
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());

  const providerNameById = useMemo(() => {
    const map = new Map<string, string>();
    if (providersState.status === "success") {
      for (const p of providersState.data) {
        map.set(p.id, p.name);
      }
    }
    return map;
  }, [providersState]);

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((profile: AgentProfile) => {
    setEditing(profile);
    setEditorOpen(true);
  }, []);

  const handleSaved = useCallback(
    (profile: AgentProfile) => {
      refetch();
      toast.success(t("settings.profiles.saved", { name: profile.name }));
    },
    [refetch, t],
  );

  const handleRemove = useCallback(
    async (profile: AgentProfile) => {
      setRemovingIds((prev) => new Set(prev).add(profile.id));
      const settled = await invokeQuery("profiles:remove", { id: profile.id });
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(profile.id);
        return next;
      });
      if (settled.status === "error") {
        toast.error(t("settings.profiles.removeError"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(t("settings.profiles.removed", { name: profile.name }));
    },
    [refetch, t],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-fg">{t("settings.profiles.title")}</h2>
          <p className="text-xs text-fg-muted">{t("settings.profiles.subtitle")}</p>
        </div>
        {state.status === "success" && state.data.length > 0 ? (
          <Button variant="primary" size="md" onClick={openCreate}>
            <Plus aria-hidden size={16} />
            {t("settings.profiles.new")}
          </Button>
        ) : null}
      </div>

      {state.status === "loading" ? <LoadingState variant="list" /> : null}

      {state.status === "error" ? (
        <ErrorState
          summary={t("settings.profiles.loadError")}
          error={state.error}
          onRetry={refetch}
          className="min-h-0"
        />
      ) : null}

      {state.status === "success" && state.data.length === 0 ? (
        <EmptyState
          className="min-h-0"
          message={t("settings.profiles.empty")}
          action={{ label: t("settings.profiles.new"), onClick: openCreate }}
        />
      ) : null}

      {state.status === "success" && state.data.length > 0 ? (
        <div className="flex flex-col gap-2">
          {state.data.map((profile) => (
            <Card
              key={profile.id}
              padding="compact"
              className="flex items-center justify-between gap-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{profile.name}</span>
                  <Badge className="shrink-0">
                    {t(`settings.profiles.role.${profile.defaultRole}`)}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-fg-muted">
                  <span className="font-mono">{profile.runtime}</span>
                  <span className="truncate">
                    {providerNameById.get(profile.providerId) ?? profile.providerId}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t("settings.profiles.editLabel", { name: profile.name })}
                  onClick={() => openEdit(profile)}
                >
                  <Pencil aria-hidden size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={removingIds.has(profile.id)}
                  aria-label={t("settings.profiles.removeLabel", { name: profile.name })}
                  onClick={() => void handleRemove(profile)}
                >
                  <Trash2 aria-hidden size={14} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <ProfileEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        profile={editing}
        onSaved={handleSaved}
      />
    </section>
  );
}
