import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { FolderPlus } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { invokeQuery } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { NAV_ICONS } from "../../layout/nav-icons";
import { PageHeader } from "../../layout/PageHeader";
import { useUiStore } from "../../stores/ui";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { ProjectCard } from "./ProjectCard";

/**
 * 项目列表页（W3.3 / 项目设计计划 §11.1「我有哪些项目，各自到哪了」）。
 *
 * 三态齐全（设计系统 §6.2）：首屏骨架 / 空态一句话 + 主操作 / 错误原文 + 重试。
 * 移除走可撤销 toast（§6.3「移除项目」）：立即执行 + 撤销按钮，不弹确认框；
 * 移除只出注册表、不删磁盘，故撤销 = 原样放回（projects:restore）。
 */
export function ProjectsPage(): ReactElement {
  const { t } = useTranslation();
  // projects:summary 而非 projects:list：本页要的是注册表 + 派生信息（T7.4，§11.1）
  const { state, refetch } = useInvokeQuery("projects:summary");
  const [createOpen, setCreateOpen] = useState(false);
  // 正在移除的项目 id 集合：禁用对应卡片的按钮，防重复触发
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);

  const openCreate = useCallback(() => setCreateOpen(true), []);

  const handleOpen = useCallback(
    (entry: ProjectRegistryEntry) => {
      setActiveProjectId(entry.id);
      toast.success(t("projects.opened", { name: entry.name }));
    },
    [setActiveProjectId, t],
  );

  const handleCreated = useCallback(
    (entry: ProjectRegistryEntry) => {
      refetch();
      toast.success(t("projects.create.toast", { name: entry.name }));
    },
    [refetch, t],
  );

  const restore = useCallback(
    async (entry: ProjectRegistryEntry) => {
      const settled = await invokeQuery("projects:restore", { entry });
      if (settled.status === "error") {
        toast.error(t("projects.remove.restoreError"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(t("projects.remove.restored", { name: entry.name }));
    },
    [refetch, t],
  );

  const handleRemove = useCallback(
    async (entry: ProjectRegistryEntry) => {
      setRemovingIds((prev) => new Set(prev).add(entry.id));
      const settled = await invokeQuery("projects:remove", { id: entry.id });
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      if (settled.status === "error") {
        toast.error(t("projects.remove.error"), { description: settled.error.message });
        return;
      }
      refetch();
      toast.success(t("projects.remove.toast", { name: entry.name }), {
        action: {
          label: t("common.undo"),
          onClick: () => void restore(settled.data),
        },
      });
    },
    [refetch, restore, t],
  );

  const newButton = (
    <Button variant="primary" size="md" onClick={openCreate}>
      <FolderPlus aria-hidden size={16} />
      {t("projects.new")}
    </Button>
  );

  const hasProjects = state.status === "success" && state.data.length > 0;

  return (
    <>
      <PageHeader
        title={t("nav.projects.label")}
        description={t("nav.projects.question")}
        actions={hasProjects ? newButton : undefined}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? <LoadingState variant="list" /> : null}

        {state.status === "error" ? (
          <ErrorState
            summary={t("projects.loadError")}
            error={state.error}
            onRetry={refetch}
            className="min-h-0"
          />
        ) : null}

        {state.status === "success" && state.data.length === 0 ? (
          <EmptyState
            className="min-h-0"
            icon={NAV_ICONS.projects}
            message={t("projects.empty")}
            action={{ label: t("projects.new"), onClick: openCreate }}
          />
        ) : null}

        {state.status === "success" && state.data.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.data.map((view) => (
              <ProjectCard
                key={view.entry.id}
                view={view}
                active={view.entry.id === activeProjectId}
                removing={removingIds.has(view.entry.id)}
                onOpen={handleOpen}
                onRemove={(entry) => void handleRemove(entry)}
              />
            ))}
          </div>
        ) : null}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </>
  );
}
