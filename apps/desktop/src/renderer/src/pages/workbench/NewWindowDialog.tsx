/**
 * 工作台新建窗口对话框（T10.4 / T10.5）：PowerShell / Claude / Codex + 权限。
 */

import type { AgentProfile, WorkbenchPermissionLevel, WorkbenchWindowKind } from "@ff-pane/shared";
import {
  DEFAULT_WORKBENCH_WINDOW_PERMISSION,
  runtimeToWorkbenchKind,
  WORKBENCH_PERMISSION_LEVELS,
} from "@ff-pane/shared";
import { type ReactElement, useEffect, useMemo, useState } from "react";
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

const LAST_PROFILE_KEY_PREFIX = "ffpane.workbench.lastProfile.";

export type NewWindowKindChoice = WorkbenchWindowKind;

export interface NewWindowDialogResult {
  readonly kind: NewWindowKindChoice;
  readonly profileId?: string;
  readonly initialPrompt?: string;
  readonly permission?: WorkbenchPermissionLevel;
}

export interface NewWindowDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (result: NewWindowDialogResult) => void;
}

function readLastProfileId(cli: "claude-code" | "codex"): string | undefined {
  try {
    return localStorage.getItem(`${LAST_PROFILE_KEY_PREFIX}${cli}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberLastProfileId(cli: "claude-code" | "codex", profileId: string): void {
  try {
    localStorage.setItem(`${LAST_PROFILE_KEY_PREFIX}${cli}`, profileId);
  } catch {
    // ignore
  }
}

export function NewWindowDialog({
  open,
  onOpenChange,
  onConfirm,
}: NewWindowDialogProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state: profilesState } = useInvokeQuery("profiles:list");
  const { state: configState } = useInvokeQuery("config:get");
  const profiles = queryData(profilesState) ?? [];
  const defaultPermission =
    queryData(configState)?.defaultWorkbenchPermission ?? DEFAULT_WORKBENCH_WINDOW_PERMISSION;

  const [kind, setKind] = useState<NewWindowKindChoice>("shell");
  const [profileId, setProfileId] = useState<string>("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [permission, setPermission] = useState<WorkbenchPermissionLevel>(defaultPermission);
  const [yoloConfirm, setYoloConfirm] = useState(false);
  const [cliMissing, setCliMissing] = useState(false);
  const [probing, setProbing] = useState(false);

  const aiRuntime = kind === "claude" ? "claude-code" : kind === "codex" ? "codex" : undefined;
  const matchingProfiles = useMemo(() => {
    if (aiRuntime === undefined) {
      return [] as AgentProfile[];
    }
    return profiles.filter((profile) => runtimeToWorkbenchKind(profile.runtime) === kind);
  }, [aiRuntime, kind, profiles]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPermission(defaultPermission);
    setYoloConfirm(false);
  }, [defaultPermission, open]);

  useEffect(() => {
    if (!open || aiRuntime === undefined) {
      return;
    }
    const last = readLastProfileId(aiRuntime);
    const preferred =
      (last !== undefined && matchingProfiles.some((p) => p.id === last) ? last : undefined) ??
      matchingProfiles[0]?.id ??
      "";
    setProfileId(preferred);
  }, [aiRuntime, matchingProfiles, open]);

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
    (profileId !== "" &&
      matchingProfiles.length > 0 &&
      !cliMissing &&
      !probing &&
      (permission !== "yolo" || yoloConfirm));

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

          {kind !== "shell" ? (
            <>
              {cliMissing ? (
                <p className="text-sm text-danger-text" data-testid="workbench-cli-missing">
                  {t("workbench.newWindow.cliMissing", {
                    cli: kind === "claude" ? "Claude Code" : "Codex",
                  })}
                </p>
              ) : null}
              {matchingProfiles.length === 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-fg-muted">{t("workbench.newWindow.noProfile")}</p>
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
                  <Field htmlFor="workbench-new-profile" label={t("workbench.newWindow.profile")}>
                    <select
                      id="workbench-new-profile"
                      className="rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-fg"
                      data-testid="workbench-new-profile"
                      value={profileId}
                      onChange={(event) => setProfileId(event.target.value)}
                    >
                      {matchingProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                          {profile.model !== undefined ? ` · ${profile.model}` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
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
              if (kind !== "shell" && aiRuntime !== undefined && profileId !== "") {
                rememberLastProfileId(aiRuntime, profileId);
              }
              onConfirm({
                kind,
                ...(kind !== "shell" && profileId !== "" ? { profileId } : {}),
                ...(kind !== "shell" ? { permission } : {}),
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
