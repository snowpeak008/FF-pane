import type {
  ProjectConfig,
  ProjectConfigDraft,
  ProjectConfigRoute,
  ProjectId,
  ProjectRegistryEntry,
  Provider,
  ProviderId,
  ReasoningEffortLevel,
  WorkbenchPermissionLevel,
} from "@ff-pane/shared";
import {
  getProviderTemplate,
  REASONING_EFFORT_LEVELS,
  WORKBENCH_PERMISSION_LEVELS,
} from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../../components/ui/Dialog";
import { Field, Input } from "../../../components/ui/Input";
import { invokeQuery } from "../../../ipc/query";

type RouteSide = "claude" | "codex" | "grok";

function providersForSide(side: RouteSide, providers: readonly Provider[]): readonly Provider[] {
  const cli = side === "claude" ? "claude-code" : side === "codex" ? "codex" : "grok";
  return providers.filter(
    (provider) => getProviderTemplate(provider.templateId)?.applicableClis.includes(cli) === true,
  );
}

interface RouteDraft {
  enabled: boolean;
  connectionMode: "local_cli" | "relay";
  providerId: string;
  model: string;
  reasoningEffort: string;
  probedModels: readonly string[];
  probeNote: string;
}

function emptyRoute(enabled: boolean): RouteDraft {
  return {
    enabled,
    connectionMode: "local_cli",
    providerId: "",
    model: "",
    reasoningEffort: "",
    probedModels: [],
    probeNote: "",
  };
}

function routeFrom(route: ProjectConfigRoute | undefined): RouteDraft {
  if (route === undefined) {
    return emptyRoute(false);
  }
  return {
    enabled: true,
    connectionMode: route.connectionMode,
    providerId: route.providerId ?? "",
    model: route.model ?? "",
    reasoningEffort: route.reasoningEffort ?? "",
    probedModels: [],
    probeNote: "",
  };
}

function toRoute(draft: RouteDraft): ProjectConfigRoute | undefined {
  if (!draft.enabled) {
    return undefined;
  }
  const model = draft.model.trim();
  const effort = draft.reasoningEffort.trim();
  const extras = {
    ...(model !== "" ? { model } : {}),
    ...(effort !== "" ? { reasoningEffort: effort as ReasoningEffortLevel } : {}),
  };
  if (draft.connectionMode === "relay") {
    return {
      connectionMode: "relay",
      providerId: draft.providerId as ProviderId,
      ...extras,
    };
  }
  return { connectionMode: "local_cli", ...extras };
}

const selectClass = "rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-fg";

