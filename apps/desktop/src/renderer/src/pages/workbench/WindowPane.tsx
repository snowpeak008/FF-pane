/**
 * 工作台窗口壳：标题栏 + 状态 + 操作 + TerminalView（T10.2 / T10.4 / T10.5）。
 */

import type { WorkbenchPermissionLevel, WorkbenchRole, WorkbenchWindow } from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  WORKBENCH_PERMISSION_LEVELS,
  WORKBENCH_ROLES,
} from "@ff-pane/shared";
import { Bot, Columns2, Maximize2, Minimize2, Rows2, SquareTerminal, X } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { useSubscription } from "../../ipc/useSubscription";
import { cn } from "../../lib/cn";
import { useWorkbenchStore } from "../../stores/workbench";
import { TerminalView } from "./TerminalView";

export interface WindowPaneProps {
  readonly window: WorkbenchWindow;
  readonly projectRoot: string;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onToggleMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onTerminalIdChange: (terminalId: string | undefined) => void;
  readonly onCwdFallback: () => void;
}

export function WindowPane({
  window,
  projectRoot,
  focused,
  maximized,
  onFocus,
  onClose,
  onSplitRight,
  onSplitDown,
  onToggleMaximize,
  onRename,
  onTerminalIdChange,
  onCwdFallback,
}: WindowPaneProps): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(window.title);
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [permissionCappedHint, setPermissionCappedHint] = useState(false);
  const [resumeNext, setResumeNext] = useState(false);
  const patchWindow = useWorkbenchStore((s) => s.patchWindow);
  const setWindowPermission = useWorkbenchStore((s) => s.setWindowPermission);
  const applyWindowRole = useWorkbenchStore((s) => s.applyWindowRole);
  const convertWindowToShell = useWorkbenchStore((s) => s.convertWindowToShell);
  const wasCreatedThisSession = useWorkbenchStore((s) => s.wasCreatedThisSession);
  const takeInitialPrompt = useWorkbenchStore((s) => s.takeInitialPrompt);
  const getProjectLayout = useWorkbenchStore((s) => s.getProjectLayout);
  const inbox = useWorkbenchStore((s) => s.inboxByWindow[window.id]);

  const { state: profilesState } = useInvokeQuery("profiles:list");
  const profiles = queryData(profilesState) ?? [];
  const profile = useMemo(
    () => profiles.find((item) => item.id === window.profileId),
    [profiles, window.profileId],
  );

  const isCli = window.kind === "claude" || window.kind === "codex";
  const permission = window.permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;
  const role = window.role ?? DEFAULT_WORKBENCH_ROLE;
  const [editingPermission, setEditingPermission] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<WorkbenchPermissionLevel>(permission);
  const [yoloConfirm, setYoloConfirm] = useState(false);
  const [launchNonce, setLaunchNonce] = useState(0);
  const [manualTurnSignal, setManualTurnSignal] = useState(false);
  const running = exitCode === undefined && window.terminalId !== undefined;
  const autoStart = wasCreatedThisSession(window.id);
  const initialPrompt = useMemo(() => takeInitialPrompt(window.id), [takeInitialPrompt, window.id]);

  const openedByLabel = useMemo(() => {
    if (!isCli) {
      return undefined;
    }
    const openedBy = window.openedBy ?? "user";
    if (openedBy === "user") {
      return t("workbench.permission.openedByUser");
    }
    const parent = getProjectLayout(window.projectId).windows[openedBy.windowId];
    const name = parent?.title ?? openedBy.windowId;
    return t("workbench.permission.openedByWindow", { name });
  }, [getProjectLayout, isCli, t, window.openedBy, window.projectId]);

  const permissionBadgeClass =
    permission === "yolo"
      ? "bg-danger-surface text-danger-text ring-1 ring-danger-text/40"
      : permission === "edit-exec"
        ? "bg-warning-surface text-warning-text"
        : permission === "edit"
          ? "bg-primary/15 text-primary"
          : "bg-surface-active text-fg-muted";

  const roleBadgeClass =
    role === "manager"
      ? "bg-primary text-primary-fg"
      : role === "planner"
        ? "bg-primary-surface text-primary-text"
        : role === "worker"
          ? "bg-warning-surface text-warning-text"
          : role === "reviewer"
            ? "bg-success-surface text-success-text"
            : "bg-surface-active text-fg-muted";

  const chooseRole = (next: WorkbenchRole): void => {
    setRoleMenuOpen(false);
    void applyWindowRole(window.projectId, window.id, next).then((result) => {
      if (!result.ok) {
        toast.error(t("workbench.role.rejected"), { description: result.message });
        return;
      }
      if (result.delivery === "dropped") {
        toast.message(t("workbench.role.dropped"));
      }
    });
  };

  const [deliverPending, setDeliverPending] = useState<{
    count: number;
    mode: "manual" | "blocked" | "busy" | "clear";
  }>({ count: 0, mode: "clear" });

  useSubscription("workbench:deliver-pending", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    setDeliverPending({ count: payload.count, mode: payload.mode });
  });

  useSubscription("workbench:role-notice", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    toast.message(t("workbench.role.dropped"));
  });

  const kindLabel =
    window.kind === "claude"
      ? t("workbench.window.kind.claude")
      : window.kind === "codex"
        ? t("workbench.window.kind.codex")
        : t("workbench.window.kind.shell");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus-on-click
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border bg-surface",
        focused ? "border-primary" : "border-border",
      )}
      data-testid="workbench-window"
      data-window-id={window.id}
      data-window-kind={window.kind}
      onMouseDown={onFocus}
    >
      <div
        className={cn(
          "relative z-10 flex h-7 shrink-0 items-center gap-1 border-b border-border px-1",
          isCli && role === "manager" ? "bg-primary-surface" : "bg-surface-sunken",
        )}
        data-manager={isCli && role === "manager" ? "true" : "false"}
      >
        <span className="flex shrink-0 items-center gap-1 px-1 text-fg-muted" title={kindLabel}>
          {isCli ? <Bot aria-hidden size={12} /> : <SquareTerminal aria-hidden size={12} />}
          <span className="text-2xs font-medium">{kindLabel}</span>
        </span>
        {editing ? (
          <input
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-1 text-xs text-fg"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            ref={(el) => {
              el?.focus();
            }}
            onBlur={() => {
              setEditing(false);
              onRename(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setEditing(false);
                onRename(draft);
              }
              if (event.key === "Escape") {
                setDraft(window.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate px-1 text-left text-xs font-medium text-fg"
            onDoubleClick={() => {
              setDraft(window.title);
              setEditing(true);
            }}
          >
            {window.title}
            {inbox !== undefined && inbox.unread > 0 ? (
              <span
                className="ml-1 rounded-sm bg-danger-surface px-1 text-2xs text-danger-text"
                data-testid="workbench-unread-badge"
              >
                {t("workbench.inbox.unread", { count: inbox.unread })}
              </span>
            ) : null}
            {inbox?.lastReportStatus !== undefined ? (
              <span
                className="ml-1 rounded-sm bg-surface-active px-1 text-2xs text-fg-muted"
                data-testid="workbench-report-badge"
                data-report-status={inbox.lastReportStatus}
              >
                {t(
                  inbox.lastReportStatus === "done"
                    ? "workbench.inbox.reportDone"
                    : inbox.lastReportStatus === "blocked"
                      ? "workbench.inbox.reportBlocked"
                      : inbox.lastReportStatus === "failed"
                        ? "workbench.inbox.reportFailed"
                        : "workbench.inbox.reportProgress",
                )}
              </span>
            ) : null}
            {isCli && profile !== undefined ? (
              <span className="ml-1 font-normal text-fg-muted">
                · {profile.name}
                {profile.model !== undefined ? ` · ${profile.model}` : ""}
              </span>
            ) : null}
          </button>
        )}
        {isCli ? (
          <>
            <button
              type="button"
              className={cn("shrink-0 rounded-sm px-1 text-2xs font-medium", permissionBadgeClass)}
              data-testid="workbench-permission-badge"
              data-permission={permission}
              title={t("workbench.permission.badgeHint")}
              onClick={() => {
                setPendingPermission(permission);
                setYoloConfirm(false);
                setEditingPermission(true);
              }}
            >
              {t(`workbench.permission.level.${permission}`)}
            </button>
            <span className="relative shrink-0">
              <button
                type="button"
                className={cn("rounded-sm px-1 text-2xs font-medium", roleBadgeClass)}
                data-testid="workbench-role-badge"
                data-role={role}
                title={t("workbench.role.badgeHint")}
                onClick={() => setRoleMenuOpen((open) => !open)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setRoleMenuOpen(true);
                }}
              >
                {t(`workbench.role.level.${role}`)}
              </button>
              {roleMenuOpen ? (
                <div
                  className="absolute right-0 top-full z-20 mt-1 flex min-w-24 flex-col rounded-sm border border-border bg-surface p-1 shadow-sm"
                  data-testid="workbench-role-menu"
                >
                  {WORKBENCH_ROLES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="rounded-sm px-2 py-1 text-left text-2xs text-fg hover:bg-surface-hover"
                      data-testid={`workbench-role-option-${item}`}
                      onClick={() => chooseRole(item)}
                    >
                      {t(`workbench.role.level.${item}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
            {openedByLabel !== undefined ? (
              <span
                className="max-w-[7rem] shrink-0 truncate text-2xs text-fg-muted"
                data-testid="workbench-opened-by"
                title={openedByLabel}
              >
                {openedByLabel}
              </span>
            ) : null}
            {window.permissionNeedsDowngrade === true ? (
              <span className="shrink-0 text-2xs text-warning-text">
                {t("workbench.permission.needsRestart")}
              </span>
            ) : null}
            {permissionCappedHint ? (
              <span
                className="shrink-0 text-2xs text-warning-text"
                data-testid="workbench-permission-capped"
              >
                {t("workbench.permission.capped", {
                  level: t(`workbench.permission.level.${permission}`),
                })}
              </span>
            ) : null}
          </>
        ) : null}
        <span
          className={cn(
            "shrink-0 rounded-sm px-1 text-2xs",
            exitCode !== undefined
              ? "bg-danger-surface text-danger-text"
              : running
                ? "bg-success-surface text-success-text"
                : "bg-surface-active text-fg-muted",
          )}
          data-testid="workbench-window-status"
        >
          {exitCode !== undefined
            ? t("workbench.window.status.exited")
            : running
              ? t("workbench.window.status.running")
              : isCli && !autoStart && window.terminalId === undefined
                ? t("workbench.window.status.stopped")
                : t("workbench.window.status.starting")}
        </span>
        <Tooltip content={t("workbench.window.splitRight")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.splitRight")}
            onClick={onSplitRight}
          >
            <Columns2 aria-hidden size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={t("workbench.window.splitDown")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.splitDown")}
            onClick={onSplitDown}
          >
            <Rows2 aria-hidden size={14} />
          </Button>
        </Tooltip>
        <Tooltip
          content={maximized ? t("workbench.window.restore") : t("workbench.window.maximize")}
        >
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={maximized ? t("workbench.window.restore") : t("workbench.window.maximize")}
            onClick={onToggleMaximize}
          >
            {maximized ? <Minimize2 aria-hidden size={14} /> : <Maximize2 aria-hidden size={14} />}
          </Button>
        </Tooltip>
        <Tooltip content={t("workbench.window.close")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("workbench.window.close")}
            onClick={onClose}
          >
            <X aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>
      {editingPermission ? (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-sunken px-2 py-1.5"
          data-testid="workbench-permission-editor"
        >
          <span className="text-2xs text-fg-muted">{t("workbench.permission.changeTitle")}</span>
          <select
            className="rounded-sm border border-border bg-surface px-1 py-0.5 text-2xs"
            data-testid="workbench-permission-select"
            value={pendingPermission}
            onChange={(event) => {
              const next = event.target.value as WorkbenchPermissionLevel;
              setPendingPermission(next);
              if (next !== "yolo") {
                setYoloConfirm(false);
              }
            }}
          >
            {WORKBENCH_PERMISSION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`workbench.permission.level.${level}`)}
              </option>
            ))}
          </select>
          {pendingPermission === "yolo" ? (
            <label className="flex items-center gap-1 text-2xs text-danger-text">
              <input
                type="checkbox"
                data-testid="workbench-permission-yolo-confirm"
                checked={yoloConfirm}
                onChange={(event) => setYoloConfirm(event.target.checked)}
              />
              {t("workbench.newWindow.yoloConfirmShort")}
            </label>
          ) : null}
          <span className="text-2xs text-fg-muted">{t("workbench.permission.restartHint")}</span>
          <Button
            type="button"
            size="sm"
            data-testid="workbench-permission-apply"
            disabled={pendingPermission === "yolo" && !yoloConfirm}
            onClick={() => {
              setWindowPermission(window.projectId, window.id, pendingPermission);
              setEditingPermission(false);
              if (running) {
                setResumeNext(true);
                setLaunchNonce((n) => n + 1);
              }
            }}
          >
            {running ? t("workbench.permission.applyAndRestart") : t("workbench.permission.apply")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditingPermission(false)}
          >
            {t("workbench.newWindow.cancel")}
          </Button>
        </div>
      ) : null}
      {manualTurnSignal ? (
        <div
          className="shrink-0 border-b border-border bg-warning-surface px-2 py-1 text-2xs text-warning-text"
          data-testid="workbench-manual-turn-signal"
        >
          {t("workbench.deliver.noNode")}
        </div>
      ) : null}
      {deliverPending.count > 0 && deliverPending.mode !== "clear" ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-surface px-2 py-1 text-2xs text-warning-text"
          data-testid="workbench-deliver-pending"
          data-deliver-mode={deliverPending.mode}
        >
          <span>{t("workbench.deliver.pending", { count: deliverPending.count })}</span>
          {deliverPending.mode === "manual" ? (
            <>
              <button
                type="button"
                className="rounded-sm bg-primary px-1.5 py-0.5 text-primary-fg"
                data-testid="workbench-deliver-now"
                onClick={() => {
                  void invokeQuery("workbench:deliver-now", { windowId: window.id });
                }}
              >
                {t("workbench.deliver.send")}
              </button>
              {window.kind === "codex" ? (
                <span data-testid="workbench-codex-manual-hint">
                  {t("workbench.deliver.codexManualHint")}
                </span>
              ) : null}
            </>
          ) : (
            <span data-testid="workbench-deliver-blocked">
              {deliverPending.mode === "blocked"
                ? t("workbench.deliver.blocked")
                : t("workbench.deliver.busy")}
            </span>
          )}
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-fg"
            data-testid="workbench-deliver-cancel"
            onClick={() => {
              void invokeQuery("workbench:deliver-cancel", { windowId: window.id });
            }}
          >
            {t("workbench.deliver.cancel")}
          </button>
        </div>
      ) : null}
      <TerminalView
        key={`${window.id}-${window.kind}`}
        windowId={window.id}
        projectId={window.projectId}
        cwd={window.cwd}
        fallbackCwd={projectRoot}
        onTerminalIdChange={onTerminalIdChange}
        onExitCodeChange={setExitCode}
        onCwdFallback={onCwdFallback}
        launchNonce={launchNonce}
        {...(isCli && window.profileId !== undefined
          ? {
              cliLaunch: {
                profileId: window.profileId,
                projectRoot,
                autoStart: autoStart || resumeNext,
                permission,
                ...(window.role !== undefined ? { role: window.role } : {}),
                ...(window.nativeSessionId !== undefined
                  ? { nativeSessionId: window.nativeSessionId }
                  : {}),
                ...(initialPrompt !== undefined ? { initialPrompt } : {}),
                ...(resumeNext ? { resume: true } : {}),
              },
              onResume: () => {
                setResumeNext(true);
                setLaunchNonce((n) => n + 1);
              },
              onRestartFresh: () => {
                setResumeNext(false);
                patchWindow(window.projectId, window.id, { nativeSessionId: null });
                setLaunchNonce((n) => n + 1);
              },
              onConvertToShell: () => {
                convertWindowToShell(window.projectId, window.id);
              },
              onNativeSessionId: (nativeSessionId) => {
                if (nativeSessionId !== undefined) {
                  patchWindow(window.projectId, window.id, { nativeSessionId });
                }
              },
              onPermissionCapped: (effective) => {
                setWindowPermission(window.projectId, window.id, effective);
                setPermissionCappedHint(true);
              },
              onTurnSignal: (signal) => {
                setManualTurnSignal(signal === "manual");
              },
            }
          : {})}
      />
    </section>
  );
}
