/**
 * 工作台运行状态：每 3 秒取一次本项目窗口的状态和本机资源。
 * 平时不占一行（§9 界面精简）：资源低于设置里的开窗门槛时才出一行红字（此时管理者开新窗口会被拒绝），
 * 平时的可用内存和磁盘放在顶部内存图标的悬浮提示里。
 */

import type { ProjectId } from "@ff-pane/shared";
import { MemoryStick } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkbenchRuntimeStatusResponse,
  WorkbenchWindowRuntimeStatus,
} from "../../../../shared-ipc/contracts";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery } from "../../ipc/query";
import { cn } from "../../lib/cn";
import { useWorkbenchRuntimeStore } from "../../stores/workbench-runtime";

const POLL_MS = 3000;

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

type Resources = WorkbenchRuntimeStatusResponse["resources"];

function isLow(resources: Resources): boolean {
  return (
    (resources.minFreeMemoryBytes > 0 &&
      resources.freeMemoryBytes < resources.minFreeMemoryBytes) ||
    (resources.minFreeDiskBytes > 0 &&
      Object.values(resources.freeDiskBytes).some((free) => free < resources.minFreeDiskBytes))
  );
}

function useResourcesText(resources: Resources | null): string | undefined {
  const { t } = useTranslation();
  if (resources === null) {
    return undefined;
  }
  return t("workbench.runtime.resources", {
    memory: gb(resources.freeMemoryBytes),
    disk: Object.entries(resources.freeDiskBytes)
      .map(([root, free]) => t("workbench.runtime.disk", { root, free: gb(free) }))
      .join(t("workbench.runtime.sep")),
  });
}

export function WorkbenchRuntimeBar({
  projectId,
}: {
  readonly projectId: ProjectId;
}): ReactElement | null {
  const { t } = useTranslation();
  const resources = useWorkbenchRuntimeStore((s) => s.resources);
  const apply = useWorkbenchRuntimeStore((s) => s.apply);
  const clear = useWorkbenchRuntimeStore((s) => s.clear);
  const text = useResourcesText(resources);

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

  if (resources === null || !isLow(resources)) {
    return null;
  }
  return (
    <div
      className="flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-border px-2 py-0.5 text-2xs text-danger-text"
      data-testid="workbench-runtime-bar"
    >
      <span className="min-w-0 truncate">{text}</span>
      <span>{t("workbench.runtime.low")}</span>
    </div>
  );
}

/** 顶部的内存图标：悬浮看可用内存和磁盘。偏低时图标变红（同时会出上面那行红字）。 */
export function WorkbenchResourcesIcon(): ReactElement | null {
  const resources = useWorkbenchRuntimeStore((s) => s.resources);
  const text = useResourcesText(resources);
  if (resources === null || text === undefined) {
    return null;
  }
  const low = isLow(resources);
  return (
    <Tooltip content={text}>
      <span
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-sm",
          low ? "text-danger-text" : "text-fg-muted",
        )}
        role="img"
        aria-label={text}
        data-testid="workbench-resources-icon"
      >
        <MemoryStick aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

/** 窗口进程这一层的状态（由标题栏传入）。 */
export type WindowLifecycle = "running" | "exited" | "stopped" | "starting";

type DotState = "stopped" | "starting" | "idle" | "busy" | "blocked" | "unknown" | "error";

function dotState(
  lifecycle: WindowLifecycle,
  status: WorkbenchWindowRuntimeStatus | undefined,
): DotState {
  if (lifecycle === "exited") {
    return "error";
  }
  if (lifecycle !== "running") {
    return lifecycle;
  }
  if (status === undefined) {
    return "unknown";
  }
  if (status.apiPaused === true || status.lastApiError !== undefined) {
    return "error";
  }
  return status.phase;
}

const DOT_CLASS: Record<DotState, string> = {
  stopped: "bg-fg-subtle",
  starting: "bg-fg-subtle animate-pulse",
  unknown: "bg-success/50",
  idle: "bg-success",
  busy: "bg-status-running animate-pulse",
  blocked: "bg-warning",
  error: "bg-danger",
};

/**
 * 窗口名前的状态点：灰 = 已停止，绿 = 空闲，蓝闪 = 忙，黄 = 等批准，红 = 出错 / 已退出。
 * 在线监管时外加一圈。文字只在悬浮提示和读屏里。自己订阅这个窗口的状态，状态变了只重画这个点。
 */
