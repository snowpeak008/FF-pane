import { AlertTriangle } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Input";
import { draftContainsSecretShape } from "../../lib/secret-shape";
import { respondConfigDraft } from "../../lib/session-run";
import type { PendingConfigDraft } from "../../stores/session";
import { pendingConfigDraftsOf, useSessionStore } from "../../stores/session";

/** 一行字段（键值对呈现；值为空时整行不显示）。 */
function FieldRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement | null {
  if (value.length === 0) {
    return null;
  }
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-36 shrink-0 text-xs text-fg-muted">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg select-text">
        {value}
      </span>
    </div>
  );
}

/** 草案全字段的只读呈现（合同：确认对话框展示草案全字段）。**物理不含密钥字段**。 */
function DraftFields({ pending }: { readonly pending: PendingConfigDraft }): ReactElement {
  const { t } = useTranslation();
  const { payload } = pending;
  if (payload.kind === "provider") {
    const draft = payload.draft;
    return (
      <div className="flex flex-col gap-1.5" data-testid="config-draft-fields">
        <FieldRow label={t("session.configDraft.field.name")} value={draft.name} />
        <FieldRow label={t("session.configDraft.field.templateId")} value={draft.templateId} />
        <FieldRow label={t("session.configDraft.field.baseUrl")} value={draft.baseUrl ?? ""} />
        <FieldRow
          label={t("session.configDraft.field.models")}
          value={draft.models
            .map((m) => `${m.id}${m.kind !== undefined ? ` (${m.kind})` : ""}`)
            .join(", ")}
        />
        <FieldRow
          label={t("session.configDraft.field.defaultModel")}
          value={draft.defaultModelId ?? ""}
        />
        <FieldRow
          label={t("session.configDraft.field.embeddingModel")}
          value={draft.embeddingModel ?? ""}
        />
        <FieldRow label={t("session.configDraft.field.proxy")} value={draft.proxy ?? ""} />
        <FieldRow
          label={t("session.configDraft.field.timeoutS")}
          value={draft.timeoutS !== undefined ? String(draft.timeoutS) : ""}
        />
        <FieldRow
          label={t("session.configDraft.field.enabled")}
          value={draft.enabled ? t("common.yes") : t("common.no")}
        />
      </div>
    );
  }
  const draft = payload.draft;
  const preset = draft.permissionPreset;
  return (
    <div className="flex flex-col gap-1.5" data-testid="config-draft-fields">
      <FieldRow label={t("session.configDraft.field.name")} value={draft.name} />
      <FieldRow label={t("session.configDraft.field.runtime")} value={draft.runtime} />
      <FieldRow label={t("session.configDraft.field.providerId")} value={draft.providerId} />
      <FieldRow label={t("session.configDraft.field.model")} value={draft.model ?? ""} />
      <FieldRow
        label={t("session.configDraft.field.defaultRole")}
        value={String(draft.defaultRole)}
      />
      <FieldRow
        label={t("session.configDraft.field.permissionPreset")}
        value={`read [${preset.readPaths.join(", ")}] · write [${preset.writePaths.join(", ")}] · shell ${preset.shell} · network ${preset.network ? "on" : "off"}`}
      />
      <FieldRow
        label={t("session.configDraft.field.outputLanguage")}
        value={draft.outputLanguage ?? ""}
      />
      {draft.genericExec !== undefined ? (
        <FieldRow
          label={t("session.configDraft.field.genericExec")}
          value={`${draft.genericExec.command} ${draft.genericExec.args.join(" ")} (${draft.genericExec.taskDelivery})`}
        />
      ) : null}
    </div>
  );
}

