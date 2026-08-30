import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { respondSessionPermission } from "../../lib/session-run";
import { useSessionStore } from "../../stores/session";

/**
 * 权限审批横幅（T4.2 / §7）：当前轮有上浮的权限请求时呈现，用户二选一。
 * 读 session store 的 pendingPermission；回执经 session:respond-permission 下行到适配器。
 * 无待批准时不渲染。
 */
export function PermissionBanner(): ReactElement | null {
  const { t } = useTranslation();
  const pending = useSessionStore((s) => s.pendingPermission);
  const [busy, setBusy] = useState(false);

  if (pending === null) {
    return null;
  }

  const respond = async (decision: "allow" | "deny"): Promise<void> => {
    setBusy(true);
    await respondSessionPermission({
      turnId: pending.turnId,
      requestId: pending.requestId,
      decision,
    });
    setBusy(false);
  };

  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <span className="text-xs font-medium text-fg">{t("session.permissionTitle")}</span>
        <span className="text-sm text-fg">{pending.summary}</span>
        {pending.detail !== undefined ? (
          <span className="text-xs text-fg-muted">{pending.detail}</span>
        ) : null}
        {pending.diff !== undefined ? (
          <pre className="max-h-40 overflow-auto rounded bg-surface p-2 font-mono text-xs text-fg-muted">
            {pending.diff}
          </pre>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond("allow")}>
            {t("session.permissionAllow")}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond("deny")}>
            {t("session.permissionDeny")}
          </Button>
        </div>
      </div>
    </div>
  );
}
