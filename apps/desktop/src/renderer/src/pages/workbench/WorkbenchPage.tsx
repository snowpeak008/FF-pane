/**
 * 工作台页（T10.1 临时入口）：单个以当前项目 rootPath（无项目则主目录）为 cwd 的 PowerShell 终端。
 * T10.2 将扩展为分屏 + 标签页 + 多项目。
 */

import { type ReactElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LoadingState } from "../../components/states/LoadingState";
import { useActiveProject } from "../../hooks/useActiveProject";
import { PageHeader } from "../../layout/PageHeader";
import { TerminalView } from "./TerminalView";

export function WorkbenchPage(): ReactElement {
  const { t } = useTranslation();
  const { entry, loading } = useActiveProject();

  const cwd = useMemo(() => entry?.rootPath, [entry?.rootPath]);

  return (
    <>
      <PageHeader
        title={t("nav.workbench.label")}
        description={
          entry === null
            ? t("workbench.cwd.home")
            : t("workbench.cwd.project", { path: entry.rootPath })
        }
      />
      {loading ? (
        <LoadingState variant="list" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          {/* cwd 变更时重建终端（切项目）；无项目时不传 cwd，主进程回退主目录 */}
          <TerminalView key={cwd ?? "__home__"} {...(cwd === undefined ? {} : { cwd })} />
        </div>
      )}
    </>
  );
}
