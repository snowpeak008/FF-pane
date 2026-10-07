/**
 * 工作台自配置草案确认框。取消或关掉都不落盘。
 */

import type { ProjectConfigRoute } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { WorkbenchConfigDraftEvent } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";

function routeText(route: ProjectConfigRoute | undefined): string {
  if (route === undefined) {
    return "—";
  }
  const parts: string[] = [route.connectionMode];
  if (route.providerId !== undefined) {
    parts.push(route.providerId);
  }
  if (route.model !== undefined) {
    parts.push(route.model);
  }
  if (route.reasoningEffort !== undefined) {
    parts.push(route.reasoningEffort);
  }
  return parts.join(" · ");
}

function formatBag(record: Readonly<Record<string, string>> | undefined): string {
  if (record === undefined) {
    return "—";
  }
  const lines = Object.entries(record).map(([key, value]) => `${key}=${value}`);
  return lines.length > 0 ? lines.join("\n") : "—";
}

function FieldLine({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}): ReactElement {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm" data-testid={testId}>
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg select-text break-all whitespace-pre-wrap">{value}</span>
    </div>
  );
}

function ConfigFields({ pending }: { readonly pending: WorkbenchConfigDraftEvent }): ReactElement {
  const { t } = useTranslation();
  const payload = pending.payload;
  if (payload.kind === "config") {
    const draft = payload.draft;
    const current = payload.current;
    const rows: { key: string; label: string; before: string; after: string }[] = [
      {
        key: "name",
        label: t("workbench.configDraft.field.name"),
        before: current?.name ?? t("workbench.configDraft.currentEmpty"),
        after: draft.name,
      },
      {
        key: "default",
        label: t("workbench.configDraft.field.isDefault"),
        before:
          current === undefined
            ? t("workbench.configDraft.currentEmpty")
            : current.isDefault
              ? t("workbench.configDraft.yes")
              : t("workbench.configDraft.no"),
        after: draft.isDefault ? t("workbench.configDraft.yes") : t("workbench.configDraft.no"),
      },
      {
        key: "scope",
        label: t("workbench.configDraft.field.projectIds"),
        before:
          current === undefined
            ? t("workbench.configDraft.currentEmpty")
            : (current.projectIds ?? []).join(", ") || t("workbench.configDraft.scopeOpen"),
        after: (draft.projectIds ?? []).join(", ") || t("workbench.configDraft.scopeOpen"),
      },
      {
        key: "permission",
        label: t("workbench.configDraft.field.defaultPermission"),
        before:
          current === undefined
            ? t("workbench.configDraft.currentEmpty")
            : (current.defaultPermission ?? t("workbench.configDraft.unset")),
        after: draft.defaultPermission ?? t("workbench.configDraft.unset"),
      },
      {
        key: "claude",
        label: t("workbench.configDraft.field.claude"),
        before:
          current === undefined
            ? t("workbench.configDraft.currentEmpty")
            : routeText(current.claude),
        after: routeText(draft.claude),
      },
      {
        key: "codex",
        label: t("workbench.configDraft.field.codex"),
        before:
          current === undefined
            ? t("workbench.configDraft.currentEmpty")
            : routeText(current.codex),
        after: routeText(draft.codex),
      },
      {
        key: "grok",
        label: t("workbench.configDraft.field.grok"),
        before:
          current === undefined ? t("workbench.configDraft.currentEmpty") : routeText(current.grok),
        after: routeText(draft.grok),
      },
    ];
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5" data-testid="config-draft-fields">
          {rows.map((row) => (
            <FieldLine
              key={row.key}
              label={row.label}
              value={row.after}
              {...(row.key === "name" ? { testId: "config-draft-field-name" } : {})}
            />
          ))}
        </div>
        <div className="flex flex-col gap-1.5" data-testid="config-draft-diff">
          <p className="text-xs font-medium text-fg-muted">
            {t("workbench.configDraft.diffHeading")}
          </p>
          {rows.map((row) => (
            <p key={row.key} className="text-sm text-fg select-text">
              {t("workbench.configDraft.diffLine", {
                label: row.label,
                before: row.before,
                after: row.after,
              })}
            </p>
          ))}
        </div>
      </div>
    );
  }
  if (payload.kind === "provider") {
    const draft = payload.draft;
    const current = payload.current;
    const modelText = draft.models.map((model) => model.id).join(", ");
    return (
      <div className="flex flex-col gap-1.5" data-testid="config-draft-fields">
        <FieldLine
          label={t("workbench.configDraft.field.name")}
          value={draft.name}
          testId="config-draft-field-name"
        />
        <FieldLine label={t("workbench.configDraft.field.templateId")} value={draft.templateId} />
        <FieldLine label={t("workbench.configDraft.field.baseUrl")} value={draft.baseUrl ?? "—"} />
        <FieldLine label={t("workbench.configDraft.field.models")} value={modelText || "—"} />
        <FieldLine
          label={t("workbench.configDraft.field.defaultModelId")}
          value={draft.defaultModelId ?? "—"}
        />
        <FieldLine
          label={t("workbench.configDraft.field.embeddingModel")}
          value={draft.embeddingModel ?? "—"}
        />
        <FieldLine label={t("workbench.configDraft.field.proxy")} value={draft.proxy ?? "—"} />
        <FieldLine
          label={t("workbench.configDraft.field.timeoutS")}
          value={draft.timeoutS !== undefined ? String(draft.timeoutS) : "—"}
        />
        <FieldLine
          label={t("workbench.configDraft.field.extraEnv")}
          value={formatBag(draft.extraEnv)}
          testId="config-draft-field-extra-env"
        />
        <FieldLine
          label={t("workbench.configDraft.field.options")}
          value={formatBag(draft.options)}
          testId="config-draft-field-options"
        />
        <FieldLine
          label={t("workbench.configDraft.field.enabled")}
          value={draft.enabled ? t("workbench.configDraft.yes") : t("workbench.configDraft.no")}
        />
        <div data-testid="config-draft-diff">
          <p className="text-xs font-medium text-fg-muted">
            {t("workbench.configDraft.diffHeading")}
          </p>
          <p className="text-sm text-fg">
            {t("workbench.configDraft.diffLine", {
              label: t("workbench.configDraft.field.name"),
              before: current?.name ?? t("workbench.configDraft.currentEmpty"),
              after: draft.name,
            })}
          </p>
        </div>
      </div>
    );
  }
  return (
    <p className="text-sm text-fg" data-testid="config-draft-fields">
      {pending.summary}
    </p>
  );
}

