import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { SkillAppliesToWire, SkillView } from "../../../../../shared-ipc/contracts";
import { InlineLoading } from "../../../components/states/LoadingState";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { Input, SearchInput } from "../../../components/ui/Input";
import { inputVariants } from "../../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { cn } from "../../../lib/cn";
import { skillLimitKey, skillMatches, skillTitle } from "./skill-labels";

const APPLIES_TO: readonly SkillAppliesToWire[] = ["any", "claude", "codex"];

/**
 * 技能库（T11.9 / 技能计划 §3、§6）：导入、显示、改名、适用于哪家、打开目录填配置、删除。
 * 哪个项目用哪些技能不在这里勾，在项目卡片的「配置」里。
 */
export function SkillsSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("skills:list");
  const data = queryData(state);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  /** 库里已有同名技能，等用户确认替换。 */
  const [pendingReplace, setPendingReplace] = useState<{
    readonly sourceDir: string;
    readonly name: string;
    readonly usedBy: readonly string[];
  } | null>(null);
  const [removing, setRemoving] = useState<SkillView | null>(null);

  const runImport = async (sourceDir: string, replace: boolean): Promise<void> => {
    setImporting(true);
    const settled = await invokeQuery("skills:import", { sourceDir, replace });
    setImporting(false);
    if (settled.status === "error") {
      toast.error(t("settings.skills.importFailed"), { description: settled.error.message });
      return;
    }
    const outcome = settled.data;
    if (outcome.status === "exists") {
      setPendingReplace({ sourceDir, name: outcome.name, usedBy: outcome.usedBy });
      return;
    }
    toast.success(
      outcome.status === "replaced"
        ? outcome.sameAsBefore === true
          ? t("settings.skills.replacedSame", { name: outcome.name })
          : t("settings.skills.replaced", { name: outcome.name })
        : t("settings.skills.imported", { name: outcome.name }),
    );
    refetch();
  };

  const pickAndImport = async (): Promise<void> => {
    const picked = await invokeQuery("dialog:pick-directory");
    if (picked.status === "error") {
      toast.error(picked.error.message);
      return;
    }
    if (picked.data.cancelled) {
      return;
    }
    await runImport(picked.data.path, false);
  };

  const remove = async (skill: SkillView): Promise<void> => {
    const settled = await invokeQuery("skills:remove", { name: skill.name });
    setRemoving(null);
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    toast.success(t("settings.skills.removed", { name: skillTitle(skill) }));
    refetch();
  };

  const skills = data?.skills ?? [];
  const shown = skills.filter((skill) => skillMatches(skill, query));

  return (
    <section className="flex flex-col gap-3" data-testid="settings-skills">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-fg">{t("settings.skills.title")}</h2>
          <p className="text-xs text-fg-muted">{t("settings.skills.subtitle")}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="skills-import"
          loading={importing}
          onClick={() => void pickAndImport()}
        >
          <Plus aria-hidden size={14} />
          {t("settings.skills.import")}
        </Button>
      </div>

      {state.status === "loading" && data === undefined ? <InlineLoading /> : null}
      {state.status === "error" ? (
        <p className="text-xs text-danger-text">{state.error.message}</p>
      ) : null}

      {skills.length === 0 && data !== undefined ? (
        <p className="text-xs text-fg-muted" data-testid="skills-empty">
          {t("settings.skills.empty")}
        </p>
      ) : null}

      {skills.length > 0 ? (
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.skills.search")}
          iconLabel={t("settings.skills.search")}
          data-testid="skills-search"
        />
      ) : null}

      <ul className="flex flex-col gap-2">
        {shown.map((skill) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            onChanged={refetch}
            onRemove={() => setRemoving(skill)}
          />
        ))}
      </ul>

      {data !== undefined ? (
        <p className="font-mono text-2xs text-fg-subtle">
          {t("settings.skills.libraryDir", { dir: data.libraryDir })}
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingReplace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingReplace(null);
          }
        }}
        tone="primary"
        title={t("settings.skills.replaceTitle", { name: pendingReplace?.name ?? "" })}
        description={
          (pendingReplace?.usedBy.length ?? 0) > 0
            ? t("settings.skills.replaceUsedBy", {
                projects: pendingReplace?.usedBy.join(t("settings.skills.listSeparator")) ?? "",
              })
            : t("settings.skills.replaceUnused")
        }
        confirmLabel={t("settings.skills.replace")}
        onConfirm={() => {
          const pending = pendingReplace;
          setPendingReplace(null);
          if (pending !== null) {
            void runImport(pending.sourceDir, true);
          }
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
        title={t("settings.skills.removeTitle", {
          name: removing === null ? "" : skillTitle(removing),
        })}
        description={
          (removing?.usedBy.length ?? 0) > 0
            ? t("settings.skills.removeUsedBy", {
                projects: removing?.usedBy.join(t("settings.skills.listSeparator")) ?? "",
              })
            : t("settings.skills.removeUnused")
        }
        confirmLabel={t("settings.skills.remove")}
        onConfirm={() => {
          if (removing !== null) {
            void remove(removing);
          }
        }}
      />
    </section>
  );
}

