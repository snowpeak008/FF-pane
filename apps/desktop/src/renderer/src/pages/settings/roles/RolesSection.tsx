import type { CustomRole } from "@ff-pane/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
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
import { RoleEditorDialog } from "./RoleEditorDialog";

/**
 * 设置页 · 自定义角色管理区（T8.4 / 设计文档 §3.1）。
 * 内置 Planner/Worker/Reviewer 之外的用户定义角色：名称 + 角色提示词（Prompt 第 1 层）+
 * 权限预设（角色默认信封，参与 §7 交集）。经 Profile.defaultRole 绑定后即可在会话页选用；
 * 被 Profile 引用的角色拒删（先解绑再删，删除保护与 Provider 同款）。
 */
export function RolesSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("roles:list");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRole | undefined>(undefined);
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((role: CustomRole) => {
    setEditing(role);
    setEditorOpen(true);
  }, []);

  const handleSaved = useCallback(
    (role: CustomRole) => {
      refetch();
      toast.success(t("settings.roles.saved", { name: role.name }));
    },
    [refetch, t],
  );

  const handleRemove = useCallback(
    async (role: CustomRole) => {
      setRemovingIds((prev) => new Set(prev).add(role.id));
      const settled = await invokeQuery("roles:remove", { id: role.id });
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(role.id);
        return next;
      });
      if (settled.status === "error") {
        // 拒删（被 Profile 引用）与其他失败同走此路径，原因原文呈现
        toast.error(t("settings.roles.removeError"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(t("settings.roles.removed", { name: role.name }));
    },
    [refetch, t],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-fg">{t("settings.roles.title")}</h2>
          <p className="text-xs text-fg-muted">{t("settings.roles.subtitle")}</p>
        </div>
        {state.status === "success" && state.data.length > 0 ? (
          <Button variant="primary" size="md" onClick={openCreate}>
            <Plus aria-hidden size={16} />
            {t("settings.roles.new")}
          </Button>
        ) : null}
      </div>

      {state.status === "loading" ? <LoadingState variant="list" /> : null}

      {state.status === "error" ? (
        <ErrorState
          summary={t("settings.roles.loadError")}
          error={state.error}
          onRetry={refetch}
          className="min-h-0"
        />
      ) : null}

      {state.status === "success" && state.data.length === 0 ? (
        <EmptyState
          className="min-h-0"
          message={t("settings.roles.empty")}
          action={{ label: t("settings.roles.new"), onClick: openCreate }}
        />
      ) : null}

      {state.status === "success" && state.data.length > 0 ? (
        <div className="flex flex-col gap-2">
          {state.data.map((role) => (
            <Card
              key={role.id}
              padding="compact"
              className="flex items-center justify-between gap-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{role.name}</span>
                  <Badge className="shrink-0">
                    {t(`settings.permission.shellPolicy.${role.permissionPreset.shell}`)}
                  </Badge>
                </div>
                <p className="truncate text-xs text-fg-muted" title={role.systemPrompt}>
                  {role.systemPrompt}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t("settings.roles.editLabel", { name: role.name })}
                  onClick={() => openEdit(role)}
                >
                  <Pencil aria-hidden size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={removingIds.has(role.id)}
                  aria-label={t("settings.roles.removeLabel", { name: role.name })}
                  onClick={() => void handleRemove(role)}
                >
                  <Trash2 aria-hidden size={14} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <RoleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        role={editing}
        onSaved={handleSaved}
      />
    </section>
  );
}
