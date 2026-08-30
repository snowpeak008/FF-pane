import type { Provider } from "@ff-pane/shared";
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
import { ProviderEditorDialog } from "./ProviderEditorDialog";

function ProviderRow({
  provider,
  onEdit,
  onRemove,
  removing,
}: {
  readonly provider: Provider;
  readonly onEdit: (provider: Provider) => void;
  readonly onRemove: (provider: Provider) => void;
  readonly removing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const chatCount = provider.models.filter((m) => m.kind === "chat").length;
  return (
    <Card padding="compact" className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{provider.name}</span>
          <Badge className="shrink-0">{t(`settings.providers.type.${provider.type}`)}</Badge>
          {!provider.enabled ? (
            <Badge className="shrink-0 text-fg-subtle">{t("settings.providers.disabled")}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          {provider.baseUrl !== undefined ? (
            <span className="truncate font-mono select-text" title={provider.baseUrl}>
              {provider.baseUrl}
            </span>
          ) : null}
          <span className="shrink-0">
            {t("settings.providers.modelCount", { count: chatCount })}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t("settings.providers.editLabel", { name: provider.name })}
          onClick={() => onEdit(provider)}
        >
          <Pencil aria-hidden size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          disabled={removing}
          aria-label={t("settings.providers.removeLabel", { name: provider.name })}
          onClick={() => onRemove(provider)}
        >
          <Trash2 aria-hidden size={14} />
        </Button>
      </div>
    </Card>
  );
}

/**
 * 设置页 · Provider 管理区（W3.2a / 设计文档 §4）。
 * 列表三态齐全；新建 / 编辑走同一对话框；删除走可撤销 toast（§6.3）——
 * 但删除会连带清除密钥，无法真正"复原"密文，故撤销仅重开编辑器让用户重填（诚实处理）。
 */
export function ProvidersSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("providers:list");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | undefined>(undefined);
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((provider: Provider) => {
    setEditing(provider);
    setEditorOpen(true);
  }, []);

  const handleSaved = useCallback(
    (provider: Provider) => {
      refetch();
      toast.success(t("settings.providers.saved", { name: provider.name }));
    },
    [refetch, t],
  );

  const handleRemove = useCallback(
    async (provider: Provider) => {
      setRemovingIds((prev) => new Set(prev).add(provider.id));
      const settled = await invokeQuery("providers:remove", { id: provider.id });
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(provider.id);
        return next;
      });
      if (settled.status === "error") {
        toast.error(t("settings.providers.removeError"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(t("settings.providers.removed", { name: provider.name }));
    },
    [refetch, t],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-fg">{t("settings.providers.title")}</h2>
          <p className="text-xs text-fg-muted">{t("settings.providers.subtitle")}</p>
        </div>
        {state.status === "success" && state.data.length > 0 ? (
          <Button variant="primary" size="md" onClick={openCreate}>
            <Plus aria-hidden size={16} />
            {t("settings.providers.new")}
          </Button>
        ) : null}
      </div>

      {state.status === "loading" ? <LoadingState variant="list" /> : null}

      {state.status === "error" ? (
        <ErrorState
          summary={t("settings.providers.loadError")}
          error={state.error}
          onRetry={refetch}
          className="min-h-0"
        />
      ) : null}

      {state.status === "success" && state.data.length === 0 ? (
        <EmptyState
          className="min-h-0"
          message={t("settings.providers.empty")}
          action={{ label: t("settings.providers.new"), onClick: openCreate }}
        />
      ) : null}

      {state.status === "success" && state.data.length > 0 ? (
        <div className="flex flex-col gap-2">
          {state.data.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              removing={removingIds.has(provider.id)}
              onEdit={openEdit}
              onRemove={(p) => void handleRemove(p)}
            />
          ))}
        </div>
      ) : null}

      <ProviderEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        provider={editing}
        onSaved={handleSaved}
      />
    </section>
  );
}
