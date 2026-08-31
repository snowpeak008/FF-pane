import { AlertTriangle, Check, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectSummaryView } from "../../../../shared-ipc/contracts";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { CardButton } from "../../components/ui/Card";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";

export interface ProjectCardProps {
  /** 注册表条目 + 查询层当场汇总的派生信息（T7.4）。 */
  readonly view: ProjectSummaryView;
  /** 打开（设为当前项目）；父页面据此切换 activeProjectId。 */
  readonly onOpen: (project: ProjectSummaryView["entry"]) => void;
  /** 从工作台移除（仅出注册表，不删磁盘；父页面走可撤销 toast）。 */
  readonly onRemove: (project: ProjectSummaryView["entry"]) => void;
  /** 是否为当前项目（选中态）。 */
  readonly active: boolean;
  /** 移除请求在飞时禁用按钮，防重复触发。 */
  readonly removing: boolean;
}

/**
 * 项目卡片（W3.3 / 设计系统 §5.3、§11.1）。
 *
 * 整卡可点 = 打开（设为当前项目，CardButton 天然键盘可达）；移除按钮为绝对定位的兄弟节点，
 * 避免按钮嵌套按钮。内容顺序：名称 → 根路径（font-mono，中间省略）→ 派生信息三项
 * （当前计划版本与状态 / 进行中任务数 / 最后活动时间，T7.4）→ 登记时间（相对，hover 绝对）。
 *
 * 空态一律如实：没有计划就说没有计划，没有活动就说没有活动——项目列表是用来判断
 * 「各自到哪了」的，一个编出来的 v0 或拿登记时间冒充的"最后活动"会直接把这个判断带偏。
 */
export function ProjectCard({
  view,
  onOpen,
  onRemove,
  active,
  removing,
}: ProjectCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { entry: project, summary } = view;

  const degraded = summary.unavailable.length > 0;
  const warning = !summary.workbenchPresent
    ? t("projects.card.workbenchMissing")
    : degraded
      ? t("projects.card.partial", {
          // 顿号 / 逗号本身也是文案：中英文的列表分隔符不同，故经语言包取
          parts: summary.unavailable
            .map((part) => t(`projects.card.part.${part}`))
            .join(t("projects.card.partSeparator")),
        })
      : undefined;

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

        <span className="flex w-full flex-wrap items-center gap-1.5">
          {summary.planVersion !== undefined && summary.planStatus !== undefined ? (
            <Badge tone="primary">
              {t("projects.card.plan", {
                n: summary.planVersion,
                status: t(`plan.status.${summary.planStatus}`),
              })}
            </Badge>
          ) : (
            <Badge tone="neutral">{t("projects.card.noPlan")}</Badge>
          )}
          <Badge tone="neutral" title={t("projects.card.taskTotal", { n: summary.taskCount })}>
            {t("projects.card.activeTasks", { n: summary.activeTaskCount })}
          </Badge>
        </span>

        <span
          className="w-full truncate text-xs text-fg-subtle"
          title={
            summary.lastActivityAt !== undefined
              ? formatAbsoluteTime(summary.lastActivityAt, locale)
              : undefined
          }
        >
          {summary.lastActivityAt !== undefined && summary.lastActivitySource !== undefined
            ? t("projects.card.lastActivity", {
                time: formatRelativeTime(summary.lastActivityAt, locale),
                source: t(`projects.card.activitySource.${summary.lastActivitySource}`),
              })
            : t("projects.card.noActivity")}
        </span>

        {warning !== undefined ? (
          <span className="flex w-full items-center gap-1 text-xs text-warning-text">
            <AlertTriangle aria-hidden className="shrink-0" size={12} />
            <span className="truncate" title={warning}>
              {warning}
            </span>
          </span>
        ) : null}

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
