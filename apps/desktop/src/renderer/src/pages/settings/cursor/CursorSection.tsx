/**
 * 设置 → 模型 → Cursor（T11.18，计划 docs/Cursor账号管理计划.md）。
 * 一眼看清 Cursor 能不能用：装没装、登录的账号和档位、CLI 版本；
 * 软件里登录 / 换账号（退出再登录）/ 退出 / 更新 / 安装；FF-pane 开 Cursor 窗口的默认模型。
 */

import { DEFAULT_CURSOR_MODEL, effectiveCursorDefaultModel } from "@ff-pane/shared";
import { RefreshCw } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  CursorAccountStatus,
  CursorCommandResult,
  LocalModelEntryWire,
} from "../../../../../shared-ipc/contracts";
import {
  CursorLoginPanel,
  cursorStatusText,
  isFreeTier,
  useCursorLogin,
} from "../../../components/cursor/CursorLogin";
import { InlineLoading } from "../../../components/states/LoadingState";
import { Button } from "../../../components/ui/Button";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { inputVariants } from "../../../components/ui/input.variants";
import { Tooltip } from "../../../components/ui/Tooltip";
import { invokeQuery, queryData } from "../../../ipc/query";
import { useInvokeQuery } from "../../../ipc/useInvokeQuery";
import { cn } from "../../../lib/cn";
import { useWorkbenchStore } from "../../../stores/workbench";
import { SettingRow } from "../SettingRow";

const selectClass = cn(inputVariants({}), "w-64 cursor-pointer");

type Busy = "logout" | "update" | "install" | null;
type Pending = "logout" | "switch" | "install" | null;

/** 开着的 Cursor 窗口数：换账号、退出前提醒它们还用旧账号。 */
function useRunningCursorWindows(): number {
  const layouts = useWorkbenchStore((s) => s.layoutsByProject);
  return useMemo(
    () =>
      Object.values(layouts)
        .flatMap((layout) => Object.values(layout.windows))
        .filter((window) => window.kind === "cursor" && window.terminalId !== undefined).length,
    [layouts],
  );
}

export function CursorSection(): ReactElement {
  const { t } = useTranslation();
  const statusQuery = useInvokeQuery("cursor:status");
  const status = queryData(statusQuery.state);
  const configQuery = useInvokeQuery("config:get");
  const config = queryData(configQuery.state);
  const [busy, setBusy] = useState<Busy>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [output, setOutput] = useState<CursorCommandResult | null>(null);
  const [models, setModels] = useState<readonly LocalModelEntryWire[] | undefined>(undefined);
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  const [loadingModels, setLoadingModels] = useState(false);
  const running = useRunningCursorWindows();
  const login = useCursorLogin(() => {
    statusQuery.refetch();
  });

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true);
    setModelsError(undefined);
    const settled = await invokeQuery("providers:list-local-models", { runtime: "cursor" });
    setLoadingModels(false);
    if (settled.status === "error") {
      setModelsError(settled.error.message);
      return;
    }
    if (!settled.data.ok) {
      setModelsError(settled.data.detail);
      return;
    }
    setModels(settled.data.models);
  };

  // 登录了就顺手把模型列出来（要联网，几秒）。
  const signedIn = status?.installed === true && status.authenticated === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在登录状态变了时取一次
  useEffect(() => {
    if (signedIn && models === undefined && !loadingModels) {
      void loadModels();
    }
  }, [signedIn]);

  const runCommand = async (
    kind: "logout" | "update" | "install",
    then?: () => void,
  ): Promise<void> => {
    setBusy(kind);
    setOutput(null);
    const channel =
      kind === "logout" ? "cursor:logout" : kind === "update" ? "cursor:update" : "cursor:install";
    const settled = await invokeQuery(channel);
    setBusy(null);
    if (settled.status === "error") {
      setOutput({ ok: false, output: settled.error.message });
      return;
    }
    setOutput(kind === "logout" && settled.data.ok ? null : settled.data);
    if (kind === "logout") {
      setModels(undefined);
    }
    statusQuery.refetch();
    if (settled.data.ok) {
      then?.();
    }
  };

  const confirmed = (which: Pending): void => {
    setPending(null);
    if (which === "logout") {
      void runCommand("logout");
    } else if (which === "switch") {
      void runCommand("logout", () => void login.start());
    } else if (which === "install") {
      void runCommand("install");
    }
  };

  const askLogout = (which: "logout" | "switch"): void => {
    if (running > 0) {
      setPending(which);
      return;
    }
    confirmed(which);
  };

  const currentModel = effectiveCursorDefaultModel(config?.cursorDefaultModel);
  const modelOptions = useMemo(() => {
    const list = models ?? [];
    return list.some((item) => item.id === currentModel)
      ? list
      : [{ id: currentModel, displayName: currentModel, isDefault: false }, ...list];
  }, [models, currentModel]);

  const saveModel = async (model: string): Promise<void> => {
    const settled = await invokeQuery("config:update", { cursorDefaultModel: model });
    if (settled.status === "error") {
      toast.error(t("cursor.model.saveError"), { description: settled.error.message });
      return;
    }
    configQuery.refetch();
  };

  return (
    <section className="flex flex-col gap-2" data-testid="settings-cursor">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-fg">{t("cursor.title")}</h2>
        <Tooltip content={t("cursor.refresh")}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t("cursor.refresh")}
            data-testid="cursor-refresh"
            onClick={() => statusQuery.refetch()}
          >
            <RefreshCw aria-hidden size={14} />
          </Button>
        </Tooltip>
      </div>
      <p className="text-xs text-fg-subtle">{t("cursor.intro")}</p>

      {statusQuery.state.status === "error" ? (
        <span className="text-xs text-danger-text">{statusQuery.state.error.message}</span>
      ) : status === undefined ? (
        <InlineLoading />
      ) : (
        <StatusCard
          status={status}
          busy={busy}
          loginActive={login.state.phase === "waiting"}
          onLogin={() => void login.start()}
          onSwitch={() => askLogout("switch")}
          onLogout={() => askLogout("logout")}
          onUpdate={() => void runCommand("update")}
          onInstall={() => setPending("install")}
        />
      )}

      <CursorLoginPanel login={login} />

      {output !== null ? (
        <pre
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border px-3 py-2 font-mono text-2xs",
            output.ok
              ? "border-border bg-surface-sunken text-fg-muted"
              : "border-danger-border bg-danger-surface text-danger-text",
          )}
          data-testid="cursor-command-output"
        >
          {output.output || (output.ok ? t("cursor.command.ok") : t("cursor.command.failed"))}
        </pre>
      ) : null}

      {status?.installed === true ? (
        <SettingRow
          htmlFor="setting-cursor-model"
          label={t("cursor.model.label")}
          description={isFreeTier(status) ? t("cursor.model.freeHint") : t("cursor.model.hint")}
        >
          <div className="flex items-center gap-2">
            <select
              id="setting-cursor-model"
              className={selectClass}
              data-testid="cursor-default-model"
              value={currentModel}
              disabled={config === undefined}
              onChange={(event) => void saveModel(event.target.value)}
            >
              {modelOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === DEFAULT_CURSOR_MODEL
                    ? t("cursor.model.auto")
                    : `${item.displayName} (${item.id})`}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              data-testid="cursor-list-models"
              loading={loadingModels}
              onClick={() => void loadModels()}
            >
              {t("cursor.model.list")}
            </Button>
          </div>
        </SettingRow>
      ) : null}
      {modelsError !== undefined ? (
        <span className="text-xs text-danger-text">{modelsError}</span>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
          }
        }}
        title={
          pending === "install" ? t("cursor.install.confirmTitle") : t("cursor.logout.confirmTitle")
        }
        description={
          pending === "install"
            ? t("cursor.install.confirmBody")
            : t("cursor.logout.runningBody", { count: running })
        }
        tone="primary"
        confirmLabel={
          pending === "install"
            ? t("cursor.install.action")
            : pending === "switch"
              ? t("cursor.switch")
              : t("cursor.logout.action")
        }
        onConfirm={() => confirmed(pending)}
      />
    </section>
  );
}

