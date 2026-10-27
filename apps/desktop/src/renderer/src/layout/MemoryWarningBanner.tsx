/**
 * 内存偏高提示（T11.0d）：主进程每 5 分钟量一次，超过警戒线时发 app:memory-warning。
 * 常驻在内容列顶上，不弹窗、不抢焦点；点「知道了」本次运行不再显示。
 */

import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EventPayload } from "../../../shared-ipc/contracts";
import { useSubscription } from "../ipc/useSubscription";

export function MemoryWarningBanner(): ReactElement | null {
  const { t } = useTranslation();
  const [warning, setWarning] = useState<EventPayload<"app:memory-warning"> | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useSubscription("app:memory-warning", (payload) => {
    setWarning(payload);
  });

  if (warning === null || dismissed) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="memory-warning"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-warning-surface px-3 py-1.5 text-xs text-warning-text"
    >
      <span className="min-w-0 flex-1">
        {warning.kind === "main"
          ? t("app.memoryWarning.main", { mb: warning.mb })
          : t("app.memoryWarning.renderer", { mb: warning.mb })}
      </span>
      <button
        type="button"
        className="rounded-sm px-2 py-0.5 hover:bg-surface-hover"
        onClick={() => setDismissed(true)}
      >
        {t("app.memoryWarning.dismiss")}
      </button>
    </div>
  );
}
