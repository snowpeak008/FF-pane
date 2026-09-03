import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { respondSessionPermission } from "../../lib/session-run";
import type { PendingPermission } from "../../stores/session";
import { pendingPermissionsOf, useSessionStore } from "../../stores/session";

function PermissionRequestRow({ pending }: { readonly pending: PendingPermission }): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

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
  );
}

/**
 * 权限审批横幅（T4.2 / §7 → T8.3b 多轮）：任一在飞轮有上浮的权限请求时呈现，用户二选一。
 * 多轮同时 blocked 时逐条列出（按轮开始序），各自独立回执——回执经
 * session:respond-permission 按 turnId 下行到对应轮的适配器。
 * **跨会话也列**：并发的 Worker 轮在别的会话里 blocked 时，用户当前正看着的页面
 * 是它唯一的审批入口（§7 逐次确认不能因为"没切过去看"就永远挂着）。
 * 无待批准时不渲染。
 */
export function PermissionBanner(): ReactElement | null {
  const activeTurns = useSessionStore((s) => s.activeTurns);
  const pendings = pendingPermissionsOf(activeTurns);

  if (pendings.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-border bg-surface-sunken px-4 py-3">
      <div className="flex flex-col gap-3">
        {pendings.map((pending) => (
          <PermissionRequestRow key={`${pending.turnId}:${pending.requestId}`} pending={pending} />
        ))}
      </div>
    </div>
  );
}
