import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { progressPercent } from "./knowledge-view";
import type { KnowledgeImportProgress } from "./useKnowledgeImport";

export interface ImportProgressBarProps {
  readonly progress: KnowledgeImportProgress;
  readonly onCancel: () => void;
}

/**
 * 导入进度条（§8.3.2「导入进度」）。
 *
 * 扫描阶段的总数未知（还没走完目录树），此时**不假装进度**——
 * 显示条纹的不确定态并把已扫描数如实报出来，比让进度条从 0 慢慢爬到 90% 再卡住诚实。
 */
export function ImportProgressBar({ progress, onCancel }: ImportProgressBarProps): ReactElement {
  const { t } = useTranslation();
  const percent = progressPercent(progress.done, progress.total);

  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-sm border border-border bg-surface-sunken p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-fg">
          {t(`knowledge.phase.${progress.phase}`)}
          {progress.total > 0 ? ` · ${progress.done}/${progress.total}` : ` · ${progress.done}`}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label={t(`knowledge.phase.${progress.phase}`)}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-full overflow-hidden rounded-sm bg-border"
      >
        <div
          className={
            percent === undefined
              ? "h-full w-1/3 animate-pulse bg-primary"
              : "h-full bg-primary transition-[width]"
          }
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      {progress.currentPath !== undefined ? (
        <span className="truncate font-mono text-2xs text-fg-subtle">{progress.currentPath}</span>
      ) : null}
    </div>
  );
}
