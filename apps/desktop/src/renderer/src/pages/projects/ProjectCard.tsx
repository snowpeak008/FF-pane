import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { Check, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { CardButton } from "../../components/ui/Card";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";

export interface ProjectCardProps {
  readonly project: ProjectRegistryEntry;
  /** 打开（设为当前项目）；父页面据此切换 activeProjectId。 */
  readonly onOpen: (project: ProjectRegistryEntry) => void;
  /** 从工作台移除（仅出注册表，不删磁盘；父页面走可撤销 toast）。 */
  readonly onRemove: (project: ProjectRegistryEntry) => void;
  /** 是否为当前项目（选中态）。 */
  readonly active: boolean;
  /** 移除请求在飞时禁用按钮，防重复触发。 */
  readonly removing: boolean;
}

/**
 * 项目卡片（W3.3 / 设计系统 §5.3、§11.1）。
 *
 * 整卡可点 = 打开（设为当前项目，CardButton 天然键盘可达）；移除按钮为绝对定位的兄弟节点，
 * 避免按钮嵌套按钮。内容顺序：名称 → 根路径（font-mono，中间省略）→ 登记时间（相对，hover 绝对）。
 * 派生信息（当前计划版本、进行中任务数）由后续查询工单补充。
 */
export function ProjectCard({
  project,
  onOpen,
  onRemove,
  active,
  removing,
}: ProjectCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <div className="relative">
      <CardButton
        padding="compact"
        selected={active}
        onClick={() => onOpen(project)}
        className="flex w-full flex-col gap-2 pr-10"
      >
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
          {active ? <Check aria-hidden className="shrink-0 text-primary-text" size={14} /> : null}
          {project.name}
        </span>
        <span className="w-full truncate font-mono text-xs text-fg-muted" title={project.rootPath}>
          {project.rootPath}
        </span>
        <span
          className="font-mono text-xs text-fg-subtle"
          title={formatAbsoluteTime(project.createdAt, locale)}
        >
          {t("projects.card.createdAt", { time: formatRelativeTime(project.createdAt, locale) })}
        </span>
      </CardButton>
      <Tooltip content={t("projects.card.removeLabel", { name: project.name })} wrapTrigger>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          disabled={removing}
          aria-label={t("projects.card.removeLabel", { name: project.name })}
          className={cn("absolute top-2 right-2")}
          onClick={() => onRemove(project)}
        >
          <Trash2 aria-hidden size={14} />
        </Button>
      </Tooltip>
    </div>
  );
}