export function WindowStatusDot({
  windowId,
  lifecycle,
}: {
  readonly windowId: string;
  readonly lifecycle: WindowLifecycle;
}): ReactElement {
  const { t } = useTranslation();
  const status = useWorkbenchRuntimeStore((s) => s.windows[windowId]);
  const state = dotState(lifecycle, status);
  const label = statusLabel(t, lifecycle, status);
  return (
    <Tooltip content={label}>
      <span
        className="relative inline-flex size-4 shrink-0 items-center justify-center"
        role="img"
        aria-label={label}
        data-testid="workbench-window-status"
        data-state={state}
        data-phase={status?.phase ?? "unknown"}
      >
        {status?.online === true && lifecycle === "running" ? (
          <span
            className="absolute inset-0.5 rounded-full ring-1 ring-primary"
            data-testid="workbench-runtime-online"
          />
        ) : null}
        <span className={cn("size-2 rounded-full", DOT_CLASS[state])} />
      </span>
    </Tooltip>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function statusLabel(
  t: Translate,
  lifecycle: WindowLifecycle,
  status: WorkbenchWindowRuntimeStatus | undefined,
): string {
  if (lifecycle !== "running") {
    return t(`workbench.window.status.${lifecycle}`);
  }
  const parts = [
    t(`workbench.runtime.${status?.phase ?? "unknown"}`),
    ...(status?.online === true ? [t("workbench.runtime.online")] : []),
  ];
  return parts.join(t("workbench.runtime.dot"));
}

/** 要用户留意的状态，不悬浮也看得见：等批准、长时间无输出、因出错暂停、上次出错。 */
export function WindowAttentionBadges({
  windowId,
}: {
  readonly windowId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const status = useWorkbenchRuntimeStore((s) => s.windows[windowId]);
  if (status === undefined) {
    return null;
  }
  const quietMinutes =
    status.phase === "busy" && status.quietSeconds !== undefined && status.quietSeconds >= 120
      ? Math.floor(status.quietSeconds / 60)
      : undefined;
  return (
    <>
      {status.phase === "blocked" ? (
        <AttentionBadge tone="warning" testId="workbench-runtime-phase">
          {t("workbench.runtime.blocked")}
        </AttentionBadge>
      ) : null}
      {quietMinutes !== undefined ? (
        <AttentionBadge
          tone="warning"
          hint={t("workbench.runtime.quiet", { minutes: quietMinutes })}
        >
          {t("workbench.runtime.quietShort", { minutes: quietMinutes })}
        </AttentionBadge>
      ) : null}
      {status.apiPaused === true ? (
        <AttentionBadge
          tone="warning"
          testId="workbench-runtime-api-paused"
          hint={t("workbench.runtime.apiPaused", { reason: status.lastApiError ?? "" })}
        >
          {t("workbench.runtime.pausedShort")}
        </AttentionBadge>
      ) : status.lastApiError !== undefined ? (
        <AttentionBadge
          tone="danger"
          hint={t("workbench.runtime.apiError", { reason: status.lastApiError })}
        >
          {t("workbench.runtime.errorShort")}
        </AttentionBadge>
      ) : null}
    </>
  );
}

/** 标题栏上要用户动手的小标。有说明时悬浮看全文。 */
export function AttentionBadge({
  tone,
  hint,
  testId,
  children,
  onClick,
}: {
  readonly tone: "warning" | "danger";
  readonly hint?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
  readonly onClick?: () => void;
}): ReactElement {
  const className = cn(
    "shrink-0 rounded-sm px-1 text-2xs font-medium",
    tone === "danger"
      ? "bg-danger-surface text-danger-text"
      : "bg-warning-surface text-warning-text",
  );
  const badge =
    onClick !== undefined ? (
      <button type="button" className={className} data-testid={testId} onClick={onClick}>
        {children}
      </button>
    ) : (
      <span className={className} data-testid={testId}>
        {children}
      </span>
    );
  return hint !== undefined ? <Tooltip content={hint}>{badge}</Tooltip> : badge;
}

/** 窗口详情提示里的运行状态几行：内存进程、持锁等锁、上次出错。只在提示打开时渲染。 */
export function WindowRuntimeDetails({
  windowId,
}: {
  readonly windowId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const status = useWorkbenchRuntimeStore((s) => s.windows[windowId]);
  if (status === undefined) {
    return null;
  }
  return (
    <>
      {status.memory !== undefined ? (
        <DetailRow label={t("workbench.window.details.memory")} testId="workbench-runtime-memory">
          {t("workbench.runtime.memory", {
            memory: gb(status.memory.workingSetBytes),
            count: status.memory.processCount,
          })}
        </DetailRow>
      ) : null}
      {status.holdingLocks.length > 0 ? (
        <DetailRow label={t("workbench.window.details.locks")} testId="workbench-runtime-holding">
          {t("workbench.runtime.holding", {
            names: status.holdingLocks.join(t("workbench.runtime.sep")),
          })}
        </DetailRow>
      ) : null}
      {status.waitingLocks.length > 0 ? (
        <DetailRow label={t("workbench.window.details.locks")} testId="workbench-runtime-waiting">
          {t("workbench.runtime.waiting", {
            names: status.waitingLocks.join(t("workbench.runtime.sep")),
          })}
        </DetailRow>
      ) : null}
      {status.lastApiError !== undefined ? (
        <DetailRow label={t("workbench.window.details.error")}>{status.lastApiError}</DetailRow>
      ) : null}
    </>
  );
}

/** 详情提示里的一行：左边小字标签，右边内容。 */
export function DetailRow({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span className="flex gap-2" data-testid={testId}>
      <span className="w-14 shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </span>
  );
}
