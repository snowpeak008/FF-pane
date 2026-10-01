/**
 * 工作台内侧滑抽屉：计划 / 任务 / 记录。默认关闭，没有常驻入口。
 */

import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  type ProjectId,
  type WorkbenchWindow,
} from "@ff-pane/shared";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BOARD_COLUMNS,
  type BoardMember,
  groupTeamBoard,
} from "../../../../shared/workbench/board";
import { isSingleMarkdownFileName } from "../../../../shared/workbench/markdown-name";
import type {
  WorkbenchBriefListItem,
  WorkbenchPanelActivityResponse,
  WorkbenchPanelId,
  WorkbenchThreadView,
} from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/Tabs";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { useWorkbenchStore } from "../../stores/workbench";
import { useWorkbenchPanelStore } from "../../stores/workbench-panel";
import { SafeMarkdownView } from "./SafeMarkdownView";

const THREAD_ROW_PX = 92;
const THREAD_PAGE = 40;

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function briefNameOf(relativePath: string | undefined): string | undefined {
  if (relativePath === undefined) {
    return undefined;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".md") ? name : undefined;
}

export function WorkbenchDrawer({
  projectId,
}: {
  readonly projectId: ProjectId;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const open = useWorkbenchPanelStore((s) => s.open);
  const tab = useWorkbenchPanelStore((s) => s.tab);
  const briefName = useWorkbenchPanelStore((s) => s.briefName);
  const openPanel = useWorkbenchPanelStore((s) => s.openPanel);
  const closePanel = useWorkbenchPanelStore((s) => s.closePanel);
  const selectBrief = useWorkbenchPanelStore((s) => s.selectBrief);
  const focusWindow = useWorkbenchStore((s) => s.focusWindow);
  const windows = useWorkbenchStore((s) => s.layoutsByProject[projectId]?.windows);

  const [briefs, setBriefs] = useState<readonly WorkbenchBriefListItem[]>([]);
  const [briefContent, setBriefContent] = useState<string>("");
  const [briefTruncated, setBriefTruncated] = useState(false);
  const [activity, setActivity] = useState<WorkbenchPanelActivityResponse | null>(null);
  const [threads, setThreads] = useState<readonly WorkbenchThreadView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [capped, setCapped] = useState(false);
  const [teamFilter, setTeamFilter] = useState("all");
  const [windowFilter, setWindowFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [threadStart, setThreadStart] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const loadBriefs = useCallback(async () => {
    const settled = await invokeQuery("workbench:list-briefs", { projectId });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setBriefs(settled.data.briefs);
  }, [projectId]);

  const loadActivity = useCallback(async () => {
    const settled = await invokeQuery("workbench:panel-activity", { projectId });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setActivity(settled.data);
  }, [projectId]);

  const loadThreads = useCallback(
    async (offset: number, replace: boolean) => {
      const settled = await invokeQuery("workbench:read-threads", {
        projectId,
        offset,
        limit: THREAD_PAGE,
      });
      if (settled.status === "error") {
        toast.error(settled.error.message);
        return;
      }
      setThreads((current) =>
        replace ? settled.data.records : [...current, ...settled.data.records],
      );
      setHasMore(settled.data.hasMore);
      setCapped(settled.data.capped);
      if (replace) {
        setThreadStart(0);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    if (tab === "plan") {
      void loadBriefs();
    } else if (tab === "tasks") {
      void loadActivity();
    } else {
      void loadThreads(0, true);
    }
  }, [loadActivity, loadBriefs, loadThreads, open, tab]);

  useSubscription("workbench:inbox-notice", () => {
    if (useWorkbenchPanelStore.getState().open) {
      void loadActivity();
      void loadThreads(0, true);
    }
  });
  useSubscription("workbench:child-window", (payload) => {
    if (payload.projectId === projectId && useWorkbenchPanelStore.getState().open) {
      void loadActivity();
    }
  });
  useSubscription("workbench:window-closed", (payload) => {
    if (payload.projectId === projectId && useWorkbenchPanelStore.getState().open) {
      void loadActivity();
    }
  });
  useSubscription("terminal:exit", () => {
    if (
      useWorkbenchPanelStore.getState().open &&
      useWorkbenchPanelStore.getState().tab === "tasks"
    ) {
      void loadActivity();
    }
  });

  useEffect(() => {
    if (!open || tab !== "plan" || briefs.length === 0) {
      return;
    }
    if (briefName !== null && briefs.some((item) => item.name === briefName)) {
      return;
    }
    selectBrief(briefs[0]?.name ?? null);
  }, [briefName, briefs, open, selectBrief, tab]);

  useEffect(() => {
    if (!open || tab !== "plan" || briefName === null) {
      return;
    }
    const item = briefs.find((entry) => entry.name === briefName);
    if (item === undefined) {
      return;
    }
    let cancelled = false;
    void invokeQuery("workbench:read-brief", { projectId, relativePath: item.relativePath }).then(
      (settled) => {
        if (cancelled) {
          return;
        }
        if (settled.status === "error") {
          toast.error(settled.error.message);
          return;
        }
        setBriefContent(settled.data.content);
        setBriefTruncated(settled.data.truncated);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [briefName, briefs, open, projectId, tab]);

  const members = useMemo(() => {
    const table = windows ?? {};
    const running = new Set(activity?.runningWindowIds ?? []);
    const list: BoardMember[] = [];
    for (const window of Object.values(table) as WorkbenchWindow[]) {
      const report = activity?.reports[window.id];
      const parentId = window.parentWindowId;
      const parent = parentId !== undefined ? table[parentId] : undefined;
      list.push({
        id: window.id,
        title: window.title,
        role: window.role ?? DEFAULT_WORKBENCH_ROLE,
        permission: window.permission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION,
        running: running.has(window.id),
        ...(parentId !== undefined && parentId.trim() !== ""
          ? { parentWindowId: parentId, parentTitle: parent?.title ?? parentId }
          : {}),
        ...(report !== undefined ? { report } : {}),
      });
    }
    return groupTeamBoard(list);
  }, [activity, windows]);

  const filteredThreads = useMemo(() => {
    return threads.filter((record) => {
      if (kindFilter !== "all" && record.kind !== kindFilter) {
        return false;
      }
      if (teamFilter !== "all" && record.threadFile !== teamFilter) {
        return false;
      }
      if (
        windowFilter !== "all" &&
        record.from.windowId !== windowFilter &&
        record.to.windowId !== windowFilter
      ) {
        return false;
      }
      return true;
    });
  }, [kindFilter, teamFilter, threads, windowFilter]);

  const teams = useMemo(() => {
    return [...new Set(threads.map((record) => record.threadFile))];
  }, [threads]);
  const windowOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of threads) {
      map.set(record.from.windowId, record.from.title);
      map.set(record.to.windowId, record.to.title);
    }
    return [...map.entries()];
  }, [threads]);

  const openInSystem = (relativePath: string): void => {
    void invokeQuery("workbench:open-ffpane", { projectId, relativePath }).then((settled) => {
      if (settled.status === "error") {
        toast.error(settled.error.message);
      }
    });
  };

  if (!open) {
    return null;
  }

  const visibleCount = 8;
  const visibleThreads = filteredThreads.slice(threadStart, threadStart + visibleCount);

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-20 cursor-default bg-black/20"
        aria-label={t("workbench.drawer.close")}
        data-testid="workbench-drawer-backdrop"
        onClick={closePanel}
      />
      <aside
        className="absolute inset-y-0 right-0 z-30 flex w-[min(36rem,100%)] flex-col border-l border-border bg-surface shadow-overlay"
        data-testid="workbench-drawer"
        data-panel={tab}
      >
        <Tabs
          value={tab}
          onValueChange={(value) => openPanel(value as WorkbenchPanelId)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3">
            <TabsList>
              <TabsTrigger value="plan" data-testid="workbench-drawer-tab-plan">
                {t("workbench.drawer.tab.plan")}
              </TabsTrigger>
              <TabsTrigger value="tasks" data-testid="workbench-drawer-tab-tasks">
                {t("workbench.drawer.tab.tasks")}
              </TabsTrigger>
              <TabsTrigger value="runs" data-testid="workbench-drawer-tab-runs">
                {t("workbench.drawer.tab.runs")}
              </TabsTrigger>
            </TabsList>
            <Button size="sm" variant="ghost" onClick={closePanel}>
              {t("workbench.drawer.close")}
            </Button>
          </div>
          <TabsContent value="plan" className="flex min-h-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)]">
              <div className="min-h-0 overflow-auto border-r border-border">
                {briefs.length === 0 ? (
                  <p className="p-3 text-xs text-fg-muted">{t("workbench.drawer.plan.empty")}</p>
                ) : (
                  briefs.map((item) => (
                    <button
                      key={item.relativePath}
                      type="button"
                      data-testid="workbench-brief"
                      data-brief-name={item.name}
                      className={
                        item.name === briefName
                          ? "block w-full border-b border-border bg-surface-active px-2 py-2 text-left"
                          : "block w-full border-b border-border px-2 py-2 text-left hover:bg-surface-hover"
                      }
                      onClick={() => selectBrief(item.name)}
                    >
                      <span className="block truncate text-xs font-medium text-fg">
                        {item.name}
                      </span>
                      <span className="mt-0.5 block text-2xs text-fg-muted">
                        {new Date(item.mtimeMs).toLocaleString(i18n.language)}
                        {" · "}
                        {formatBytes(item.size)}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-end gap-2 border-b border-border px-2 py-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="workbench-brief-open"
                    disabled={briefName === null}
                    onClick={() => {
                      const item = briefs.find((entry) => entry.name === briefName);
                      if (item !== undefined) {
                        openInSystem(item.relativePath);
                      }
                    }}
                  >
                    {t("workbench.drawer.plan.open")}
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {briefTruncated ? (
                    <p className="mb-2 text-xs text-warning-text">
                      {t("workbench.drawer.plan.truncated")}
                    </p>
                  ) : null}
                  {briefName === null ? null : <SafeMarkdownView source={briefContent} />}
                </div>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="tasks" className="min-h-0 flex-1 overflow-auto p-3">
            {members.length === 0 ? (
              <p className="text-xs text-fg-muted">{t("workbench.drawer.tasks.empty")}</p>
            ) : (
              members.map((group) => (
                <section key={group.id} className="mb-4" data-testid="workbench-board-group">
                  <h3 className="mb-2 text-xs font-medium text-fg">{group.title}</h3>
                  <div className="flex gap-2 overflow-x-auto">
                    {BOARD_COLUMNS.map((column) => (
                      <div
                        key={column}
                        className="w-40 shrink-0"
                        data-testid={`workbench-board-${column}`}
                      >
                        <p className="mb-1 text-2xs text-fg-muted">
                          {t(`workbench.drawer.tasks.column.${column}`)}
                        </p>
                        {group.columns[column].map((card) => (
                          <BoardCard
                            key={card.id}
                            card={card}
                            onOpen={() => focusWindow(projectId, card.id)}
                            onBrief={(name) => selectBrief(name)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </TabsContent>
          <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
              <FilterSelect
                testId="workbench-thread-filter-team"
                label={t("workbench.drawer.runs.filterTeam")}
                value={teamFilter}
                onChange={setTeamFilter}
                options={[
                  ["all", t("workbench.drawer.runs.all")],
                  ...teams.map((team) => [team, team] as const),
                ]}
              />
              <FilterSelect
                testId="workbench-thread-filter-window"
                label={t("workbench.drawer.runs.filterWindow")}
                value={windowFilter}
                onChange={setWindowFilter}
                options={[
                  ["all", t("workbench.drawer.runs.all")],
                  ...windowOptions.map(([id, title]) => [id, title] as const),
                ]}
              />
              <FilterSelect
                testId="workbench-thread-filter-kind"
                label={t("workbench.drawer.runs.filterKind")}
                value={kindFilter}
                onChange={setKindFilter}
                options={[
                  ["all", t("workbench.drawer.runs.all")],
                  ["message", t("workbench.drawer.runs.kind.message")],
                  ["report", t("workbench.drawer.runs.kind.report")],
                  ["system", t("workbench.drawer.runs.kind.system")],
                ]}
              />
            </div>
            {capped ? (
              <p className="px-3 pt-2 text-2xs text-fg-muted">
                {t("workbench.drawer.runs.capped")}
              </p>
            ) : null}
            {filteredThreads.length === 0 ? (
              <p className="p-3 text-xs text-fg-muted">{t("workbench.drawer.runs.empty")}</p>
            ) : (
              <div
                ref={scrollerRef}
                className="min-h-0 flex-1 overflow-auto"
                onScroll={() => {
                  const el = scrollerRef.current;
                  if (el === null) {
                    return;
                  }
                  setThreadStart(Math.max(0, Math.floor(el.scrollTop / THREAD_ROW_PX) - 2));
                }}
              >
                <div
                  className="relative"
                  style={{ height: filteredThreads.length * THREAD_ROW_PX }}
                >
                  {visibleThreads.map((record, index) => (
                    <article
                      key={record.id}
                      data-testid="workbench-thread-row"
                      data-kind={record.kind}
                      className="absolute inset-x-0 overflow-hidden border-b border-border px-3 py-2"
                      style={{ top: (threadStart + index) * THREAD_ROW_PX, height: THREAD_ROW_PX }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-2xs text-fg-muted">
                          {new Date(record.ts).toLocaleString(i18n.language)}
                          {" · "}
                          {t(`workbench.drawer.runs.kind.${record.kind}`)}
                          {" · "}
                          {record.from.title}
                          {" → "}
                          {record.to.title}
                        </p>
                        {isSingleMarkdownFileName(record.threadFile) ? (
                          <button
                            type="button"
                            className="shrink-0 text-2xs text-primary"
                            data-testid="workbench-thread-open-md"
                            onClick={() => openInSystem(`.ffpane/threads/${record.threadFile}`)}
                          >
                            {t("workbench.drawer.runs.openMd")}
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-fg">
                        {record.text}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            )}
            {hasMore ? (
              <div className="border-t border-border p-2">
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="workbench-thread-more"
                  onClick={() => void loadThreads(threads.length, false)}
                >
                  {t("workbench.drawer.runs.loadMore")}
                </Button>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </aside>
    </>
  );
}

function BoardCard({
  card,
  onOpen,
  onBrief,
}: {
  readonly card: BoardMember;
  readonly onOpen: () => void;
  readonly onBrief: (name: string) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const brief = briefNameOf(card.report?.briefPath);
  return (
    <div
      data-testid="workbench-board-card"
      data-window-id={card.id}
      className="mb-2 rounded-md border border-border bg-surface-raised p-2 hover:bg-surface-hover"
    >
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        <span className="block truncate text-xs font-medium text-fg">{card.title}</span>
        <span className="mt-1 block text-2xs text-fg-muted">
          {t(`workbench.role.level.${card.role}`)}
          {" · "}
          {t(`workbench.permission.level.${card.permission}`)}
        </span>
        {card.parentTitle !== undefined ? (
          <span className="mt-0.5 block truncate text-2xs text-fg-muted">
            {t("workbench.drawer.tasks.parent", { name: card.parentTitle })}
          </span>
        ) : null}
        <span className="mt-1 block line-clamp-3 whitespace-pre-wrap text-2xs text-fg">
          {card.report?.summary ?? t("workbench.drawer.tasks.noReport")}
        </span>
        {card.report !== undefined ? (
          <span className="mt-1 block text-2xs text-fg-subtle">
            {new Date(card.report.ts).toLocaleString(i18n.language)}
          </span>
        ) : null}
      </button>
      {brief !== undefined ? (
        <button
          type="button"
          className="mt-1 text-2xs text-primary"
          data-testid="workbench-board-brief"
          onClick={() => onBrief(brief)}
        >
          {t("workbench.drawer.tasks.brief")}
        </button>
      ) : null}
    </div>
  );
}

function FilterSelect({
  testId,
  label,
  value,
  onChange,
  options,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
}): ReactElement {
  return (
    <label className="flex items-center gap-1 text-2xs text-fg-muted">
      {label}
      <select
        data-testid={testId}
        className="h-7 rounded-sm border border-border bg-surface px-1 text-xs text-fg"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
