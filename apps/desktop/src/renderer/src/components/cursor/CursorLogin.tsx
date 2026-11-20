/**
 * 软件里登录 Cursor（T11.18）：主进程跑 `cursor-agent login`，认出登录链接后发 cursor:login 事件；
 * 这里显示「在浏览器里登录」和打开 / 复制链接 / 取消。设置页和新开窗口框里都内嵌这一块（不另开对话框）。
 */

import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CursorAccountStatus } from "../../../../shared-ipc/contracts";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { Button } from "../ui/Button";

export type CursorLoginState =
  | { readonly phase: "idle" }
  | { readonly phase: "waiting"; readonly url?: string }
  | { readonly phase: "done"; readonly status: CursorAccountStatus }
  | { readonly phase: "failed"; readonly error: string };

export interface CursorLogin {
  readonly state: CursorLoginState;
  readonly start: () => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
}

/** 登录流程的状态。登录成功时调 onSuccess（一般是刷新账号状态）。 */
export function useCursorLogin(onSuccess: (status: CursorAccountStatus) => void): CursorLogin {
  const { t } = useTranslation();
  const [state, setState] = useState<CursorLoginState>({ phase: "idle" });

  useSubscription("cursor:login", (event) => {
    if (event.phase === "url") {
      setState((current) =>
        current.phase === "waiting" ? { phase: "waiting", url: event.url } : current,
      );
      return;
    }
    if (event.ok) {
      setState({ phase: "done", status: event.status });
      onSuccess(event.status);
      return;
    }
    setState(
      event.cancelled === true ? { phase: "idle" } : { phase: "failed", error: event.error },
    );
  });

  return {
    state,
    start: async () => {
      setState({ phase: "waiting" });
      const settled = await invokeQuery("cursor:login-start");
      if (settled.status === "error") {
        setState({ phase: "failed", error: settled.error.message });
        return;
      }
      if (!settled.data.ok) {
        setState({ phase: "failed", error: settled.data.error });
      }
    },
    cancel: () => {
      void invokeQuery("cursor:login-cancel");
      setState({ phase: "idle" });
      toast.message(t("cursor.login.cancelled"));
    },
    reset: () => setState({ phase: "idle" }),
  };
}

/** 登录进行中 / 结束时的那一块。idle 时不显示。 */
export function CursorLoginPanel({ login }: { readonly login: CursorLogin }): ReactElement | null {
  const { t } = useTranslation();
  const { state } = login;
  if (state.phase === "idle") {
    return null;
  }
  if (state.phase === "done") {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-success-border bg-success-surface px-3 py-2 text-xs text-success-text"
        data-testid="cursor-login-done"
      >
        <CheckCircle2 aria-hidden size={14} />
        {t("cursor.login.done", { email: state.status.email ?? "" })}
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-danger-border bg-danger-surface px-3 py-2 text-xs text-danger-text"
        data-testid="cursor-login-failed"
      >
        <span>{t("cursor.login.failed")}</span>
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs">
          {state.error}
        </pre>
        <div>
          <Button size="sm" variant="secondary" onClick={() => void login.start()}>
            {t("cursor.login.retry")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-fg"
      data-testid="cursor-login-waiting"
    >
      <span className="flex items-center gap-2">
        <Loader2 aria-hidden size={14} className="animate-spin" />
        {state.url === undefined ? t("cursor.login.starting") : t("cursor.login.waiting")}
      </span>
      {state.url !== undefined ? (
        <>
          <span className="text-fg-muted">{t("cursor.login.switchHint")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="cursor-login-open"
              onClick={() => {
                void invokeQuery("cursor:login-open");
              }}
            >
              <ExternalLink aria-hidden size={14} />
              {t("cursor.login.open")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="cursor-login-copy"
              data-url={state.url}
              onClick={() => {
                const url = state.url;
                if (url !== undefined) {
                  void navigator.clipboard.writeText(url);
                  toast.message(t("cursor.login.copied"));
                }
              }}
            >
              <Copy aria-hidden size={14} />
              {t("cursor.login.copy")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="cursor-login-cancel"
              onClick={login.cancel}
            >
              {t("cursor.login.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            size="sm"
            variant="ghost"
            data-testid="cursor-login-cancel"
            onClick={login.cancel}
          >
            {t("cursor.login.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 一行账号状态：没装 / 没登录 / 已登录 邮箱 · 档位。 */
export function cursorStatusText(
  t: ReturnType<typeof useTranslation>["t"],
  status: CursorAccountStatus,
): string {
  if (!status.installed) {
    return t("cursor.status.missing");
  }
  if (status.authenticated === undefined) {
    return t("cursor.status.unknown");
  }
  if (!status.authenticated) {
    return t("cursor.status.loggedOut");
  }
  const who = status.email ?? status.name ?? "";
  return status.tier !== undefined
    ? t("cursor.status.loggedInTier", { who, tier: tierLabel(t, status.tier) })
    : t("cursor.status.loggedIn", { who });
}

export function tierLabel(t: ReturnType<typeof useTranslation>["t"], tier: string): string {
  return tier.toLowerCase() === "free" ? t("cursor.status.tierFree") : tier;
}

export function isFreeTier(status: CursorAccountStatus | undefined): boolean {
  return status?.tier?.toLowerCase() === "free";
}