function SkillRow({
  skill,
  onChanged,
  onRemove,
}: {
  readonly skill: SkillView;
  readonly onChanged: () => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draftName, setDraftName] = useState(skill.displayName);
  const limit = skillLimitKey(skill);

  const saveName = async (): Promise<void> => {
    if (draftName.trim() === skill.displayName) {
      return;
    }
    const settled = await invokeQuery("skills:set-display-name", {
      name: skill.name,
      displayName: draftName,
    });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    setDraftName(settled.data.displayName);
    onChanged();
  };

  const setAppliesTo = async (appliesTo: SkillAppliesToWire): Promise<void> => {
    const settled = await invokeQuery("skills:set-applies-to", { name: skill.name, appliesTo });
    if (settled.status === "error") {
      toast.error(settled.error.message);
      return;
    }
    onChanged();
  };

  const openDir = async (): Promise<void> => {
    const settled = await invokeQuery("skills:open-dir", { name: skill.name });
    if (settled.status === "error") {
      toast.error(settled.error.message);
    }
  };

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
      data-testid={`skill-${skill.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span
            className="truncate text-sm font-medium text-fg"
            data-testid={`skill-title-${skill.name}`}
          >
            {skillTitle(skill)}
          </span>
          {skill.displayName !== "" ? (
            <span className="truncate font-mono text-2xs text-fg-subtle">{skill.name}</span>
          ) : null}
          <p className="line-clamp-2 text-xs text-fg-muted">{skill.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`skill-open-${skill.name}`}
            onClick={() => void openDir()}
          >
            <FolderOpen aria-hidden size={14} />
            {t("settings.skills.openDir")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("settings.skills.removeLabel", { name: skillTitle(skill) })}
            data-testid={`skill-remove-${skill.name}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden size={14} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {skill.author !== "unknown" ? (
          <Badge>{t(`settings.skills.author.${skill.author}`)}</Badge>
        ) : null}
        {skill.needsPython ? <Badge>{t("settings.skills.needsPython")}</Badge> : null}
        {skill.needsNode ? <Badge>{t("settings.skills.needsNode")}</Badge> : null}
        {limit !== undefined ? (
          <span className="text-xs text-warning-text" data-testid={`skill-limit-${skill.name}`}>
            {t(limit)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label
          className="flex items-center gap-2 text-xs text-fg-muted"
          htmlFor={`skill-display-name-${skill.name}`}
        >
          {t("settings.skills.displayName")}
          <Input
            id={`skill-display-name-${skill.name}`}
            className="h-7 w-48 text-xs"
            value={draftName}
            placeholder={skill.name}
            data-testid={`skill-display-name-${skill.name}`}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <label
          className="flex items-center gap-2 text-xs text-fg-muted"
          htmlFor={`skill-applies-to-${skill.name}`}
        >
          {t("settings.skills.appliesTo")}
          <select
            id={`skill-applies-to-${skill.name}`}
            className={cn(inputVariants({}), "h-7 w-36 cursor-pointer text-xs")}
            value={skill.appliesTo}
            data-testid={`skill-applies-to-${skill.name}`}
            onChange={(event) => void setAppliesTo(event.target.value as SkillAppliesToWire)}
          >
            {APPLIES_TO.map((value) => (
              <option key={value} value={value}>
                {t(`settings.skills.appliesToOption.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-fg-subtle">
          {skill.usedBy.length > 0
            ? t("settings.skills.usedBy", {
                projects: skill.usedBy.join(t("settings.skills.listSeparator")),
              })
            : t("settings.skills.unused")}
        </span>
      </div>
    </li>
  );
}
