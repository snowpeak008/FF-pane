/**
 * 工作台窗口壳：标题栏 + 状态 + 操作 + TerminalView（T10.2 / T10.4 / T10.5）。
 */

import type { WorkbenchPermissionLevel, WorkbenchRole, WorkbenchWindow } from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isAiWorkbenchKind,
  MANAGER_COMPACT_PERCENT_WHEN_ENABLED,
  WORKBENCH_PERMISSION_LEVELS,
  WORKBENCH_ROLES,
} from "@ff-pane/shared";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Maximize2, Minimize2, X } from "lucide-react";
import {
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { WindowSkillsReport } from "../../../../shared-ipc/contracts";
import { CliKindIcon } from "../../components/icons/CliKindIcon";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { cn } from "../../lib/cn";
import { flushWorkbenchLayouts, useWorkbenchStore } from "../../stores/workbench";
import { useWorkbenchRuntimeStore } from "../../stores/workbench-runtime";
import { type ConversationLaunchPlan, planConversationLaunch } from "./conversation-launch";
import { needsSensitiveLaunchConfirm, rememberSensitiveLaunchConfirm } from "./sensitive-launch";
import { TerminalView } from "./TerminalView";
import { reportKey, WindowDetails } from "./WindowDetails";
import { WindowMenu } from "./WindowMenu";
import {
  AttentionBadge,
  WindowAttentionBadges,
  type WindowLifecycle,
  WindowStatusDot,
} from "./WorkbenchRuntimeBar";

export interface WindowPaneProps {
  readonly window: WorkbenchWindow;
  readonly projectRoot: string;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  /** 在这一页、这个窗口后面加一个窗口；这页满了开新页（T11.2d）。 */
  readonly onAddWindow: () => void;
  readonly onToggleMaximize: () => void;
  readonly onRename: (title: string) => void;
  readonly onTerminalIdChange: (terminalId: string | undefined) => void;
  readonly onCwdFallback: () => void;
  /** 按住标题栏拖窗口换位置（T11.2c）。 */
  readonly onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 正被拖着。 */
  readonly dragging?: boolean;
}

export function WindowPane({
  window,
  projectRoot,
  focused,
  maximized,
  onFocus,
  onClose,
  onAddWindow,
  onToggleMaximize,
  onRename,
  onTerminalIdChange,
  onCwdFallback,
  onDragStart,
  dragging = false,
}: WindowPaneProps): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(window.title);
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [permissionCappedHint, setPermissionCappedHint] = useState(false);
  const [resumeNext, setResumeNext] = useState(false);
  const [conversationPlan, setConversationPlan] = useState<ConversationLaunchPlan>({
    kind: "fresh",
  });
  const [sensitiveOpen, setSensitiveOpen] = useState(false);
  const patchWindow = useWorkbenchStore((s) => s.patchWindow);
  const noteWindowSession = useWorkbenchStore((s) => s.noteWindowSession);
  const markWindowSessionUnidentified = useWorkbenchStore((s) => s.markWindowSessionUnidentified);
  const clearWindowSessionId = useWorkbenchStore((s) => s.clearWindowSessionId);
  const touchWindowConversation = useWorkbenchStore((s) => s.touchWindowConversation);
  const setWindowPermission = useWorkbenchStore((s) => s.setWindowPermission);
  const applyWindowRole = useWorkbenchStore((s) => s.applyWindowRole);
  const convertWindowToShell = useWorkbenchStore((s) => s.convertWindowToShell);
  const wasCreatedThisSession = useWorkbenchStore((s) => s.wasCreatedThisSession);
  const takeInitialPrompt = useWorkbenchStore((s) => s.takeInitialPrompt);
  const getProjectLayout = useWorkbenchStore((s) => s.getProjectLayout);
  const inbox = useWorkbenchStore((s) => s.inboxByWindow[window.id]);
  const online = useWorkbenchRuntimeStore((s) => s.windows[window.id]?.online === true);

  const isCli = isAiWorkbenchKind(window.kind);
  const permission = window.permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;
  const role = window.role ?? DEFAULT_WORKBENCH_ROLE;
  const [editingPermission, setEditingPermission] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<WorkbenchPermissionLevel>(permission);
  const [yoloConfirm, setYoloConfirm] = useState(false);
  const [launchNonce, setLaunchNonce] = useState(0);
  const modelEffortResumeRef = useRef(false);
  const modelEffortConfirmRef = useRef(false);
  const [modelEffort, setModelEffort] = useState<{
    reason: "busy" | "confirm" | "not-running" | "no-session" | "failed";
    error?: string;
    model?: string;
    effort?: string;
  } | null>(null);
  const [manualTurnSignal, setManualTurnSignal] = useState(false);
  /** T11.9：这次开窗挂了哪些技能、跳过了哪些。 */
  const [skillsReport, setSkillsReport] = useState<WindowSkillsReport | undefined>(undefined);
  const running = exitCode === undefined && window.terminalId !== undefined;
  const autoStart = wasCreatedThisSession(window.id);
  const initialPrompt = useMemo(() => takeInitialPrompt(window.id), [takeInitialPrompt, window.id]);
  const sensitiveResolvers = useRef<Array<(accepted: boolean) => void>>([]);

  const askSensitiveLaunch = (): Promise<boolean> => {
    if (!needsSensitiveLaunchConfirm(window.id, permission, role)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      sensitiveResolvers.current.push(resolve);
      setSensitiveOpen(true);
    });
  };

  const finishSensitiveLaunch = (accepted: boolean): void => {
    if (accepted) {
      rememberSensitiveLaunchConfirm(window.id);
    }
    setSensitiveOpen(false);
    const pending = sensitiveResolvers.current;
    sensitiveResolvers.current = [];
    for (const resolve of pending) {
      resolve(accepted);
    }
    if (modelEffortConfirmRef.current) {
      modelEffortConfirmRef.current = false;
      if (accepted) {
        // 主进程按有没有聊过天决定冷重启还是续接，并负责重启。
        void invokeQuery("workbench:model-effort-confirm", { windowId: window.id, accepted });
      }
    }
  };

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

  const chooseRole = (next: WorkbenchRole): void => {
    void applyWindowRole(window.projectId, window.id, next).then((result) => {
      if (!result.ok) {
        toast.error(t("workbench.role.rejected"), { description: result.message });
        return;
      }
      if (result.delivery === "dropped") {
        toast.message(t("workbench.role.dropped"));
      } else if (result.delivery === "restarting" || result.delivery === "restart-queued") {
        // T11.1：能不能开子 agent 变了，要重启才生效。
        toast.message(t("workbench.role.restartForSubagents"));
      }
    });
  };

  const [deliverPending, setDeliverPending] = useState<{
    count: number;
    mode: "manual" | "blocked" | "busy" | "draft" | "clear";
  }>({ count: 0, mode: "clear" });

  const queueConversationPlan = (plan: ConversationLaunchPlan): void => {
    void (async () => {
      const accepted = await askSensitiveLaunch();
      if (!accepted) {
        return;
      }
      if (plan.kind === "fresh") {
        clearWindowSessionId(window.projectId, window.id);
      }
      setConversationPlan(plan);
      setResumeNext(plan.kind !== "fresh");
      setLaunchNonce((n) => n + 1);
    })();
  };

  useSubscription("workbench:session-unidentified", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    markWindowSessionUnidentified(window.projectId, window.id);
  });

  useSubscription("workbench:conversation-touch", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    touchWindowConversation(window.id, payload.at);
  });

  useSubscription("workbench:deliver-pending", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    setDeliverPending({ count: payload.count, mode: payload.mode });
  });

  useSubscription("workbench:model-effort", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    if (payload.permission !== undefined && payload.permission !== window.permission) {
      setWindowPermission(window.projectId, window.id, payload.permission);
    }
    if (payload.modelOverride !== undefined || payload.effortOverride !== undefined) {
      patchWindow(window.projectId, window.id, {
        ...(payload.modelOverride !== undefined ? { modelOverride: payload.modelOverride } : {}),
        ...(payload.effortOverride !== undefined ? { effortOverride: payload.effortOverride } : {}),
      });
    }
    if (payload.action === "clear") {
      setModelEffort(null);
      return;
    }
    if (payload.action === "resume") {
      // 重启由主进程做（窗口不在当前标签页时这里收不到），这里只收起提示。
      modelEffortConfirmRef.current = false;
      setSensitiveOpen(false);
      setModelEffort(null);
      return;
    }
    setModelEffort({
      reason: payload.reason,
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.modelOverride !== undefined ? { model: payload.modelOverride } : {}),
      ...(payload.effortOverride !== undefined ? { effort: payload.effortOverride } : {}),
    });
    if (payload.action === "confirm") {
      modelEffortConfirmRef.current = true;
      setSensitiveOpen(true);
    }
  });

  // 团队停下了（管理者因限流停下且监管者也不在线）：在管理者窗口上盖一层半透明提示，等用户叫醒管理者。
  const [teamPaused, setTeamPaused] = useState<{ reason?: string; dismissed: boolean } | null>(
    null,
  );
  useSubscription("workbench:team-paused", (payload) => {
    if (payload.windowId !== window.id) {
      return;
    }
    setTeamPaused(
      payload.paused
        ? { ...(payload.reason !== undefined ? { reason: payload.reason } : {}), dismissed: false }
        : null,
    );
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
        : window.kind === "grok"
          ? t("workbench.window.kind.grok")
          : window.kind === "deepseek"
            ? t("workbench.window.kind.deepseek")
            : window.kind === "cursor"
              ? t("workbench.window.kind.cursor")
              : t("workbench.window.kind.shell");

  const lifecycle: WindowLifecycle =
    exitCode !== undefined
      ? "exited"
      : running
        ? "running"
        : isCli && !autoStart && window.terminalId === undefined
          ? "stopped"
          : "starting";

  const modelEffortNote =
    modelEffort !== null
      ? `${t("workbench.window.modelEffort.pending", {
          reason: t(`workbench.window.modelEffort.reason.${modelEffort.reason}`),
          model: modelEffort.model ?? window.modelOverride ?? t("workbench.window.modelDefault"),
          effort:
            modelEffort.effort ?? window.effortOverride ?? t("workbench.window.effortDefault"),
        })}${modelEffort.error !== undefined && modelEffort.error !== "" ? ` ${modelEffort.error}` : ""}`
      : undefined;

  const lastReport = inbox?.lastReportStatus;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane focus-on-click
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border bg-surface",
        focused ? "border-primary" : "border-border",
        dragging && "opacity-50",
      )}
      data-testid="workbench-window"
      data-window-id={window.id}
      data-window-kind={window.kind}
      data-focused={focused ? "true" : "false"}
      onMouseDown={onFocus}
    >
      {/* 一行标题栏（§9 界面精简）：种类图标、状态点、窗口名、要用户动手的小标、角色；其余在窗口名的悬浮提示和「⋯」菜单里。 */}
      <div
        className={cn(
          "relative z-10 flex h-7 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-1",
          isCli && role === "manager" ? "bg-primary-surface" : "bg-surface-sunken",
          // 全放开的窗口左边描一道红；权限本身在提示和菜单里。
          isCli && permission === "yolo" && "border-l-2 border-l-danger",
        )}
        data-manager={isCli && role === "manager" ? "true" : "false"}
        data-permission={isCli ? permission : undefined}
        data-opened-by={
          isCli
            ? window.openedBy === undefined || window.openedBy === "user"
              ? "user"
              : window.openedBy.windowId
            : undefined
        }
        data-report-status={lastReport}
        data-testid="workbench-window-header"
        onPointerDown={(event) => {
          // 标题和空白处能拖；其他按钮、改名输入框照常点。
          const target = event.target as HTMLElement;
          if (
            onDragStart === undefined ||
            editing ||
            target.closest("input, button:not([data-drag-handle])") !== null
          ) {
            return;
          }
          onDragStart(event);
        }}
      >
        <Tooltip content={kindLabel}>
          <span
            className="flex shrink-0 items-center px-0.5"
            role="img"
            aria-label={kindLabel}
            data-testid="workbench-window-kind"
          >
            <CliKindIcon kind={window.kind} />
          </span>
        </Tooltip>
        <WindowStatusDot windowId={window.id} lifecycle={lifecycle} />
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
          <WindowDetails
            window={window}
            isCli={isCli}
            kindLabel={kindLabel}
            role={role}
            permission={permission}
            openedByLabel={openedByLabel}
            skillsReport={skillsReport}
            lastReportStatus={lastReport}
            permissionCapped={permissionCappedHint}
            modelEffortNote={modelEffortNote}
          >
            <button
              type="button"
              className="min-w-0 flex-1 cursor-grab truncate px-1 text-left text-xs font-medium text-fg"
              data-drag-handle
              data-testid="workbench-window-title"
              onDoubleClick={() => {
                setDraft(window.title);
                setEditing(true);
              }}
            >
              {window.title}
            </button>
          </WindowDetails>
        )}
        {inbox !== undefined && inbox.unread > 0 ? (
          <span
            className="shrink-0 rounded-full bg-danger px-1.5 text-2xs font-medium leading-4 text-danger-fg"
            data-testid="workbench-unread-badge"
            role="img"
            aria-label={t("workbench.inbox.unread", { count: inbox.unread })}
          >
            {inbox.unread}
          </span>
        ) : null}
        {lastReport === "blocked" || lastReport === "failed" ? (
          <AttentionBadge
            tone={lastReport === "failed" ? "danger" : "warning"}
            testId="workbench-report-badge"
          >
            {t(reportKey(lastReport))}
          </AttentionBadge>
        ) : null}
        <WindowAttentionBadges windowId={window.id} />
        {manualTurnSignal ? (
          <AttentionBadge
            tone="warning"
            testId="workbench-manual-turn-signal"
            hint={
              window.kind === "grok"
                ? t("workbench.deliver.grokManual")
                : window.kind === "cursor"
                  ? t("workbench.deliver.cursorManual")
                  : t("workbench.deliver.noNode")
            }
          >
            {t("workbench.deliver.manualBadge")}
          </AttentionBadge>
        ) : null}
        {isCli && window.sessionUnidentified === true ? (
          <AttentionBadge
            tone="warning"
            testId="workbench-session-unidentified"
            hint={t("workbench.session.unidentified")}
          >
            {t("workbench.session.unidentifiedShort")}
          </AttentionBadge>
        ) : null}
        {modelEffort !== null && modelEffortNote !== undefined ? (
          <span
            className="flex shrink-0 items-center gap-0.5"
            data-testid="workbench-model-effort-pending"
            data-reason={modelEffort.reason}
          >
            <AttentionBadge tone="warning" hint={modelEffortNote}>
              {t("workbench.window.modelEffort.badge")}
            </AttentionBadge>
            {modelEffort.reason === "confirm" ? (
              <AttentionBadge
                tone="warning"
                testId="workbench-model-effort-confirm"
                onClick={() => {
                  modelEffortConfirmRef.current = true;
                  setSensitiveOpen(true);
                }}
              >
                {t("workbench.window.modelEffort.confirmAgain")}
              </AttentionBadge>
            ) : null}
          </span>
        ) : null}
        {isCli && window.managerGrantPending === true ? (
          <AttentionBadge tone="warning" testId="workbench-manager-grant-pending">
            {t("workbench.role.grantPending")}
          </AttentionBadge>
        ) : null}
        {isCli && window.permissionNeedsDowngrade === true ? (
          <AttentionBadge tone="warning">{t("workbench.permission.needsRestart")}</AttentionBadge>
        ) : null}
        {isCli ? <RoleBadge role={role} onChoose={chooseRole} /> : null}
        <WindowMenu
          window={window}
          isCli={isCli}
          permission={permission}
          canGoOnline={isCli && (role === "supervisor" || role === "manager")}
          online={online}
          showCompact={isCli && role === "manager" && window.kind !== "cursor"}
          onResumeCurrent={() => {
            queueConversationPlan(
              planConversationLaunch({
                action: "resume-current",
                ...(window.nativeSessionId !== undefined
                  ? { currentId: window.nativeSessionId }
                  : {}),
                unidentified: window.sessionUnidentified === true,
              }),
            );
          }}
          onFresh={() => {
            queueConversationPlan({ kind: "fresh" });
          }}
          onPickHistory={(historyId) => {
            queueConversationPlan(
              planConversationLaunch({
                action: "resume-history",
                historyId,
              }),
            );
          }}
          onEditPermission={() => {
            setPendingPermission(permission);
            setYoloConfirm(false);
            setEditingPermission(true);
          }}
          onToggleOnline={() => {
            const next = !online;
            void invokeQuery("workbench:set-online", {
              windowId: window.id,
              online: next,
            }).then((settled) => {
              if (settled.status === "error") {
                toast.error(settled.error.message);
                return;
              }
              toast.message(t(next ? "workbench.online.started" : "workbench.online.stopped"));
            });
          }}
          onCompactUnspecified={(unspecified) => {
            patchWindow(window.projectId, window.id, {
              compactPercent: unspecified
                ? null
                : (window.compactPercent ?? MANAGER_COMPACT_PERCENT_WHEN_ENABLED),
            });
            void flushWorkbenchLayouts();
          }}
          onCompactPercent={(percent) => {
            patchWindow(window.projectId, window.id, { compactPercent: percent });
          }}
          onCompactCommit={() => {
            void flushWorkbenchLayouts();
          }}
          onAddWindow={onAddWindow}
        />
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
              void (async () => {
                const settled = await invokeQuery("workbench:set-permission", {
                  windowId: window.id,
                  permission: pendingPermission,
                });
                if (settled.status === "error") {
                  toast.error(settled.error.message);
                  return;
                }
                setWindowPermission(window.projectId, window.id, pendingPermission);
                setEditingPermission(false);
                if (running) {
                  setResumeNext(true);
                  setLaunchNonce((n) => n + 1);
                }
              })();
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
      {/* 提示条浮在终端上沿，不占高度：它们随投递排队时有时无，挤占高度会让终端改行数、CLI 整屏重画 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {teamPaused !== null && !teamPaused.dismissed ? (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-surface-sunken/70 px-6 text-center backdrop-blur-[1px]"
            data-testid="workbench-team-paused"
          >
            <div className="text-sm font-medium text-fg">
              {t("workbench.window.teamPaused.title")}
            </div>
            {teamPaused.reason !== undefined ? (
              <div className="text-xs text-fg-muted">{teamPaused.reason}</div>
            ) : null}
            <div className="max-w-md text-xs text-fg-muted">
              {t("workbench.window.teamPaused.body")}
            </div>
            <Button
              size="sm"
              variant="secondary"
              data-testid="workbench-team-paused-dismiss"
              onClick={() => setTeamPaused({ ...teamPaused, dismissed: true })}
            >
              {t("workbench.window.teamPaused.dismiss")}
            </Button>
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col">
          {deliverPending.count > 0 && deliverPending.mode !== "clear" ? (
            <div
              className="pointer-events-auto flex flex-wrap items-center gap-2 border-b border-border bg-warning-surface px-2 py-1 text-2xs text-warning-text"
              data-testid="workbench-deliver-pending"
              data-deliver-mode={deliverPending.mode}
            >
              <span>{t("workbench.deliver.pending", { count: deliverPending.count })}</span>
              {deliverPending.mode === "manual" ? (
                <Tooltip
                  content={
                    window.kind === "codex" ? (
                      <span data-testid="workbench-codex-manual-hint">
                        {t("workbench.deliver.codexManualHint")}
                      </span>
                    ) : (
                      t("workbench.deliver.send")
                    )
                  }
                >
                  <button
                    type="button"
                    className="rounded-sm bg-primary px-1.5 py-0.5 text-primary-fg"
                    data-testid="workbench-deliver-now"
                    onClick={() => {
                      void invokeQuery("workbench:deliver-now", { windowId: window.id }).then(
                        (result) => {
                          if (
                            result.status === "success" &&
                            !result.data.ok &&
                            result.data.reason === "draft"
                          ) {
                            toast.message(t("workbench.deliver.draftRefused"));
                          }
                        },
                      );
                    }}
                  >
                    {t("workbench.deliver.send")}
                  </button>
                </Tooltip>
              ) : (
                <Tooltip
                  content={
                    deliverPending.mode === "blocked" ? (
                      <span className="flex flex-col gap-0.5">
                        <span>{t("workbench.deliver.blocked")}</span>
                        <span data-testid="workbench-deliver-permission-hold">
                          {t("workbench.deliver.permissionHold")}
                        </span>
                      </span>
                    ) : deliverPending.mode === "draft" ? (
                      t("workbench.deliver.draft")
                    ) : (
                      t("workbench.deliver.busy")
                    )
                  }
                >
                  <span data-testid="workbench-deliver-blocked">
                    {deliverPending.mode === "blocked"
                      ? t("workbench.deliver.blockedShort")
                      : deliverPending.mode === "draft"
                        ? t("workbench.deliver.draftShort")
                        : t("workbench.deliver.busyShort")}
                  </span>
                </Tooltip>
              )}
              <Tooltip content={t("workbench.deliver.cancelHint")}>
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
              </Tooltip>
            </div>
          ) : null}
        </div>
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
          {...(isCli
            ? {
                cliLaunch: {
                  kind:
                    window.kind === "codex"
                      ? "codex"
                      : window.kind === "grok"
                        ? "grok"
                        : window.kind === "deepseek"
                          ? "deepseek"
                          : window.kind === "cursor"
                            ? "cursor"
                            : "claude",
                  projectRoot,
                  autoStart: autoStart || resumeNext,
                  permission,
                  ...(window.role !== undefined ? { role: window.role } : {}),
                  ...(conversationPlan.kind === "resume"
                    ? { nativeSessionId: conversationPlan.sessionId, resume: true }
                    : conversationPlan.kind === "picker"
                      ? { resume: true }
                      : {}),
                  ...(initialPrompt !== undefined ? { initialPrompt } : {}),
                },
                onResume: () => {
                  queueConversationPlan(
                    planConversationLaunch({
                      action: "resume-current",
                      ...(window.nativeSessionId !== undefined
                        ? { currentId: window.nativeSessionId }
                        : {}),
                      unidentified: window.sessionUnidentified === true,
                    }),
                  );
                },
                onRestartFresh: () => {
                  queueConversationPlan({ kind: "fresh" });
                },
                onConvertToShell: () => {
                  convertWindowToShell(window.projectId, window.id);
                },
                onNativeSessionId: (nativeSessionId) => {
                  if (nativeSessionId !== undefined) {
                    noteWindowSession(window.projectId, window.id, nativeSessionId);
                  }
                },
                onPermissionCapped: (effective) => {
                  setWindowPermission(window.projectId, window.id, effective);
                  setPermissionCappedHint(true);
                },
                onTurnSignal: (signal) => {
                  setManualTurnSignal(signal === "manual");
                },
                onSkills: (report) => {
                  setSkillsReport(report);
                },
                onLaunchRoute: (route) => {
                  patchWindow(window.projectId, window.id, { routeSnapshot: route });
                  if (modelEffortResumeRef.current || modelEffort !== null) {
                    modelEffortResumeRef.current = false;
                    setModelEffort(null);
                    void invokeQuery("workbench:model-effort-settled", {
                      windowId: window.id,
                      ok: true,
                    });
                  }
                },
                onRelaunchSettled: (ok, error) => {
                  if (ok || !modelEffortResumeRef.current) {
                    return;
                  }
                  modelEffortResumeRef.current = false;
                  void invokeQuery("workbench:model-effort-settled", {
                    windowId: window.id,
                    ok: false,
                    ...(error !== undefined && error !== "" ? { error } : {}),
                  });
                },
              }
            : {})}
          beforeUserRelaunch={askSensitiveLaunch}
        />
      </div>
      <ConfirmDialog
        open={sensitiveOpen}
        onOpenChange={(open) => {
          if (!open) {
            finishSensitiveLaunch(false);
          }
        }}
        title={t("workbench.resumeConfirm.title")}
        description={
          modelEffort?.reason === "confirm"
            ? t("workbench.window.modelEffort.confirmBody", {
                model:
                  modelEffort.model ?? window.modelOverride ?? t("workbench.window.modelDefault"),
                effort:
                  modelEffort.effort ??
                  window.effortOverride ??
                  t("workbench.window.effortDefault"),
              })
            : t("workbench.resumeConfirm.body", {
                permission: t(`workbench.permission.level.${permission}`),
                role: t(`workbench.role.level.${role}`),
              })
        }
        tone="primary"
        confirmLabel={t("workbench.resumeConfirm.confirm")}
        cancelLabel={t("workbench.resumeConfirm.cancel")}
        onConfirm={() => {
          finishSensitiveLaunch(true);
        }}
      />
    </section>
  );
}

const ROLE_BADGE_CLASS: Record<WorkbenchRole, string> = {
  manager: "bg-primary text-primary-fg",
  planner: "bg-primary-surface text-primary-text",
  worker: "bg-warning-surface text-warning-text",
  reviewer: "bg-success-surface text-success-text",
  supervisor: "bg-status-pending-surface text-status-pending-text",
  researcher: "bg-surface-active text-fg-muted",
  none: "bg-surface-active text-fg-muted",
};

/** 角色只留一个字的小标（管 / 监 / 执…），全名在提示里；点开或右键换角色。 */
function RoleBadge({
  role,
  onChoose,
}: {
  readonly role: WorkbenchRole;
  readonly onChoose: (role: WorkbenchRole) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={`${t(`workbench.role.level.${role}`)} · ${t("workbench.role.badgeHint")}`}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-sm px-1 text-2xs font-medium leading-4",
              ROLE_BADGE_CLASS[role],
            )}
            data-testid="workbench-role-badge"
            data-role={role}
            aria-label={t(`workbench.role.level.${role}`)}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
          >
            {t(`workbench.role.short.${role}`)}
          </button>
        </PopoverPrimitive.Trigger>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 flex min-w-24 flex-col rounded-md border border-border bg-surface-raised p-1 shadow-raised"
          data-testid="workbench-role-menu"
        >
          {WORKBENCH_ROLES.map((item) => (
            <button
              key={item}
              type="button"
              className="rounded-sm px-2 py-1 text-left text-xs text-fg hover:bg-surface-hover"
              data-testid={`workbench-role-option-${item}`}
              onClick={() => {
                setOpen(false);
                onChoose(item);
              }}
            >
              {t(`workbench.role.level.${item}`)}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
