/**
 * 新开窗口选 Cursor 时的账号状态（T11.18）：已登录谁、什么档位、用哪个模型；
 * 没登录能当场登录（内嵌，不另开对话框）；没装就指去设置里安装。
 */

import { DEFAULT_CURSOR_MODEL } from "@ff-pane/shared";
import { type ReactElement, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CursorAccountStatus } from "../../../../shared-ipc/contracts";
import { queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { InlineLoading } from "../states/LoadingState";
import { Button } from "../ui/Button";
import { CursorLoginPanel, cursorStatusText, isFreeTier, useCursorLogin } from "./CursorLogin";

export function CursorAccountPanel({
  model,
  onStatus,
  onGoSettings,
}: {
  /** 这个窗口会用的模型（项目配置的，或设置里的默认）。 */
  readonly model: string;
  readonly onStatus?: (status: CursorAccountStatus | undefined) => void;
  readonly onGoSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const query = useInvokeQuery("cursor:status");
  const status = queryData(query.state);
  const login = useCursorLogin(() => query.refetch());

  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  if (query.state.status === "error") {
    return <p className="text-sm text-danger-text">{query.state.error.message}</p>;
  }
  if (status === undefined) {
    return <InlineLoading />;
  }
  const signedIn = status.installed && status.authenticated === true;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="workbench-cursor-account"
      data-signed-in={signedIn ? "yes" : "no"}
    >
      <p
        className={cn(
          "text-sm",
          !status.installed ? "text-danger-text" : signedIn ? "text-fg-muted" : "text-warning-text",
        )}
        data-testid="workbench-cursor-hint"
      >
        {cursorStatusText(t, status)}
        {signedIn
          ? ` · ${t("cursor.model.using", {
              model: model === DEFAULT_CURSOR_MODEL ? t("cursor.model.auto") : model,
            })}`
          : ""}
      </p>
      {signedIn && isFreeTier(status) && model !== DEFAULT_CURSOR_MODEL ? (
        <p className="text-xs text-warning-text">{t("cursor.model.freeHint")}</p>
      ) : null}
      {!status.installed ? (
        <div>
          <Button size="sm" variant="secondary" onClick={onGoSettings}>
            {t("cursor.goInstall")}
          </Button>
        </div>
      ) : !signedIn && login.state.phase === "idle" ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            data-testid="workbench-cursor-login"
            onClick={() => void login.start()}
          >
            {t("cursor.login.here")}
          </Button>
        </div>
      ) : null}
      <CursorLoginPanel login={login} />
      <p className="text-xs text-fg-subtle">{t("workbench.newWindow.cursorHint")}</p>
    </div>
  );
}
