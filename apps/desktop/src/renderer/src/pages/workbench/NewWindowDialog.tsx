/**
 * 工作台新建窗口对话框：PowerShell / Claude / Codex + 权限。
 * AI 窗口按「项目绑定的配置 → 默认配置」选路，不再选档案。
 */

import type {
  ProjectConfig,
  ProjectId,
  WorkbenchPermissionLevel,
  WorkbenchRole,
  WorkbenchWindowKind,
} from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_ROLE,
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  isAiWorkbenchKind,
  projectConfigRoute,
  selectEffectiveProjectConfig,
  WORKBENCH_PERMISSION_LEVELS,
  WORKBENCH_ROLES,
} from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Field, Textarea } from "../../components/ui/Input";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";

export type NewWindowKindChoice = WorkbenchWindowKind;

export interface NewWindowDialogResult {
  readonly kind: NewWindowKindChoice;
  readonly initialPrompt?: string;
  readonly permission?: WorkbenchPermissionLevel;
  readonly role?: WorkbenchRole;
}

export interface NewWindowDialogProps {
  readonly open: boolean;
  readonly projectId?: ProjectId;
  readonly projectRoot?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (result: NewWindowDialogResult) => void;
}

export function NewWindowDialog({
  open,
  projectId,
  projectRoot,
  onOpenChange,
  onConfirm,
}: NewWindowDialogProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state: configState } = useInvokeQuery("config:get");
  const globalPermission =
    queryData(configState)?.defaultWorkbenchPermission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;

  const [kind, setKind] = useState<NewWindowKindChoice>("shell");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [permission, setPermission] = useState<WorkbenchPermissionLevel>(globalPermission);
  const [role, setRole] = useState<WorkbenchRole>(DEFAULT_WORKBENCH_ROLE);
  const [yoloConfirm, setYoloConfirm] = useState(false);
  const [cliMissing, setCliMissing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [effective, setEffective] = useState<ProjectConfig | undefined>(undefined);

  const aiRuntime =
    kind === "claude" || kind === "deepseek"
      ? "claude-code"
      : kind === "codex"
        ? "codex"
        : kind === "grok"
          ? "grok-build"
          : undefined;
  const route =
    isAiWorkbenchKind(kind) && effective !== undefined
      ? projectConfigRoute(effective, kind)
      : undefined;
  const routeMissing = kind !== "shell" && !loadingConfig && route === undefined;

  useEffect(() => {
    if (!open) {
      return;
    }
    setRole(DEFAULT_WORKBENCH_ROLE);
    setYoloConfirm(false);
    if (projectRoot === undefined || projectId === undefined) {
      setEffective(undefined);
      setPermission(globalPermission);
      return;
    }
    let cancelled = false;
    setLoadingConfig(true);
    void (async () => {
      const [configsSettled, settingsSettled] = await Promise.all([
        invokeQuery("configs:list"),
        invokeQuery("projects:get-settings", { projectRoot }),
      ]);
      if (cancelled) {
        return;
      }
      setLoadingConfig(false);
      const configs = configsSettled.status === "success" ? configsSettled.data : [];
      const boundId =
        settingsSettled.status === "success" ? settingsSettled.data.configId : undefined;
      const picked = selectEffectiveProjectConfig(configs, boundId, projectId);
      setEffective(picked);
      setPermission(picked?.defaultPermission ?? globalPermission);
    })();
    return () => {
      cancelled = true;
    };
  }, [globalPermission, open, projectId, projectRoot]);

  useEffect(() => {
    if (!open || aiRuntime === undefined) {
      setCliMissing(false);
      return;
    }
    let cancelled = false;
    setProbing(true);
    void (async () => {
      const settled = await invokeQuery("providers:probe-cli-login", { runtime: aiRuntime });
      if (cancelled) {
        return;
      }
      setProbing(false);
      if (settled.status === "success" && settled.data.status === "cli_missing") {
        setCliMissing(true);
      } else {
        setCliMissing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aiRuntime, open]);

  const canConfirm =
    kind === "shell" ||
    (!routeMissing &&
      !loadingConfig &&
      !cliMissing &&
      !probing &&
      (permission !== "yolo" || yoloConfirm));

  const routeLabel =
    route === undefined
      ? ""
      : route.connectionMode === "relay"
        ? t("workbench.newWindow.routeRelay")
        : t("workbench.newWindow.routeLocal");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workbench-new-window-dialog">
        <DialogHeader title={t("workbench.newWindow.title")} />
        <DialogBody className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-fg-muted">
              {t("workbench.newWindow.kind")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["shell", "workbench.newWindow.kindShell"],
                  ["claude", "workbench.newWindow.kindClaude"],
                  ["codex", "workbench.newWindow.kindCodex"],
                  ["grok", "workbench.newWindow.kindGrok"],
                  ["deepseek", "workbench.newWindow.kindDeepseek"],
                ] as const
              ).map(([value, labelKey]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={kind === value ? "primary" : "secondary"}
                  data-testid={`workbench-new-kind-${value}`}
                  onClick={() => setKind(value)}
                >
                  {t(labelKey)}
                </Button>
              ))}
            </div>
          </fieldset>

          {kind === "deepseek" ? (
            <p className="text-sm text-fg-muted" data-testid="workbench-deepseek-hint">
              {t("workbench.newWindow.deepseekHint")}
            </p>
          ) : null}

          {kind !== "shell" ? (
            <>
              {cliMissing ? (
                <p className="text-sm text-danger-text" data-testid="workbench-cli-missing">
                  {t("workbench.newWindow.cliMissing", {
                    cli:
                      kind === "claude" || kind === "deepseek"
                        ? "Claude Code"
                        : kind === "grok"
                          ? "Grok"
                          : "Codex",
                  })}
                </p>
              ) : null}
              {routeMissing ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-danger-text" data-testid="workbench-route-missing">
                    {t("workbench.newWindow.routeMissing", {
                      cli:
                        kind === "claude"
                          ? "Claude"
                          : kind === "grok"
                            ? "Grok"
                            : kind === "deepseek"
                              ? "DeepSeek"
                              : "Codex",
                      name: effective?.name ?? "",
                    })}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/settings");
                    }}
                  >
                    {t("workbench.newWindow.goSettings")}
                  </Button>
                </div>
              ) : (
                <>
                  {effective !== undefined && route !== undefined ? (
                    <p className="text-sm text-fg-muted" data-testid="workbench-new-route">
                      {t("workbench.newWindow.usingConfig", {
                        name: effective.name,
                        route: routeLabel,
                      })}
                    </p>
                  ) : null}
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="text-xs font-medium text-fg-muted">
                      {t("workbench.newWindow.permission")}
                    </legend>
                    <p className="text-2xs text-fg-muted">
                      {t("workbench.permission.windowsNote")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {WORKBENCH_PERMISSION_LEVELS.map((level) => (
                        <Button
                          key={level}
                          type="button"
                          size="sm"
                          variant={permission === level ? "primary" : "secondary"}
                          data-testid={`workbench-new-permission-${level}`}
                          onClick={() => {
                            setPermission(level);
                            if (level !== "yolo") {
                              setYoloConfirm(false);
                            }
                          }}
                        >
                          {t(`workbench.permission.level.${level}`)}
                        </Button>
                      ))}
                    </div>
                    {permission === "yolo" ? (
                      <label className="flex items-start gap-2 text-sm text-danger-text">
                        <input
                          type="checkbox"
                          className="mt-1"
                          data-testid="workbench-new-yolo-confirm"
                          checked={yoloConfirm}
                          onChange={(event) => setYoloConfirm(event.target.checked)}
                        />
                        <span>{t("workbench.newWindow.yoloConfirm")}</span>
                      </label>
                    ) : null}
                  </fieldset>
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="text-xs font-medium text-fg-muted">
                      {t("workbench.newWindow.role")}
                    </legend>
                    <p className="text-2xs text-fg-muted">{t("workbench.newWindow.roleHint")}</p>
                    <div className="flex flex-wrap gap-2">
                      {WORKBENCH_ROLES.map((item) => (
                        <Button
                          key={item}
                          type="button"
                          size="sm"
                          variant={role === item ? "primary" : "secondary"}
                          data-testid={`workbench-new-role-${item}`}
                          onClick={() => setRole(item)}
                        >
                          {t(`workbench.role.level.${item}`)}
                        </Button>
                      ))}
                    </div>
                  </fieldset>
                  <Field
                    htmlFor="workbench-new-prompt"
                    label={t("workbench.newWindow.initialPrompt")}
                  >
                    <Textarea
                      id="workbench-new-prompt"
                      data-testid="workbench-new-prompt"
                      rows={3}
                      value={initialPrompt}
                      placeholder={t("workbench.newWindow.initialPromptPlaceholder")}
                      onChange={(event) => setInitialPrompt(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("workbench.newWindow.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="workbench-new-confirm"
            disabled={!canConfirm}
            onClick={() => {
              onConfirm({
                kind,
                ...(kind !== "shell" ? { permission, role } : {}),
                ...(initialPrompt.trim() !== "" ? { initialPrompt: initialPrompt.trim() } : {}),
              });
              onOpenChange(false);
              setInitialPrompt("");
              setKind("shell");
              setYoloConfirm(false);
            }}
          >
            {t("workbench.newWindow.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
