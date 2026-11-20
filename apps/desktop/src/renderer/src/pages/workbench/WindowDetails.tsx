/**
 * 窗口名的悬浮提示（§9 界面精简）：标题栏不再常挂的详情都在这一个提示框里，
 * 一个标题栏只挂这一个大提示框，不再每个小标签各挂一个。内容只在提示打开时渲染。
 */

import type { WorkbenchPermissionLevel, WorkbenchRole, WorkbenchWindow } from "@ff-pane/shared";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { WindowSkillsReport } from "../../../../shared-ipc/contracts";
import { DetailRow, WindowRuntimeDetails } from "./WorkbenchRuntimeBar";

export interface WindowDetailsProps {
  readonly window: WorkbenchWindow;
  readonly isCli: boolean;
  readonly kindLabel: string;
  readonly role: WorkbenchRole;
  readonly permission: WorkbenchPermissionLevel;
  readonly openedByLabel: string | undefined;
  readonly skillsReport: WindowSkillsReport | undefined;
  readonly lastReportStatus: string | undefined;
  readonly permissionCapped: boolean;
  /** 改模型 / 强度还没生效的原因（已翻译）。 */
  readonly modelEffortNote: string | undefined;
  readonly children: ReactElement;
}

export function WindowDetails(props: WindowDetailsProps): ReactElement {
  return (
    <TooltipPrimitive.Root delayDuration={400}>
      <TooltipPrimitive.Trigger asChild>{props.children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          // 读屏只念窗口名；不然 Radix 会把整块内容再抄一份隐藏副本。
          aria-label={props.window.title}
          className="z-50 flex max-w-sm flex-col gap-0.5 rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-fg shadow-raised select-text"
          data-testid="workbench-window-details"
        >
          <DetailsBody {...props} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function DetailsBody(props: WindowDetailsProps): ReactElement {
  const { t } = useTranslation();
  const { window } = props;
  return (
    <>
      <span className="mb-0.5 break-all font-medium">{window.title}</span>
      <DetailRow label={t("workbench.window.details.kind")}>{props.kindLabel}</DetailRow>
      {props.isCli ? (
        <>
          <DetailRow label={t("workbench.window.details.role")}>
            {t(`workbench.role.level.${props.role}`)}
          </DetailRow>
          <DetailRow label={t("workbench.window.details.permission")}>
            {props.permissionCapped
              ? t("workbench.permission.capped", {
                  level: t(`workbench.permission.level.${props.permission}`),
                })
              : t(`workbench.permission.level.${props.permission}`)}
          </DetailRow>
          {props.openedByLabel !== undefined ? (
            <DetailRow label={t("workbench.window.details.openedBy")} testId="workbench-opened-by">
              {props.openedByLabel}
            </DetailRow>
          ) : null}
          <DetailRow label={t("workbench.window.details.route")} testId="workbench-window-route">
            {t("workbench.window.routeSummary", {
              route:
                window.routeMode === "relay"
                  ? t("workbench.window.routeRelay", { name: window.routeProviderName ?? "" })
                  : window.routeMode === "local_cli"
                    ? t("workbench.window.routeLocal")
                    : t("workbench.window.routePending"),
              model: window.routeModel ?? t("workbench.window.modelDefault"),
              effort: window.routeEffort ?? t("workbench.window.effortDefault"),
            })}
          </DetailRow>
          {props.modelEffortNote !== undefined ? (
            <DetailRow label={t("workbench.window.details.pending")}>
              {props.modelEffortNote}
            </DetailRow>
          ) : null}
          <SkillsRow report={props.skillsReport} />
          <DetailRow label={t("workbench.window.details.session")}>
            {window.sessionUnidentified === true
              ? t("workbench.session.unidentified")
              : (window.nativeSessionId ?? t("workbench.session.pending"))}
          </DetailRow>
          {props.lastReportStatus !== undefined ? (
            <DetailRow label={t("workbench.window.details.report")}>
              {t(reportKey(props.lastReportStatus))}
            </DetailRow>
          ) : null}
        </>
      ) : null}
      <WindowRuntimeDetails windowId={window.id} />
    </>
  );
}

export function reportKey(status: string): string {
  return status === "done"
    ? "workbench.inbox.reportDone"
    : status === "blocked"
      ? "workbench.inbox.reportBlocked"
      : status === "failed"
        ? "workbench.inbox.reportFailed"
        : "workbench.inbox.reportProgress";
}

function SkillsRow({
  report,
}: {
  readonly report: WindowSkillsReport | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  if (report === undefined || (report.mounted.length === 0 && report.skipped.length === 0)) {
    return null;
  }
  return (
    <span
      className="flex gap-2"
      data-testid="workbench-window-skills"
      data-mounted={report.mounted.length}
      data-skipped={report.skipped.length}
    >
      <span className="w-14 shrink-0 text-fg-muted">{t("workbench.window.details.skills")}</span>
      <span className="flex min-w-0 flex-col">
        {report.mounted.length > 0 ? (
          <span>
            {t("workbench.skills.mounted", {
              names: report.mounted.join(t("settings.skills.listSeparator")),
            })}
          </span>
        ) : null}
        {report.skipped.map((item) => (
          <span key={item.name} className="text-warning-text">
            {t("workbench.skills.skipped", {
              name: item.name,
              reason: t(`workbench.skills.reason.${item.reason}`),
            })}
          </span>
        ))}
      </span>
    </span>
  );
}