function DraftDialog({ pending }: { readonly pending: WorkbenchConfigDraftEvent }): ReactElement {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const creating = pending.payload.kind !== "profile" && pending.payload.targetId === undefined;
  const title = creating
    ? t("workbench.configDraft.titleCreate")
    : t("workbench.configDraft.titleUpdate");

  const respond = async (decision: "confirm" | "reject"): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const settled = await invokeQuery("workbench:respond-config-draft", {
      windowId: pending.windowId,
      draftId: pending.draftId,
      decision,
      ...(decision === "confirm" && apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      ...(decision === "reject" ? { reason: t("workbench.configDraft.rejectedReason") } : {}),
    });
    setBusy(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    if (!settled.data.ok) {
      setError(settled.data.message ?? t("workbench.configDraft.applyFailed"));
      return;
    }
    if (decision === "confirm") {
      toast.success(t("workbench.configDraft.confirmed"));
    }
  };

  return (
    <Dialog open>
      <DialogContent size="form" showClose={false} data-testid="config-draft-dialog">
        <DialogHeader title={title} description={t("workbench.configDraft.description")} />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          <ConfigFields pending={pending} />
          {pending.needsApiKey ? (
            <label className="flex flex-col gap-1 text-sm" htmlFor="config-draft-api-key">
              <span>{t("workbench.configDraft.apiKeyLabel")}</span>
              <span className="text-xs text-fg-muted">{t("workbench.configDraft.apiKeyHint")}</span>
              <input
                id="config-draft-api-key"
                data-testid="config-draft-api-key"
                type="password"
                autoComplete="off"
                className="rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          ) : null}
          {error !== undefined ? <p className="text-sm text-danger-text">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            data-testid="config-draft-cancel"
            disabled={busy}
            onClick={() => void respond("reject")}
          >
            {t("workbench.configDraft.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="config-draft-confirm"
            disabled={busy || (pending.needsApiKey && apiKey.trim() === "")}
            onClick={() => void respond("confirm")}
          >
            {t("workbench.configDraft.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkbenchConfigDraftDialog(): ReactElement | null {
  const [queue, setQueue] = useState<readonly WorkbenchConfigDraftEvent[]>([]);
  useSubscription("workbench:config-draft", (payload) => {
    setQueue((current) => [...current.filter((item) => item.draftId !== payload.draftId), payload]);
  });
  useSubscription("workbench:config-draft-resolved", (payload) => {
    setQueue((current) => current.filter((item) => item.draftId !== payload.draftId));
  });
  const pending = queue[0];
  if (pending === undefined) {
    return null;
  }
  return <DraftDialog key={pending.draftId} pending={pending} />;
}
