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
  isModelAllowedBySource,
  providerChatModelIds,
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

type RouteSide = "claude" | "codex" | "grok" | "deepseek" | "cursor" | "gemini";

function providersForSide(side: RouteSide, providers: readonly Provider[]): readonly Provider[] {
  if (side === "cursor" || side === "gemini") {
    // Cursor、Gemini 目前只有本机登录，没有来源可选
    return [];
  }
  const cli =
    side === "claude"
      ? "claude-code"
      : side === "codex"
        ? "codex"
        : side === "grok"
          ? "grok"
          : "deepseek";
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

function toRoute(draft: RouteDraft, relayOnly = false): ProjectConfigRoute | undefined {
  if (!draft.enabled) {
    return undefined;
  }
  const model = draft.model.trim();
  const effort = draft.reasoningEffort.trim();
  const extras = {
    ...(model !== "" ? { model } : {}),
    ...(effort !== "" ? { reasoningEffort: effort as ReasoningEffortLevel } : {}),
  };
  if (relayOnly || draft.connectionMode === "relay") {
    return {
      connectionMode: "relay",
      providerId: draft.providerId as ProviderId,
      ...extras,
    };
  }
  // 本机登录可以选一个「本机已登录」来源，决定允许用哪些模型；不选 = 不限制。
  const sourceId = draft.providerId.trim();
  return {
    connectionMode: "local_cli",
    ...(sourceId !== "" ? { providerId: sourceId as ProviderId } : {}),
    ...extras,
  };
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
  const [deepseek, setDeepseek] = useState<RouteDraft>(emptyRoute(false));
  const [cursor, setCursor] = useState<RouteDraft>(emptyRoute(false));
  const [gemini, setGemini] = useState<RouteDraft>(emptyRoute(false));
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
    setDeepseek(
      config === null
        ? emptyRoute(false)
        : { ...routeFrom(config.deepseek), connectionMode: "relay" },
    );
    setCursor(
      config === null
        ? emptyRoute(false)
        : { ...routeFrom(config.cursor), connectionMode: "local_cli" },
    );
    setGemini(
      config === null
        ? emptyRoute(false)
        : { ...routeFrom(config.gemini), connectionMode: "local_cli" },
    );
    setError(undefined);
    setSaving(false);
  }, [config, open]);

  const relayProviders = providers.filter((provider) => provider.templateId !== "local-login");
  // 本机登录这一路可选的来源：只列「本机已登录」模板、没停用的。
  const localSources = providers.filter(
    (provider) => provider.templateId === "local-login" && provider.enabled !== false,
  );

  /** 选了来源、来源里有对话模型、而填的模型不在里面：返回提示，否则 undefined。 */
  const modelProblem = (draft: RouteDraft, title: string): string | undefined => {
    if (!draft.enabled || draft.connectionMode !== "local_cli" || draft.providerId === "") {
      return undefined;
    }
    const source = localSources.find((item) => item.id === draft.providerId);
    if (source === undefined) {
      return undefined;
    }
    const allowed = providerChatModelIds(source);
    if (isModelAllowedBySource(allowed, draft.model)) {
      return undefined;
    }
    return t("settings.configs.field.modelNotAllowed", {
      title,
      model: draft.model.trim(),
      source: source.name,
    });
  };

  const saveDisabled =
    saving ||
    name.trim() === "" ||
    (!claude.enabled &&
      !codex.enabled &&
      !grok.enabled &&
      !deepseek.enabled &&
      !cursor.enabled &&
      !gemini.enabled) ||
    (claude.enabled && claude.connectionMode === "relay" && claude.providerId === "") ||
    (codex.enabled && codex.connectionMode === "relay" && codex.providerId === "") ||
    (grok.enabled && grok.connectionMode === "relay" && grok.providerId === "") ||
    (deepseek.enabled && deepseek.providerId === "");

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

  const patchSide = (
    side: RouteSide,
    patch: Pick<RouteDraft, "probeNote" | "probedModels">,
  ): void => {
    const update = (current: RouteDraft): RouteDraft => ({ ...current, ...patch });
    if (side === "claude") {
      setClaude(update);
    } else if (side === "grok") {
      setGrok(update);
    } else if (side === "cursor") {
      setCursor(update);
    } else if (side === "gemini") {
      setGemini(update);
    } else if (side === "codex") {
      setCodex(update);
    }
  };

  const probeModels = async (side: RouteSide): Promise<void> => {
    if (side === "deepseek") {
      return;
    }
    // 读模型要跑一次 CLI（Cursor 约 3 秒），先说一声在读，不然看着像没反应
    patchSide(side, { probeNote: t("settings.configs.field.modelsProbing"), probedModels: [] });
    const settled = await invokeQuery("providers:list-local-models", {
      runtime:
        side === "claude"
          ? "claude-code"
          : side === "grok"
            ? "grok-build"
            : side === "cursor"
              ? "cursor"
              : side === "gemini"
                ? "agy"
                : "codex",
    });
    const apply = (note: string, models: readonly string[]): void => {
      patchSide(side, { probeNote: note, probedModels: models });
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
      t("settings.configs.field.modelsProbed", { count: settled.data.models.length }),
      settled.data.models.map((item) => item.id),
    );
  };

  const submit = async (): Promise<void> => {
    const problem =
      modelProblem(claude, t("settings.configs.field.routeClaude")) ??
      modelProblem(codex, t("settings.configs.field.routeCodex")) ??
      modelProblem(grok, t("settings.configs.field.routeGrok")) ??
      modelProblem(cursor, t("settings.configs.field.routeCursor")) ??
      modelProblem(gemini, t("settings.configs.field.routeGemini"));
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    const claudeRoute = toRoute(claude);
    const codexRoute = toRoute(codex);
    const grokRoute = toRoute(grok);
    const deepseekRoute = toRoute(deepseek, true);
    const cursorRoute = toRoute({ ...cursor, connectionMode: "local_cli", reasoningEffort: "" });
    const geminiRoute = toRoute({ ...gemini, connectionMode: "local_cli", reasoningEffort: "" });
    const projectIds = config?.isDefault === true ? [] : ([...scope] as ProjectId[]);
    const draft: ProjectConfigDraft = {
      name: name.trim(),
      isDefault: config?.isDefault === true,
      ...(projectIds.length > 0 ? { projectIds } : {}),
      ...(permission !== "" ? { defaultPermission: permission as WorkbenchPermissionLevel } : {}),
      ...(claudeRoute !== undefined ? { claude: claudeRoute } : {}),
      ...(codexRoute !== undefined ? { codex: codexRoute } : {}),
      ...(grokRoute !== undefined ? { grok: grokRoute } : {}),
      ...(deepseekRoute !== undefined ? { deepseek: deepseekRoute } : {}),
      ...(cursorRoute !== undefined ? { cursor: cursorRoute } : {}),
      ...(geminiRoute !== undefined ? { gemini: geminiRoute } : {}),
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
            localSources={localSources}
            title={t("settings.configs.field.routeClaude")}
            draft={claude}
            providers={providersForSide("claude", relayProviders)}
            onChange={setClaude}
            onProbe={() => void probeModels("claude")}
          />
          <RouteFields
            side="codex"
            localSources={localSources}
            title={t("settings.configs.field.routeCodex")}
            draft={codex}
            providers={providersForSide("codex", relayProviders)}
            onChange={setCodex}
            onProbe={() => void probeModels("codex")}
          />
          <RouteFields
            side="grok"
            localSources={localSources}
            title={t("settings.configs.field.routeGrok")}
            draft={grok}
            providers={providersForSide("grok", relayProviders)}
            onChange={setGrok}
            onProbe={() => void probeModels("grok")}
          />
          <RouteFields
            side="deepseek"
            localSources={localSources}
            title={t("settings.configs.field.routeDeepseek")}
            draft={deepseek}
            providers={providersForSide("deepseek", relayProviders)}
            relayOnly
            onChange={setDeepseek}
            onProbe={() => undefined}
          />
          <RouteFields
            side="cursor"
            localSources={localSources}
            title={t("settings.configs.field.routeCursor")}
            draft={cursor}
            providers={[]}
            localOnly
            onChange={setCursor}
            onProbe={() => void probeModels("cursor")}
          />
          <RouteFields
            side="gemini"
            localSources={localSources}
            title={t("settings.configs.field.routeGemini")}
            draft={gemini}
            providers={[]}
            relayLater
            onChange={setGemini}
            onProbe={() => void probeModels("gemini")}
          />
          {!claude.enabled &&
          !codex.enabled &&
          !grok.enabled &&
          !deepseek.enabled &&
          !cursor.enabled &&
          !gemini.enabled ? (
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
  localSources,
  relayOnly = false,
  localOnly = false,
  relayLater = false,
  onChange,
  onProbe,
}: {
  readonly side: RouteSide;
  readonly title: string;
  readonly draft: RouteDraft;
  readonly providers: readonly Provider[];
  /** 本机登录这一路可选的来源（「本机已登录」模板）。 */
  readonly localSources: readonly Provider[];
  readonly relayOnly?: boolean;
  /** 只有本机登录（Cursor）：不显示连法和思考强度。 */
  readonly localOnly?: boolean;
  /** 中转还没做（Gemini 第二期）：连法里列出但不可选。 */
  readonly relayLater?: boolean;
  readonly onChange: (next: RouteDraft) => void;
  readonly onProbe: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isLocal = !relayOnly && draft.connectionMode === "local_cli";
  const provider = providers.find((item) => item.id === draft.providerId);
  const source = isLocal ? localSources.find((item) => item.id === draft.providerId) : undefined;
  // 选了本机登录来源且来源里有对话模型：模型只能从里面选。
  const sourceModels = source === undefined ? [] : providerChatModelIds(source);
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
          onChange={(event) =>
            onChange({
              ...draft,
              enabled: event.target.checked,
              ...(relayOnly ? { connectionMode: "relay" as const } : {}),
            })
          }
        />
        {title}
      </label>
      {draft.enabled ? (
        <>
          {relayOnly ? (
            <p className="text-2xs text-fg-muted" data-testid={`config-${side}-note`}>
              {t("settings.configs.field.deepseekNote")}
            </p>
          ) : null}
          {localOnly ? (
            <p className="text-2xs text-fg-muted" data-testid={`config-${side}-note`}>
              {t("settings.configs.field.cursorNote")}
            </p>
          ) : null}
          {side === "gemini" ? (
            <p className="text-2xs text-fg-muted" data-testid={`config-${side}-note`}>
              {t("settings.configs.field.geminiNote")}
            </p>
          ) : null}
          {relayOnly || localOnly ? null : (
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
                    providerId: "",
                  })
                }
              >
                <option value="local_cli">{t("settings.configs.field.local")}</option>
                <option value="relay" disabled={relayLater}>
                  {relayLater
                    ? t("settings.configs.field.relayLaterOption")
                    : t("settings.configs.field.relay")}
                </option>
              </select>
            </Field>
          )}
          {relayOnly || draft.connectionMode === "relay" ? (
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
          {isLocal ? (
            <Field
              htmlFor={`config-${side}-source`}
              label={t("settings.configs.field.source")}
              hint={
                localSources.length === 0 && draft.providerId === ""
                  ? t("settings.configs.field.sourceEmpty")
                  : t("settings.configs.field.sourceHint")
              }
            >
              <select
                id={`config-${side}-source`}
                className={selectClass}
                data-testid={`config-${side}-source`}
                value={draft.providerId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  const next = localSources.find((item) => item.id === nextId);
                  const allowedNext = next === undefined ? [] : providerChatModelIds(next);
                  onChange({
                    ...draft,
                    providerId: nextId,
                    // 换了来源，原来填的模型不在新来源里就清掉，免得带着一个不允许的模型保存。
                    model: isModelAllowedBySource(allowedNext, draft.model) ? draft.model : "",
                  });
                }}
              >
                <option value="">{t("settings.configs.field.sourceNone")}</option>
                {localSources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
                {draft.providerId !== "" && source === undefined ? (
                  <option value={draft.providerId}>{t("settings.configs.field.sourceGone")}</option>
                ) : null}
              </select>
            </Field>
          ) : null}
          <Field
            htmlFor={`config-${side}-model`}
            label={t("settings.configs.field.model")}
            hint={
              side === "deepseek"
                ? t("settings.configs.field.modelHintDeepseek")
                : side === "cursor"
                  ? t("settings.configs.field.modelHintCursor")
                  : side === "gemini"
                    ? t("settings.configs.field.modelHintGemini")
                    : t("settings.configs.field.modelHint")
            }
          >
            {sourceModels.length > 0 ? (
              <select
                id={`config-${side}-model`}
                className={selectClass}
                data-testid={`config-${side}-model-allowed`}
                value={draft.model}
                onChange={(event) => onChange({ ...draft, model: event.target.value })}
              >
                <option value="">{t("settings.configs.field.modelFromSource")}</option>
                {sourceModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
                {draft.model !== "" && !sourceModels.includes(draft.model) ? (
                  <option value={draft.model}>
                    {t("settings.configs.field.modelOutsideSource", { model: draft.model })}
                  </option>
                ) : null}
              </select>
            ) : (
              <Input
                id={`config-${side}-model`}
                data-testid={`config-${side}-model`}
                list={`config-${side}-models`}
                value={draft.model}
                placeholder={
                  side === "deepseek"
                    ? t("settings.configs.field.modelPlaceholderDeepseek")
                    : t("settings.configs.field.modelPlaceholder")
                }
                onChange={(event) => onChange({ ...draft, model: event.target.value })}
              />
            )}
            <datalist id={`config-${side}-models`}>
              {modelOptions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {draft.connectionMode === "local_cli" && sourceModels.length === 0 ? (
              <Button type="button" size="sm" variant="secondary" onClick={onProbe}>
                {t("settings.configs.field.listModels")}
              </Button>
            ) : null}
            {draft.probeNote !== "" ? (
              <p className="text-2xs text-fg-muted" data-testid={`config-${side}-probe-note`}>
                {draft.probeNote}
              </p>
            ) : null}
            {draft.probedModels.length > 0 && sourceModels.length === 0 ? (
              // 读到的模型直接给个下拉，不用先点进输入框才看得到
              <select
                aria-label={t("settings.configs.field.pickProbedModel")}
                className={selectClass}
                data-testid={`config-${side}-model-pick`}
                value={draft.probedModels.includes(draft.model) ? draft.model : ""}
                onChange={(event) => onChange({ ...draft, model: event.target.value })}
              >
                <option value="">{t("settings.configs.field.pickProbedModel")}</option>
                {draft.probedModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : null}
          </Field>
          {localOnly || side === "gemini" ? null : (
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
          )}
        </>
      ) : null}
    </fieldset>
  );
}
