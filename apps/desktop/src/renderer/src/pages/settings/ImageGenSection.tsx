import {
  IMAGE_GEN_MODES,
  type ImageGenMode,
  isHttpImageGenBaseUrl,
  isImageGenMode,
} from "@ff-pane/shared";
import { RefreshCw } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CliLoginProbeView } from "../../../../shared-ipc/contracts";
import { InlineLoading } from "../../components/states/LoadingState";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { inputVariants } from "../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { SettingRow } from "./SettingRow";

const selectClass = cn(inputVariants({}), "w-56 cursor-pointer");

const LOGIN_STATUS_TONE = {
  logged_in: "success",
  logged_out: "warning",
  cli_missing: "danger",
  unknown: "neutral",
} as const;

/** 把报错里出现的密钥换成占位文字。占位文字随界面语言。 */
function hideKey(text: string, secret: string, mask: string): string {
  const trimmed = secret.trim();
  if (trimmed === "") {
    return text;
  }
  return text.split(trimmed).join(mask);
}

/**
 * Codex 订阅：复用模型来源同一条登录探测，只看状态。
 * 没有登录按钮，也不在这里试出一张图。
 */
function CodexSubscriptionBox(): ReactElement {
  const { t } = useTranslation();
  const [probing, setProbing] = useState(true);
  const [probe, setProbe] = useState<CliLoginProbeView | undefined>(undefined);
  /** 每次检测加一；回来的结果不是最新一次的就丢掉（离开页面也算作作废）。 */
  const probeSeq = useRef(0);

  const runProbe = useCallback(() => {
    probeSeq.current += 1;
    const seq = probeSeq.current;
    setProbing(true);
    void invokeQuery("providers:probe-cli-login", { runtime: "codex" }).then((settled) => {
      if (seq !== probeSeq.current) {
        return;
      }
      setProbing(false);
      if (settled.status === "success") {
        setProbe(settled.data);
        return;
      }
      setProbe({ status: "unknown", detail: settled.error.message, probedWith: "" });
    });
  }, []);

  useEffect(() => {
    runProbe();
    return () => {
      probeSeq.current += 1;
    };
  }, [runProbe]);

  const detail =
    probe === undefined || probing
      ? undefined
      : probe.status === "logged_out" || probe.status === "cli_missing"
        ? t("settings.imageGen.codex.loginHint")
        : probe.detail;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3"
      data-testid="image-gen-codex"
    >
      <div className="flex items-center justify-between gap-2">
        {probing ? (
          <Badge tone="neutral">{t("settings.imageGen.codex.checking")}</Badge>
        ) : probe !== undefined ? (
          <Badge tone={LOGIN_STATUS_TONE[probe.status]}>
            {t(`settings.imageGen.codex.status.${probe.status}`)}
          </Badge>
        ) : (
          <Badge tone="neutral">{t("settings.imageGen.codex.checking")}</Badge>
        )}
        <Button variant="ghost" size="sm" disabled={probing} onClick={runProbe}>
          <RefreshCw aria-hidden size={14} />
          {t("settings.imageGen.codex.refresh")}
        </Button>
      </div>
      {detail !== undefined && detail !== "" ? (
        <span className="font-mono text-2xs text-fg-muted select-text">{detail}</span>
      ) : null}
      <ul className="list-disc space-y-1 pl-4 text-xs text-fg-subtle">
        <li>{t("settings.imageGen.codex.noteLogin")}</li>
        <li>{t("settings.imageGen.codex.noteCost")}</li>
        <li>{t("settings.imageGen.codex.noteStripKey")}</li>
      </ul>
    </div>
  );
}

/**
 * 生图（全局）。下拉立刻保存；中转站的地址、密钥、模型名另有保存按钮。
 * 密钥留空表示不改。测试会出一张图，不写入任何项目，也不代替保存。
 */