export interface ConfigEditorDialogProps {
  readonly open: boolean;
  readonly config: ProjectConfig | null;
  readonly providers: readonly Provider[];
  readonly projects: readonly ProjectRegistryEntry[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (name: string) => void;
}

export function ConfigEditorDialog({
  open,
  config,
  providers,
  projects,
  onOpenChange,
  onSaved,
}: ConfigEditorDialogProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [permission, setPermission] = useState("");
  const [scope, setScope] = useState<ReadonlySet<string>>(new Set());
  const [claude, setClaude] = useState<RouteDraft>(emptyRoute(true));
  const [codex, setCodex] = useState<RouteDraft>(emptyRoute(true));
  const [grok, setGrok] = useState<RouteDraft>(emptyRoute(false));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(config?.name ?? "");
    setPermission(config?.defaultPermission ?? "");
    setScope(new Set(config?.projectIds ?? []));
    setClaude(config === null ? emptyRoute(true) : routeFrom(config.claude));
    setCodex(config === null ? emptyRoute(true) : routeFrom(config.codex));
    setGrok(config === null ? emptyRoute(false) : routeFrom(config.grok));
    setError(undefined);
    setSaving(false);
  }, [config, open]);

  const relayProviders = providers.filter((provider) => provider.templateId !== "local-login");

  const saveDisabled =
    saving ||
    name.trim() === "" ||
    (!claude.enabled && !codex.enabled && !grok.enabled) ||
    (claude.enabled && claude.connectionMode === "relay" && claude.providerId === "") ||
    (codex.enabled && codex.connectionMode === "relay" && codex.providerId === "") ||
    (grok.enabled && grok.connectionMode === "relay" && grok.providerId === "");

  const toggleScope = (projectId: string): void => {
    setScope((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const probeModels = async (side: RouteSide): Promise<void> => {
    const settled = await invokeQuery("providers:list-local-models", {
      runtime: side === "claude" ? "claude-code" : side === "grok" ? "grok-build" : "codex",
    });
    const apply = (note: string, models: readonly string[]): void => {
      const patch = (current: RouteDraft): RouteDraft => ({
        ...current,
        probeNote: note,
        probedModels: models,
      });
      if (side === "claude") {
        setClaude(patch);
      } else if (side === "grok") {
        setGrok(patch);
      } else {
        setCodex(patch);
      }
    };
    if (settled.status === "error") {
      apply(settled.error.message, []);
      return;
    }
    if (!settled.data.ok) {
      apply(settled.data.detail, []);
      return;
    }
    apply(
      "",
      settled.data.models.map((item) => item.id),
    );
  };

  const submit = async (): Promise<void> => {
    const claudeRoute = toRoute(claude);
    const codexRoute = toRoute(codex);
    const grokRoute = toRoute(grok);
    const projectIds = config?.isDefault === true ? [] : ([...scope] as ProjectId[]);
    const draft: ProjectConfigDraft = {
      name: name.trim(),
      isDefault: config?.isDefault === true,
      ...(projectIds.length > 0 ? { projectIds } : {}),
      ...(permission !== "" ? { defaultPermission: permission as WorkbenchPermissionLevel } : {}),
      ...(claudeRoute !== undefined ? { claude: claudeRoute } : {}),
      ...(codexRoute !== undefined ? { codex: codexRoute } : {}),
      ...(grokRoute !== undefined ? { grok: grokRoute } : {}),
    };
    setSaving(true);
    setError(undefined);
    const settled =
      config === null
        ? await invokeQuery("configs:create", { draft })
        : await invokeQuery("configs:update", { id: config.id, draft });
    setSaving(false);
    if (settled.status === "error") {
      setError(
        settled.error.code === "config-scope-blocked"
          ? t("settings.configs.scopeBlocked", {
              names: settled.error.reason ?? settled.error.message,
            })
          : settled.error.message,
      );
      return;
    }
    onSaved(draft.name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form" data-testid="config-editor">
        <DialogHeader
          title={
            config === null
              ? t("settings.configs.edit.createTitle")
              : t("settings.configs.edit.title")
          }
        />
        <DialogBody className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          <Field htmlFor="config-name" label={t("settings.configs.field.name")} required>
            <Input
              id="config-name"
              data-testid="config-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            htmlFor="config-default-permission"
            label={t("settings.configs.field.defaultPermission")}
          >
            <select
              id="config-default-permission"
              className={selectClass}
              data-testid="config-default-permission"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              <option value="">{t("settings.configs.field.defaultPermissionUnset")}</option>
              {WORKBENCH_PERMISSION_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`workbench.permission.level.${level}`)}
                </option>
              ))}
            </select>
          </Field>
          {config?.isDefault === true ? (
            <p className="text-sm text-fg-muted" data-testid="config-default-scope-open">
              {t("settings.configs.defaultScopeOpen")}
            </p>
          ) : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-xs font-medium text-fg-muted">
                {t("settings.configs.field.scope")}
              </legend>
              <p className="text-2xs text-fg-muted">{t("settings.configs.field.scopeHint")}</p>
              {projects.length === 0 ? (
                <p className="text-sm text-fg-muted">{t("settings.configs.field.scopeAll")}</p>
              ) : (
                projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`config-scope-${project.id}`}
                      checked={scope.has(project.id)}
                      onChange={() => toggleScope(project.id)}
                    />
                    <span>{project.name}</span>
                  </label>
                ))
              )}
            </fieldset>
          )}
          <RouteFields
            side="claude"
            title={t("settings.configs.field.routeClaude")}
            draft={claude}
            providers={providersForSide("claude", relayProviders)}
            onChange={setClaude}
            onProbe={() => void probeModels("claude")}
          />
          <RouteFields
            side="codex"
            title={t("settings.configs.field.routeCodex")}
            draft={codex}
            providers={providersForSide("codex", relayProviders)}
            onChange={setCodex}
            onProbe={() => void probeModels("codex")}
          />
          <RouteFields
            side="grok"
            title={t("settings.configs.field.routeGrok")}
            draft={grok}
            providers={providersForSide("grok", relayProviders)}
            onChange={setGrok}
            onProbe={() => void probeModels("grok")}
          />
          {!claude.enabled && !codex.enabled && !grok.enabled ? (
            <p className="text-sm text-danger-text">{t("settings.configs.field.needRoute")}</p>
          ) : null}
          {error !== undefined ? (
            <p className="text-sm text-danger-text" role="alert" data-testid="config-editor-error">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="config-save"
            disabled={saveDisabled}
            loading={saving}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RouteFields({
  side,
  title,
  draft,
  providers,
  onChange,
  onProbe,
}: {
  readonly side: RouteSide;
  readonly title: string;
  readonly draft: RouteDraft;
  readonly providers: readonly Provider[];
  readonly onChange: (next: RouteDraft) => void;
  readonly onProbe: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const provider = providers.find((item) => item.id === draft.providerId);
  const modelOptions = [
    ...new Set([...draft.probedModels, ...(provider?.models.map((model) => model.id) ?? [])]),
  ];
  return (
    <fieldset className="flex flex-col gap-2 rounded-sm border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          data-testid={`config-${side}-enabled`}
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        {title}
      </label>
      {draft.enabled ? (
        <>
          <Field htmlFor={`config-${side}-mode`} label={t("settings.configs.field.connection")}>
            <select
              id={`config-${side}-mode`}
              className={selectClass}
              data-testid={`config-${side}-mode`}
              value={draft.connectionMode}
              onChange={(event) =>
                onChange({
                  ...draft,
                  connectionMode: event.target.value === "relay" ? "relay" : "local_cli",
                  providerId: event.target.value === "relay" ? draft.providerId : "",
                })
              }
            >
              <option value="local_cli">{t("settings.configs.field.local")}</option>
              <option value="relay">{t("settings.configs.field.relay")}</option>
            </select>
          </Field>
          {draft.connectionMode === "relay" ? (
            <Field htmlFor={`config-${side}-provider`} label={t("settings.configs.field.provider")}>
              <select
                id={`config-${side}-provider`}
                className={selectClass}
                data-testid={`config-${side}-provider`}
                value={draft.providerId}
                onChange={(event) => onChange({ ...draft, providerId: event.target.value })}
              >
                <option value="">{t("settings.configs.field.provider")}</option>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field
            htmlFor={`config-${side}-model`}
            label={t("settings.configs.field.model")}
            hint={t("settings.configs.field.modelHint")}
          >
            <Input
              id={`config-${side}-model`}
              data-testid={`config-${side}-model`}
              list={`config-${side}-models`}
              value={draft.model}
              placeholder={t("settings.configs.field.modelPlaceholder")}
              onChange={(event) => onChange({ ...draft, model: event.target.value })}
            />
            <datalist id={`config-${side}-models`}>
              {modelOptions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {draft.connectionMode === "local_cli" ? (
              <Button type="button" size="sm" variant="secondary" onClick={onProbe}>
                {t("settings.configs.field.listModels")}
              </Button>
            ) : null}
            {draft.probeNote !== "" ? (
              <p className="text-2xs text-fg-muted">{draft.probeNote}</p>
            ) : null}
          </Field>
          <Field htmlFor={`config-${side}-effort`} label={t("settings.configs.field.effort")}>
            <select
              id={`config-${side}-effort`}
              className={selectClass}
              data-testid={`config-${side}-effort`}
              value={draft.reasoningEffort}
              onChange={(event) => onChange({ ...draft, reasoningEffort: event.target.value })}
            >
              <option value="">{t("settings.configs.field.effortUnset")}</option>
              {REASONING_EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`settings.configs.field.effortLevel.${level}`)}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
    </fieldset>
  );
}
