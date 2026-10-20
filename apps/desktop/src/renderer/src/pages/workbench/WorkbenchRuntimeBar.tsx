/**
 * 工作台运行状态条：每 3 秒取一次本项目窗口的状态和本机资源。
 * 资源低于设置里的开窗门槛时标红：此时管理者开新窗口会被拒绝。
 */

import type { ProjectId } from "@ff-pane/shared";
import { type ReactElement, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { WorkbenchWindowRuntimeStatus } from "../../../../shared-ipc/contracts";
import { invokeQuery } from "../../ipc/query";
import { cn } from "../../lib/cn";
import { useWorkbenchRuntimeStore } from "../../stores/workbench-runtime";

const POLL_MS = 3000;

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function WorkbenchRuntimeBar({
  projectId,
}: {
  readonly projectId: ProjectId;
}): ReactElement {
  const { t } = useTranslation();
  const resources = useWorkbenchRuntimeStore((s) => s.resources);
  const apply = useWorkbenchRuntimeStore((s) => s.apply);
  const clear = useWorkbenchRuntimeStore((s) => s.clear);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const settled = await invokeQuery("workbench:runtime-status", { projectId });
      if (!cancelled && settled.status === "success") {
        apply(settled.data);
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clear();
    };
  }, [apply, clear, projectId]);

  if (resources === null) {
    return <div className="hidden" />;
  }
  const disks = Object.entries(resources.freeDiskBytes);
  const low =
    (resources.minFreeMemoryBytes > 0 &&
      resources.freeMemoryBytes < resources.minFreeMemoryBytes) ||
    (resources.minFreeDiskBytes > 0 && disks.some(([, free]) => free < resources.minFreeDiskBytes));
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-border px-2 py-0.5 text-2xs",
        low ? "text-danger-text" : "text-fg-muted",
      )}
      data-testid="workbench-runtime-bar"
    >
      <span className="min-w-0 truncate">
        {t("workbench.runtime.resources", {
          memory: gb(resources.freeMemoryBytes),
          disk: disks
            .map(([root, free]) => t("workbench.runtime.disk", { root, free: gb(free) }))
            .join(t("workbench.runtime.sep")),
        })}
      </span>
      {low ? <span>{t("workbench.runtime.low")}</span> : null}
    </div>
  );
}

/** 窗口标题栏上的平台状态：空闲 / 忙 / 等批准，长时间无输出、持锁等锁、上次 API 出错。 */
export function RuntimeBadges({
  status,
}: {
  readonly status: WorkbenchWindowRuntimeStatus;
}): ReactElement {
  const { t } = useTranslation();
  const quietMinutes =
    status.phase === "busy" && status.quietSeconds !== undefined && status.quietSeconds >= 120
      ? Math.floor(status.quietSeconds / 60)
      : undefined;
  const badge = "ml-1 rounded-sm px-1 text-2xs";
  return (
    <>
      {status.online ? (
        <span
          className={cn(badge, "bg-primary text-primary-fg")}
          data-testid="workbench-runtime-online"
        >
          {t("workbench.runtime.online")}
        </span>
      ) : null}
      <span
        className={cn(
          badge,
          status.phase === "blocked"
            ? "bg-warning-surface text-warning-text"
            : "bg-surface-active text-fg-muted",
        )}
        data-testid="workbench-runtime-phase"
        data-phase={status.phase}
      >
        {t(`workbench.runtime.${status.phase}`)}
      </span>
      {quietMinutes !== undefined ? (
        <span className={cn(badge, "bg-warning-surface text-warning-text")}>
          {t("workbench.runtime.quiet", { minutes: quietMinutes })}
        </span>
      ) : null}
      {status.holdingLocks.length > 0 ? (
        <span
          className={cn(badge, "bg-surface-active text-fg")}
          data-testid="workbench-runtime-holding"
        >
          {t("workbench.runtime.holding", {
            names: status.holdingLocks.join(t("workbench.runtime.sep")),
          })}
        </span>
      ) : null}
      {status.waitingLocks.length > 0 ? (
        <span
          className={cn(badge, "bg-surface-active text-fg-muted")}
          data-testid="workbench-runtime-waiting"
        >
          {t("workbench.runtime.waiting", {
            names: status.waitingLocks.join(t("workbench.runtime.sep")),
          })}
        </span>
      ) : null}
      {status.memory !== undefined ? (
        <span
          className={cn(badge, "bg-surface-active text-fg-muted")}
          data-testid="workbench-runtime-memory"
        >
          {t("workbench.runtime.memory", {
            memory: gb(status.memory.workingSetBytes),
            count: status.memory.processCount,
          })}
        </span>
      ) : null}
      {status.lastApiError !== undefined ? (
        <span className={cn(badge, "bg-danger-surface text-danger-text")}>
          {t("workbench.runtime.apiError", { reason: status.lastApiError })}
        </span>
      ) : null}
    </>
  );
}
