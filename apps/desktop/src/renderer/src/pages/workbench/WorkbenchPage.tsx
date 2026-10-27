/**
 * 工作台页（T10.2）：多项目并行、标签页 + 分屏、布局持久化。
 * 非活动项目 / 非活动标签不挂载 xterm（PTY 继续跑，回放环形缓冲）。
 */

import { SquareTerminal } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  resetGridSizes,
  tabWindowIds,
  withColSizes,
  withRowSizes,
} from "../../../../shared/workbench/grid";
import { useCommandHandler, useShortcutScope } from "../../command";
import { EmptyState } from "../../components/states/EmptyState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { useActiveProject } from "../../hooks/useActiveProject";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { PageHeader } from "../../layout/PageHeader";
import { useWorkbenchStore } from "../../stores/workbench";
import { useWorkbenchCanvasStore } from "../../stores/workbench-canvas";
import { GridLayout } from "./GridLayout";
import { NewWindowDialog, type NewWindowDialogResult } from "./NewWindowDialog";
import { TabBar } from "./TabBar";
import { WorkbenchCanvasPanel } from "./WorkbenchCanvasPanel";
import { WorkbenchDecisions } from "./WorkbenchDecisions";
import { WorkbenchDrawer } from "./WorkbenchDrawer";
import { WorkbenchRuntimeBar } from "./WorkbenchRuntimeBar";
import { useWindowDrag } from "./window-drag";