/** 单份草案的确认对话框主体。 */
function DraftDialog({ pending }: { readonly pending: PendingConfigDraft }): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isUpdate = pending.payload.targetId !== undefined;
  const kindLabel =
    pending.payload.kind === "provider"
      ? t("session.configDraft.kindProvider")
      : t("session.configDraft.kindProfile");
  const title = isUpdate
    ? t("session.configDraft.titleUpdate", { kind: kindLabel })
    : t("session.configDraft.titleCreate", { kind: kindLabel });
  // 新建且类型需要 key 时，密钥是落盘校验的必填项（§4.2）——空 key 的确认必然失败，
  // 不如在 UI 就禁用，引导语说明这是用户亲手补填、AI 接触不到的通道。
  const confirmDisabled = busy || (pending.needsApiKey && apiKey.trim().length === 0);

  const respond = async (decision: "confirm" | "reject"): Promise<void> => {
    setBusy(true);
    setError(null);
    const trimmedKey = apiKey.trim();
    const ack = await respondConfigDraft({
      turnId: pending.turnId,
      draftId: pending.draftId,
      decision,
      ...(decision === "confirm" && trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
    });
    setBusy(false);
    if (!ack.ok && decision === "confirm") {
      // 落盘失败（校验 / 存储）：留在对话框里给用户改或改为拒绝
      setError(ack.message ?? t("session.configDraft.applyFailed"));
      return;
    }
    if (decision === "confirm" && ack.ok) {
      toast.success(t("session.configDraft.confirmed"));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 关闭手势（Esc / 遮罩）= 拒绝：不能留一个 Agent 永远等不到答案的悬置草案
        if (!open && !busy) {
          void respond("reject");
        }
      }}
    >
      <DialogContent size="form" showClose={false} data-testid="config-draft-dialog">
        <DialogHeader title={title} description={t("session.configDraft.description")} />
        <DialogBody className="flex flex-col gap-3">
          <span className="text-sm text-fg select-text" data-testid="config-draft-summary">
            {pending.summary}
          </span>
          <DraftFields pending={pending} />
          {/* 密钥形状警示（T9.2 ⑤，T9.1 验收裁定）：仅提示不拦截，用户仍可自行决定 */}
          {draftContainsSecretShape(pending.payload.draft) ? (
            <div
              className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-2"
              data-testid="config-draft-secret-warning"
            >
              <AlertTriangle aria-hidden className="mt-0.5 shrink-0 text-warning-text" size={14} />
              <span className="text-xs text-warning-text">
                {t("session.configDraft.secretShapeWarning")}
              </span>
            </div>
          ) : null}
          {pending.needsApiKey ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <label className="text-xs font-medium text-fg" htmlFor="config-draft-api-key">
                {t("session.configDraft.apiKeyLabel")}
              </label>
              <span className="text-2xs text-fg-subtle">{t("session.configDraft.apiKeyHint")}</span>
              <Input
                id="config-draft-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={t("session.configDraft.apiKeyPlaceholder")}
              />
            </div>
          ) : null}
          {error !== null ? (
            <span className="text-xs text-danger-text select-text">{error}</span>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => void respond("reject")}>
            {t("session.configDraft.reject")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={confirmDisabled}
            loading={busy}
            onClick={() => void respond("confirm")}
          >
            {t("session.configDraft.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 配置草案确认对话框（T9.1 铁律 2：写操作强制用户确认，照权限审批款式）。
 *
 * 全局挂载（App.tsx，与 SessionEventBridge 同层）而不是长在会话页：sidecar 正拿着
 * 草案阻塞等待用户裁决，用户此刻可能在任何页面——权限横幅「跨会话也列」的论证
 * （PermissionBanner）对它同样成立，而对话框比横幅更需要全局：它是模态的。
 * 多份并存时只呈现最早的一份（sidecar 串行，同轮至多一份；跨轮并发时逐份处理）。
 */
export function ConfigDraftDialog(): ReactElement | null {
  const activeTurns = useSessionStore((s) => s.activeTurns);
  const pendings = pendingConfigDraftsOf(activeTurns);
  const first = pendings[0];
  if (first === undefined) {
    return null;
  }
  // key 换草案即重挂：apiKey / error 等本地态不得串到下一份草案
  return <DraftDialog key={first.draftId} pending={first} />;
}