export function ImageGenSection(): ReactElement {
  const { t } = useTranslation();
  const { state } = useInvokeQuery("image-gen:get");
  const view = queryData(state);
  const [mode, setMode] = useState<ImageGenMode | undefined>(undefined);
  const [savingMode, setSavingMode] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyTail, setKeyTail] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testLine, setTestLine] = useState<
    { readonly ok: boolean; readonly text: string } | undefined
  >(undefined);

  useEffect(() => {
    if (view === undefined || seeded) {
      return;
    }
    setMode(view.mode);
    setBaseUrl(view.baseUrl);
    setModel(view.model);
    setHasKey(view.hasKey);
    setKeyTail(view.keyTail);
    setSeeded(true);
  }, [view, seeded]);

  const onMode = async (next: ImageGenMode): Promise<void> => {
    const previous = mode;
    setMode(next);
    setSavingMode(true);
    const settled = await invokeQuery("image-gen:set-mode", { mode: next });
    setSavingMode(false);
    if (settled.status === "error") {
      if (previous !== undefined) {
        setMode(previous);
      }
      toast.error(t("settings.imageGen.saveModeError"), { description: settled.error.message });
      return;
    }
    setMode(settled.data.mode);
    toast.success(t(`settings.imageGen.switched.${settled.data.mode}`));
  };

  const baseUrlError =
    baseUrl.trim() === ""
      ? t("settings.imageGen.relay.missingBaseUrl")
      : !isHttpImageGenBaseUrl(baseUrl.trim())
        ? t("settings.imageGen.relay.invalidBaseUrl")
        : undefined;
  const modelError = model.trim() === "" ? t("settings.imageGen.relay.missingModel") : undefined;
  const keyError =
    apiKey.trim() === "" && !hasKey ? t("settings.imageGen.relay.missingApiKey") : undefined;
  const canSave = baseUrlError === undefined && modelError === undefined && keyError === undefined;

  const onSave = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    const settled = await invokeQuery("image-gen:save-relay", {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
    });
    setSaving(false);
    if (settled.status === "error") {
      toast.error(t("settings.imageGen.relay.saveError"), {
        description: hideKey(settled.error.message, apiKey, t("settings.imageGen.relay.keyMasked")),
      });
      return;
    }
    setApiKey("");
    setBaseUrl(settled.data.baseUrl);
    setModel(settled.data.model);
    setHasKey(settled.data.hasKey);
    setKeyTail(settled.data.keyTail);
    toast.success(t("settings.imageGen.relay.saved"));
  };

  const onTest = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setTesting(true);
    setTestLine(undefined);
    const settled = await invokeQuery("image-gen:test-relay", {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
    });
    setTesting(false);
    if (settled.status === "error") {
      const text = hideKey(settled.error.message, apiKey, t("settings.imageGen.relay.keyMasked"));
      setTestLine({ ok: false, text });
      toast.error(text);
      return;
    }
    if (!settled.data.ok) {
      const reason = hideKey(settled.data.reason, apiKey, t("settings.imageGen.relay.keyMasked"));
      const text = reason.trim() === "" ? t("settings.imageGen.relay.testFailed") : reason;
      setTestLine({ ok: false, text });
      toast.error(text);
      return;
    }
    const text = t("settings.imageGen.relay.testOk", { ms: settled.data.elapsedMs });
    setTestLine({ ok: true, text });
    toast.success(text);
  };

  const keyHint = hasKey
    ? keyTail !== ""
      ? t("settings.imageGen.relay.apiKeySaved", { tail: keyTail })
      : t("settings.imageGen.relay.apiKeySavedNoTail")
    : t("settings.imageGen.relay.apiKeyHint");

  return (
    <section className="flex flex-col gap-3" data-testid="image-gen-section">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-fg">{t("settings.imageGen.title")}</h2>
        <p className="text-xs text-fg-subtle">{t("settings.imageGen.introAll")}</p>
        <p className="text-xs text-fg-subtle">{t("settings.imageGen.introChat")}</p>
        <SettingRow htmlFor="setting-image-gen-mode" label={t("settings.imageGen.modeLabel")}>
          {state.status === "error" ? (
            <span className="text-xs text-danger-text">{t("settings.imageGen.loadError")}</span>
          ) : mode === undefined ? (
            <InlineLoading />
          ) : (
            <select
              id="setting-image-gen-mode"
              className={selectClass}
              value={mode}
              disabled={savingMode || saving || testing}
              onChange={(event) => {
                const next = event.target.value;
                if (isImageGenMode(next)) {
                  void onMode(next);
                }
              }}
            >
              {IMAGE_GEN_MODES.map((value) => (
                <option key={value} value={value}>
                  {t(`settings.imageGen.mode.${value}`)}
                </option>
              ))}
            </select>
          )}
        </SettingRow>
        {mode === "off" ? (
          <p className="text-xs text-fg-subtle">{t("settings.imageGen.offHint")}</p>
        ) : null}
      </div>

      {mode === "codex_subscription" ? <CodexSubscriptionBox /> : null}

      {mode === "relay" ? (
        <div className="flex flex-col gap-3">
          <Field
            htmlFor="image-gen-base-url"
            label={t("settings.imageGen.relay.baseUrl")}
            required
            {...(baseUrlError !== undefined ? { error: baseUrlError } : {})}
          >
            <Input
              id="image-gen-base-url"
              value={baseUrl}
              placeholder={t("settings.imageGen.relay.baseUrlPlaceholder")}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              invalid={baseUrlError !== undefined}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field
            htmlFor="image-gen-api-key"
            label={t("settings.imageGen.relay.apiKey")}
            required={!hasKey}
            {...(keyError !== undefined ? { error: keyError } : { hint: keyHint })}
          >
            <Input
              id="image-gen-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              invalid={keyError !== undefined}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <Field
            htmlFor="image-gen-model"
            label={t("settings.imageGen.relay.model")}
            required
            {...(modelError !== undefined ? { error: modelError } : {})}
          >
            <Input
              id="image-gen-model"
              value={model}
              placeholder={t("settings.imageGen.relay.modelPlaceholder")}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              invalid={modelError !== undefined}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={testing}
              disabled={saving || savingMode || !canSave}
              onClick={() => void onTest()}
            >
              {t("settings.imageGen.relay.test")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!canSave || testing || savingMode}
              onClick={() => void onSave()}
            >
              {t("settings.imageGen.relay.save")}
            </Button>
          </div>
          {testLine !== undefined ? (
            <p className={testLine.ok ? "text-xs text-fg-subtle" : "text-xs text-danger-text"}>
              {testLine.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