function StatusCard({
  status,
  busy,
  loginActive,
  onLogin,
  onSwitch,
  onLogout,
  onUpdate,
  onInstall,
}: {
  readonly status: CursorAccountStatus;
  readonly busy: Busy;
  readonly loginActive: boolean;
  readonly onLogin: () => void;
  readonly onSwitch: () => void;
  readonly onLogout: () => void;
  readonly onUpdate: () => void;
  readonly onInstall: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const signedIn = status.installed && status.authenticated === true;
  const dot = !status.installed
    ? "bg-fg-subtle"
    : signedIn
      ? "bg-success"
      : status.authenticated === false
        ? "bg-warning"
        : "bg-fg-subtle";
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
      data-testid="cursor-status"
      data-installed={status.installed ? "yes" : "no"}
      data-signed-in={signedIn ? "yes" : "no"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-2 text-fg">
          <span className={cn("size-2 rounded-full", dot)} aria-hidden />
          <span data-testid="cursor-status-text">{cursorStatusText(t, status)}</span>
        </span>
        {status.installed && status.version !== undefined ? (
          <span className="text-xs text-fg-muted">
            {t("cursor.status.version", { version: status.version })}
            {status.updateAvailable === true && status.latestVersion !== undefined
              ? ` · ${t("cursor.status.updateAvailable", { version: status.latestVersion })}`
              : ""}
          </span>
        ) : null}
      </div>
      {status.detail !== undefined ? (
        <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-fg-muted">
          {status.detail}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!status.installed ? (
          <Button
            size="sm"
            data-testid="cursor-install"
            loading={busy === "install"}
            onClick={onInstall}
          >
            {t("cursor.install.action")}
          </Button>
        ) : signedIn ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              data-testid="cursor-switch"
              disabled={busy !== null || loginActive}
              onClick={onSwitch}
            >
              {t("cursor.switch")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="cursor-logout"
              loading={busy === "logout"}
              disabled={busy !== null || loginActive}
              onClick={onLogout}
            >
              {t("cursor.logout.action")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            data-testid="cursor-login"
            disabled={busy !== null || loginActive}
            onClick={onLogin}
          >
            {t("cursor.login.action")}
          </Button>
        )}
        {status.installed && status.updateAvailable === true ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="cursor-update"
            loading={busy === "update"}
            disabled={busy !== null}
            onClick={onUpdate}
          >
            {t("cursor.update")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
