/**
 * 新开窗口选 Gemini 时的账号状态（T11.23 §10）：没装 / 没登录 / 已登录 / 连接失败。
 * agy 没有 login 子命令，登录只能在 agy 自己的界面里完成，所以这里只提示怎么登录、给「重新检查」。
 * 「已登录」只说明凭据管理器里有登录记录；后台读一次模型当连通性检查（不调用模型，不耗额度），失败标「连接失败」。
 */

import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CursorCommandResult, GeminiAccountStatus } from "../../../../shared-ipc/contracts";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { InlineLoading } from "../states/LoadingState";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";

type Connection =
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "ok" }
  | { readonly phase: "failed"; readonly detail: string };

export function GeminiAccountPanel({
  model,
  onStatus,
}: {
  /** 这个窗口会用的模型（项目配置里填的）；空 = agy 的默认。 */
  readonly model: string;
  readonly onStatus?: (status: GeminiAccountStatus | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  const query = useInvokeQuery("gemini:status");
  const status = queryData(query.state);
  const [conn, setConn] = useState<Connection>({ phase: "idle" });
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<CursorCommandResult | undefined>(undefined);
  const seq = useRef(0);

  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  const signedIn = status?.installed === true && status.authenticated === true;

  const checkConnection = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    setConn({ phase: "checking" });
    const settled = await invokeQuery("providers:list-local-models", { runtime: "agy" });
    if (seq.current !== mine) {
      return;
    }
    if (settled.status === "error") {
      setConn({ phase: "failed", detail: settled.error.message });
    } else if (!settled.data.ok) {
      setConn({ phase: "failed", detail: settled.data.detail });
    } else {
      setConn({ phase: "ok" });
    }
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setConn({ phase: "idle" });
      return;
    }
    void checkConnection();
    return () => {
      seq.current += 1;
    };
  }, [signedIn, checkConnection]);

  const install = async (): Promise<void> => {
    setConfirmInstall(false);
    setInstalling(true);
    setInstallResult(undefined);
    const settled = await invokeQuery("gemini:install");
    setInstalling(false);
    setInstallResult(
      settled.status === "error" ? { ok: false, output: settled.error.message } : settled.data,
    );
    query.refetch();
  };

  if (query.state.status === "error") {
    return <p className="text-sm text-danger-text">{query.state.error.message}</p>;
  }
  if (status === undefined) {
    return <InlineLoading />;
  }

  const failed = signedIn && conn.phase === "failed";
  const tone = !status.installed || failed ? "danger" : signedIn ? "muted" : "warning";
  const modelName = model === "" ? t("gemini.defaultModel") : model;
  let text: string;
  if (!status.installed) {
    text = t("gemini.status.missing");
  } else if (status.authenticated === undefined) {
    text = t("gemini.status.unknown");
  } else if (!status.authenticated) {
    text = t("gemini.status.loggedOut");
  } else if (conn.phase === "failed") {
    text = t("gemini.status.failed", { detail: conn.detail });
  } else {
    text = `${t("gemini.status.loggedIn")} · ${t("gemini.using", { model: modelName })}`;
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="workbench-gemini-account"
      data-state={
        !status.installed
          ? "missing"
          : status.authenticated === undefined
            ? "unknown"
            : !status.authenticated
              ? "logged-out"
              : failed
                ? "failed"
                : "logged-in"
      }
    >
      <p
        className={cn(
          "text-sm",
          tone === "danger"
            ? "text-danger-text"
            : tone === "warning"
              ? "text-warning-text"
              : "text-fg-muted",
        )}
        data-testid="workbench-gemini-hint"
      >
        {text}
      </p>
      {status.installed && status.authenticated === undefined && status.detail !== undefined ? (
        <p className="text-xs text-fg-muted">{status.detail}</p>
      ) : null}
      {status.installed && status.authenticated === false ? (
        <p className="text-xs text-fg-muted" data-testid="workbench-gemini-login-hint">
          {t("gemini.loginHint")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!status.installed ? (
          <Button
            size="sm"
            variant="secondary"
            loading={installing}
            data-testid="workbench-gemini-install"
            onClick={() => setConfirmInstall(true)}
          >
            {t("gemini.goInstall")}
          </Button>
        ) : null}
        {!signedIn || failed ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="workbench-gemini-recheck"
            onClick={() => query.refetch()}
          >
            {t("gemini.recheck")}
          </Button>
        ) : null}
        {signedIn && conn.phase === "checking" ? <InlineLoading /> : null}
      </div>
      {installResult !== undefined ? (
        <p
          className={cn("text-xs", installResult.ok ? "text-fg-muted" : "text-danger-text")}
          data-testid="workbench-gemini-install-result"
        >
          {installResult.ok
            ? t("gemini.install.ok")
            : `${t("gemini.install.failed")}${installResult.output}`}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmInstall}
        onOpenChange={setConfirmInstall}
        title={t("gemini.install.confirmTitle")}
        description={t("gemini.install.confirmBody")}
        tone="primary"
        confirmLabel={t("gemini.goInstall")}
        onConfirm={() => void install()}
      />
    </div>
  );
}
