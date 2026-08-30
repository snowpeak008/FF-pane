import type { ProjectRegistryEntry } from "@ff-pane/shared";
import { Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Tooltip } from "../../components/ui/Tooltip";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";

export interface ProjectCardProps {
  readonly project: ProjectRegistryEntry;
  /** 从工作台移除（仅出注册表，不删磁盘；父页面走可撤销 toast）。 */
  readonly onRemove: (project: ProjectRegistryEntry) => void;
  /** 移除请求在飞时禁用按钮，防重复触发。 */
  readonly removing: boolean;
}

/**
 * 项目卡片（W3.3 / 设计系统 §5.3、§11.1）。
 *
 * 内容顺序：名称 → 根路径（font-mono，中间省略）→ 登记时间（相对，hover 绝对）。
 * 派生信息（当前计划版本、进行中任务数）由后续查询工单补充，此处先给身份三件套。
 * 「打开项目」需要当前项目上下文（尚未接线），故本卡暂不承载导航，避免造无目的跳转。
 */
export function ProjectCard({ project, onRemove, removing }: ProjectCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <Card padding="compact" className="flex flex-col gap-2">
      <CardHeader
        title={project.name}
        actions={
          <Tooltip content={t("projects.card.removeLabel", { name: project.name })} wrapTrigger>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={removing}
              aria-label={t("projects.card.removeLabel", { name: project.name })}
              onClick={() => onRemove(project)}
            >
              <Trash2 aria-hidden size={14} />
            </Button>
          </Tooltip>
        }
      />
      <p className="truncate font-mono text-xs text-fg-muted select-text" title={project.rootPath}>
        {project.rootPath}
      </p>
      <span
        className="font-mono text-xs text-fg-subtle"
        title={formatAbsoluteTime(project.createdAt, locale)}
      >
        {t("projects.card.createdAt", {
          time: formatRelativeTime(project.createdAt, locale),
        })}
      </span>
    </Card>
  );
}
