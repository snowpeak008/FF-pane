import { isProjectConfigVisibleTo, type ProjectConfig } from "@ff-pane/shared";
import { AlertTriangle, Check, Settings, Sparkles, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ProjectSummaryView, SkillView } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { CardButton } from "../../components/ui/Card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Tooltip } from "../../components/ui/Tooltip";
import { invokeQuery } from "../../ipc/query";
import { cn } from "../../lib/cn";
import { formatAbsoluteTime, formatRelativeTime } from "../../lib/time";
import { skillLimitKey, skillTitle } from "../settings/skills/skill-labels";

/** 每个窗口挂的技能建议不超过这么多（技能计划 §8.3），多了只提示不拦。 */
const SKILLS_SOFT_LIMIT = 5;

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
  /** 「配置」保存成功后让父页面重取列表（卡片上的技能数跟着变）。 */
  readonly onSaved?: () => void;
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
  onSaved,
}: ProjectCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { entry: project, summary } = view;
  const [bindOpen, setBindOpen] = useState(false);
  const [configs, setConfigs] = useState<readonly ProjectConfig[]>([]);
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  /** 项目外可写目录（T11.8），一行一个。 */
  const [outsideDirs, setOutsideDirs] = useState("");
  /** 技能库（T11.9）和这个项目勾上的技能（原名）。 */
  const [library, setLibrary] = useState<readonly SkillView[]>([]);
  const [skillsOn, setSkillsOn] = useState<readonly string[]>([]);
  const enabledCount = project.skills?.length ?? 0;

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

  const openBind = (): void => {
    setBindOpen(true);
    setOutsideDirs((project.outsideWriteDirs ?? []).join("\n"));
    setSkillsOn(project.skills ?? []);
    void (async () => {
      const [configsSettled, settingsSettled, projectsSettled, skillsSettled] = await Promise.all([
        invokeQuery("configs:list"),
        invokeQuery("projects:get-settings", { projectRoot: project.rootPath }),
        invokeQuery("projects:list"),
        invokeQuery("skills:list"),
      ]);
      // 卡片上的条目可能是保存前的旧值，以注册表为准。
      if (projectsSettled.status === "success") {
        const fresh = projectsSettled.data.find((item) => item.id === project.id);
        setOutsideDirs((fresh?.outsideWriteDirs ?? []).join("\n"));
        setSkillsOn(fresh?.skills ?? []);
      }
      setLibrary(skillsSettled.status === "success" ? skillsSettled.data.skills : []);
      const all = configsSettled.status === "success" ? configsSettled.data : [];
      const visible = all.filter((config) => isProjectConfigVisibleTo(config, project.id));
      const current =
        settingsSettled.status === "success" ? (settingsSettled.data.configId ?? "") : "";
      setConfigs(visible);
      setSelected(visible.some((config) => config.id === current) ? current : "");
    })();
  };

  const saveBind = async (): Promise<void> => {
    setSaving(true);
    const settled = await invokeQuery("projects:update-settings", {
      projectRoot: project.rootPath,
      patch: { configId: selected === "" ? null : selected },
    });
    const dirs = outsideDirs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const dirsSettled =
      settled.status === "success"
        ? await invokeQuery("projects:set-outside-write-dirs", { id: project.id, dirs })
        : undefined;
    const skillsSettled =
      dirsSettled?.status === "success"
        ? await invokeQuery("projects:set-skills", { id: project.id, skills: skillsOn })
        : undefined;
    setSaving(false);
    if (dirsSettled?.status === "error") {
      toast.error(dirsSettled.error.message);
      return;
    }
    if (skillsSettled?.status === "error") {
      toast.error(skillsSettled.error.message);
      return;
    }
    if (settled.status === "error") {
      toast.error(
        settled.error.code === "config-not-visible"
          ? t("projects.configNotVisible")
          : settled.error.message,
      );
      return;
    }
    setBindOpen(false);
    toast.success(t("projects.card.configSaved"));
    onSaved?.();
  };

  const toggleSkill = (name: string, on: boolean): void => {
    setSkillsOn((current) =>
      on
        ? [...current.filter((item) => item !== name), name]
        : current.filter((item) => item !== name),
    );
  };

  return (
    <div className="flex flex-col gap-1">
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
          <span
            className="w-full truncate font-mono text-xs text-fg-muted"
            title={project.rootPath}
          >
            {project.rootPath}
          </span>

          {warning !== undefined ? (
            <span className="flex w-full items-center gap-1 text-xs text-warning-text">
              <AlertTriangle aria-hidden className="shrink-0" size={12} />
              <span className="truncate" title={warning}>
                {warning}
              </span>
            </span>
          ) : null}

          {enabledCount > 0 ? (
            <span
              className="flex items-center gap-1 text-xs text-fg-muted"
              data-testid={`project-skills-count-${project.id}`}
            >
              <Sparkles aria-hidden className="shrink-0" size={12} />
              {t("projects.card.skillsCount", { count: enabledCount })}
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
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        data-testid={`project-bind-config-${project.id}`}
        onClick={openBind}
      >
        <Settings aria-hidden size={16} />
        {t("projects.card.configLabel")}
      </Button>
      <Dialog open={bindOpen} onOpenChange={setBindOpen}>
        <DialogContent data-testid="project-config-dialog">
          <DialogHeader title={t("projects.card.configTitle", { name: project.name })} />
          <DialogBody>
            <select
              className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-fg"
              data-testid="project-config-select"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">{t("projects.card.configUnset")}</option>
              {configs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name}
                </option>
              ))}
            </select>
            <label className="mt-4 flex flex-col gap-1 text-sm text-fg">
              {t("projects.card.outsideDirsLabel")}
              <textarea
                className="min-h-20 w-full rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-xs text-fg"
                data-testid="project-outside-dirs"
                placeholder={t("projects.card.outsideDirsPlaceholder")}
                value={outsideDirs}
                onChange={(event) => setOutsideDirs(event.target.value)}
              />
              <span className="text-xs text-fg-muted">{t("projects.card.outsideDirsHint")}</span>
            </label>
            <fieldset className="mt-4 flex flex-col gap-1" data-testid="project-skills">
              <legend className="text-sm text-fg">{t("projects.card.skillsLabel")}</legend>
              {library.length === 0 ? (
                <span className="text-xs text-fg-muted">{t("projects.card.skillsEmpty")}</span>
              ) : (
                library.map((skill) => {
                  const on = skillsOn.includes(skill.name);
                  const limit = skillLimitKey(skill);
                  return (
                    <label
                      key={skill.name}
                      className="flex items-start gap-2 rounded-sm px-1 py-1 hover:bg-surface-hover"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        data-testid={`project-skill-${skill.name}`}
                        checked={on}
                        onChange={(event) => toggleSkill(skill.name, event.target.checked)}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-fg">{skillTitle(skill)}</span>
                        {skill.displayName !== "" ? (
                          <span className="truncate font-mono text-2xs text-fg-subtle">
                            {skill.name}
                          </span>
                        ) : null}
                        {limit !== undefined ? (
                          <span className="text-xs text-warning-text">{t(limit)}</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })
              )}
              {skillsOn.length > SKILLS_SOFT_LIMIT ? (
                <span className="text-xs text-warning-text">
                  {t("projects.card.skillsTooMany", { count: SKILLS_SOFT_LIMIT })}
                </span>
              ) : null}
              <span className="text-xs text-fg-muted">{t("projects.card.skillsHint")}</span>
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setBindOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="project-config-save"
              loading={saving}
              onClick={() => void saveBind()}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