export function WorkbenchPage(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { entry, loading } = useActiveProject();
  const hydrate = useWorkbenchStore((s) => s.hydrate);
  const hydrated = useWorkbenchStore((s) => s.hydrated);
  const layout = useWorkbenchStore((s) =>
    entry === null ? null : (s.layoutsByProject[entry.id] ?? null),
  );
  const createTabWithWindow = useWorkbenchStore((s) => s.createTabWithWindow);
  const splitWindow = useWorkbenchStore((s) => s.splitWindow);
  const closeWindow = useWorkbenchStore((s) => s.closeWindow);
  const closeTab = useWorkbenchStore((s) => s.closeTab);
  const renameTab = useWorkbenchStore((s) => s.renameTab);
  const renameWindow = useWorkbenchStore((s) => s.renameWindow);
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab);
  const focusWindow = useWorkbenchStore((s) => s.focusWindow);
  const toggleMaximize = useWorkbenchStore((s) => s.toggleMaximize);
  const applyWindowRole = useWorkbenchStore((s) => s.applyWindowRole);
  const setGridSizes = useWorkbenchStore((s) => s.setGridSizes);
  const setGridOrientation = useWorkbenchStore((s) => s.setGridOrientation);
  const bindTerminalId = useWorkbenchStore((s) => s.bindTerminalId);
  const markCwdFallback = useWorkbenchStore((s) => s.markCwdFallback);
  const cwdFallbackWindowIds = useWorkbenchStore((s) => s.cwdFallbackWindowIds);
  const getProjectLayout = useWorkbenchStore((s) => s.getProjectLayout);

  const countRunningWindows = useWorkbenchStore((s) => s.countRunningWindows);
  const moveWindow = useWorkbenchStore((s) => s.moveWindow);
  const canvasPending = useWorkbenchCanvasStore((s) =>
    entry === null ? 0 : (s.pending[entry.id] ?? 0),
  );
  const entryId = entry?.id;
  // 画板按钮一出来就取一次待检查数，之后跟着主进程推的变。
  useEffect(() => {
    if (entryId === undefined) {
      return;
    }
    let cancelled = false;
    void invokeQuery("workbench:get-canvas-pending", { projectId: entryId }).then((settled) => {
      if (!cancelled && settled.status === "success") {
        useWorkbenchCanvasStore.getState().setPending(entryId, settled.data.pending);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const { state: configState } = useInvokeQuery("config:get");
  const maxWindows = queryData(configState)?.maxWorkbenchWindows ?? 12;

  const [confirmCloseTabId, setConfirmCloseTabId] = useState<string | null>(null);
  const [newWindowOpen, setNewWindowOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<
    | { readonly mode: "tab" }
    | { readonly mode: "slot"; readonly slot: number }
    | {
        readonly mode: "split";
        readonly direction: "horizontal" | "vertical";
        readonly targetWindowId: string;
      }
    | null
  >(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useShortcutScope("workbench");

  const projectLayout = useMemo(() => {
    if (entry === null) {
      return null;
    }
    return layout ?? getProjectLayout(entry.id);
  }, [entry, getProjectLayout, layout]);

  const activeTab = useMemo(() => {
    if (projectLayout === null || projectLayout.activeTabId === null) {
      return null;
    }
    return projectLayout.tabs.find((tab) => tab.id === projectLayout.activeTabId) ?? null;
  }, [projectLayout]);

  useEffect(() => {
    for (const windowId of cwdFallbackWindowIds) {
      toast.message(t("workbench.cwd.fallback"));
      useWorkbenchStore.getState().clearCwdFallback(windowId);
    }
  }, [cwdFallbackWindowIds, t]);

  // 拖窗口换位置（T11.2c）：只改格子，窗口不重启。
  const windowDrag = useWindowDrag((windowId, target) => {
    if (entry !== null && moveWindow(entry.id, windowId, target) === "full") {
      toast.error(t("workbench.grid.tabFull"));
    }
  });

  const ensureCapacity = useCallback(async (): Promise<boolean> => {
    const settled = await invokeQuery("config:get");
    const max = settled.status === "success" ? settled.data.maxWorkbenchWindows : maxWindows;
    if (countRunningWindows() >= max) {
      toast.error(t("workbench.limit.reached", { max }));
      return false;
    }
    return true;
  }, [countRunningWindows, maxWindows, t]);

  const handleNewTab = useCallback(() => {
    if (entry === null) {
      return;
    }
    void (async () => {
      if (!(await ensureCapacity())) {
        return;
      }
      setPendingCreate({ mode: "tab" });
      setNewWindowOpen(true);
    })();
  }, [ensureCapacity, entry]);

  const applyNewWindow = useCallback(
    (result: NewWindowDialogResult) => {
      if (entry === null) {
        return;
      }
      const pending = pendingCreate;
      setPendingCreate(null);
      if (pending === null || pending.mode === "tab" || pending.mode === "slot") {
        createTabWithWindow({
          projectId: entry.id,
          projectRoot: entry.rootPath,
          kind: result.kind,
          ...(pending?.mode === "slot" ? { slot: pending.slot } : { newPage: true }),
          ...(result.initialPrompt !== undefined ? { initialPrompt: result.initialPrompt } : {}),
          ...(result.permission !== undefined ? { permission: result.permission } : {}),
          ...(result.role !== undefined ? { role: result.role } : {}),
        });
        return;
      }
      splitWindow({
        projectId: entry.id,
        projectRoot: entry.rootPath,
        targetWindowId: pending.targetWindowId,
        direction: pending.direction,
        kind: result.kind,
        ...(result.initialPrompt !== undefined ? { initialPrompt: result.initialPrompt } : {}),
        ...(result.permission !== undefined ? { permission: result.permission } : {}),
        ...(result.role !== undefined ? { role: result.role } : {}),
      });
    },
    [createTabWithWindow, entry, pendingCreate, splitWindow],
  );

  const handleSplit = useCallback(
    (direction: "horizontal" | "vertical") => {
      if (entry === null || projectLayout === null) {
        return;
      }
      void (async () => {
        if (!(await ensureCapacity())) {
          return;
        }
        const target =
          projectLayout.focusedWindowId ??
          (activeTab !== null ? tabWindowIds(activeTab)[0] : undefined);
        if (target === undefined) {
          setPendingCreate({ mode: "tab" });
          setNewWindowOpen(true);
          return;
        }
        setPendingCreate({ mode: "split", direction, targetWindowId: target });
        setNewWindowOpen(true);
      })();
    },
    [activeTab, ensureCapacity, entry, projectLayout],
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (entry === null || projectLayout === null) {
        return;
      }
      const tab = projectLayout.tabs.find((item) => item.id === tabId);
      if (tab === undefined) {
        return;
      }
      const ids = tabWindowIds(tab);
      const hasRunning = ids.some((id) => projectLayout.windows[id]?.terminalId !== undefined);
      if (hasRunning) {
        setConfirmCloseTabId(tabId);
        return;
      }
      void closeTab(entry.id, tabId);
    },
    [closeTab, entry, projectLayout],
  );

  useCommandHandler("workbench-new-tab", handleNewTab);
  useCommandHandler("workbench-new-window", () => {
    if (entry === null) {
      return;
    }
    if (activeTab === null) {
      handleNewTab();
      return;
    }
    handleSplit("horizontal");
  });
  useCommandHandler("workbench-split-right", () => handleSplit("horizontal"));
  useCommandHandler("workbench-split-down", () => handleSplit("vertical"));
  useCommandHandler("workbench-close-window", () => {
    if (entry === null || projectLayout?.focusedWindowId === null || projectLayout === null) {
      return;
    }
    void closeWindow(entry.id, projectLayout.focusedWindowId);
  });
  useCommandHandler("workbench-close-tab", () => {
    if (projectLayout?.activeTabId === null || projectLayout === null) {
      return;
    }
    requestCloseTab(projectLayout.activeTabId);
  });
  useCommandHandler("workbench-maximize-window", () => {
    if (entry === null || projectLayout?.focusedWindowId === null || projectLayout === null) {
      return;
    }
    toggleMaximize(entry.id, projectLayout.focusedWindowId);
  });
  useCommandHandler("workbench-set-manager", () => {
    if (entry === null || projectLayout === null || projectLayout.focusedWindowId === null) {
      return;
    }
    const focused = projectLayout.windows[projectLayout.focusedWindowId];
    if (focused === undefined || (focused.kind !== "claude" && focused.kind !== "codex")) {
      toast.error(t("workbench.role.notAi"));
      return;
    }
    void applyWindowRole(entry.id, focused.id, "manager").then((result) => {
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
  });

  if (loading || !hydrated) {
    return (
      <>
        <PageHeader title={t("nav.workbench.label")} description={t("nav.workbench.question")} />
        <LoadingState variant="list" />
      </>
    );
  }

  if (entry === null) {
    return (
      <>
        <PageHeader title={t("nav.workbench.label")} description={t("nav.workbench.question")} />
        <EmptyState
          icon={SquareTerminal}
          message={t("workbench.empty.noProject")}
          action={{
            label: t("workbench.empty.goProjects"),
            onClick: () => void navigate("/projects"),
          }}
        />
      </>
    );
  }

  const hasWindows = projectLayout !== null && Object.keys(projectLayout.windows).length > 0;

  return (
    <>
      <PageHeader
        title={t("nav.workbench.label")}
        description={t("workbench.cwd.project", { path: entry.rootPath })}
        actions={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="open-canvas"
            onClick={() => useWorkbenchCanvasStore.getState().openCanvas(null)}
          >
            {canvasPending > 0
              ? t("workbench.canvas.openWithPending", { count: canvasPending })
              : t("workbench.canvas.open")}
          </Button>
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col" data-testid="workbench-root">
        <TabBar
          tabs={projectLayout?.tabs ?? []}
          activeTabId={projectLayout?.activeTabId ?? null}
          onSelect={(tabId) => setActiveTab(entry.id, tabId)}
          onClose={requestCloseTab}
          onRename={(tabId, title) => renameTab(entry.id, tabId, title)}
          onNewTab={handleNewTab}
          dropTarget={windowDrag.drag?.target ?? null}
        />
        <WorkbenchRuntimeBar projectId={entry.id} />
        <WorkbenchDecisions projectId={entry.id} />
        {!hasWindows || activeTab === null ? (
          <EmptyState
            icon={SquareTerminal}
            message={t("workbench.empty.noWindow")}
            action={{
              label: t("workbench.empty.newWindow"),
              onClick: handleNewTab,
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-1">
            <GridLayout
              tabId={activeTab.id}
              slots={activeTab.slots}
              sizes={activeTab.sizes}
              projectId={entry.id}
              projectRoot={entry.rootPath}
              windows={projectLayout.windows}
              focusedWindowId={projectLayout.focusedWindowId}
              maximizedWindowId={projectLayout.maximizedWindowId}
              onFocus={(windowId) => focusWindow(entry.id, windowId)}
              onClose={(windowId) => void closeWindow(entry.id, windowId)}
              onSplitRight={(windowId) => {
                void (async () => {
                  if (!(await ensureCapacity())) {
                    return;
                  }
                  setPendingCreate({
                    mode: "split",
                    direction: "horizontal",
                    targetWindowId: windowId,
                  });
                  setNewWindowOpen(true);
                })();
              }}
              onSplitDown={(windowId) => {
                void (async () => {
                  if (!(await ensureCapacity())) {
                    return;
                  }
                  setPendingCreate({
                    mode: "split",
                    direction: "vertical",
                    targetWindowId: windowId,
                  });
                  setNewWindowOpen(true);
                })();
              }}
              onToggleMaximize={(windowId) => toggleMaximize(entry.id, windowId)}
              onRename={(windowId, title) => renameWindow(entry.id, windowId, title)}
              onTerminalIdChange={(windowId, terminalId) =>
                bindTerminalId(entry.id, windowId, terminalId)
              }
              onCwdFallback={(windowId) => markCwdFallback(windowId)}
              onCreateInSlot={(slot) => {
                void (async () => {
                  if (!(await ensureCapacity())) {
                    return;
                  }
                  setPendingCreate({ mode: "slot", slot });
                  setNewWindowOpen(true);
                })();
              }}
              onOrientationChange={setGridOrientation}
              onRowSizes={(orientation, rows) =>
                setGridSizes(entry.id, activeTab.id, (sizes) =>
                  withRowSizes(sizes, orientation, rows),
                )
              }
              onColSizes={(orientation, row, cols) =>
                setGridSizes(entry.id, activeTab.id, (sizes) =>
                  withColSizes(sizes, orientation, row, cols),
                )
              }
              onResetSizes={(orientation) =>
                setGridSizes(entry.id, activeTab.id, (sizes) => resetGridSizes(sizes, orientation))
              }
              drag={windowDrag.drag}
              onDragStart={windowDrag.start}
            />
          </div>
        )}
        <WorkbenchDrawer projectId={entry.id} />
        <WorkbenchCanvasPanel projectId={entry.id} />
      </div>
      <ConfirmDialog
        open={confirmCloseTabId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmCloseTabId(null);
          }
        }}
        title={t("workbench.tab.closeConfirmTitle")}
        description={t("workbench.tab.closeConfirmBody")}
        tone="danger"
        confirmLabel={t("workbench.tab.close")}
        onConfirm={() => {
          if (confirmCloseTabId !== null) {
            void closeTab(entry.id, confirmCloseTabId);
          }
          setConfirmCloseTabId(null);
        }}
      />
      <NewWindowDialog
        open={newWindowOpen}
        {...(entry !== null ? { projectId: entry.id, projectRoot: entry.rootPath } : {})}
        onOpenChange={(open) => {
          setNewWindowOpen(open);
          if (!open) {
            setPendingCreate(null);
          }
        }}
        onConfirm={applyNewWindow}
      />
    </>
  );
}
