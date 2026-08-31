import type { KnowledgeToolSettings } from "@ff-pane/shared";
import { DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME } from "@ff-pane/shared";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ErrorState } from "../../components/states/ErrorState";
import { LoadingState } from "../../components/states/LoadingState";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { SettingRow } from "./SettingRow";

/**
 * 把「一行一个 KEY=VALUE」文本解析成环境变量表。
 * 只按**第一个**等号切分：值里含等号（连接串、base64）是常态，按最后一个或全部切都会切坏。
 */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const at = trimmed.indexOf("=");
    if (at <= 0) {
      continue;
    }
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return env;
}

/** 环境变量表 → 一行一个 KEY=VALUE（回显用，键序稳定便于比对）。 */
export function formatEnvLines(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * 知识库检索工具的 MCP 接入设置区（T6.6 / 设计文档 §8.3.5 路径二）。
 *
 * **传输恒为 stdio，因此这里没有"地址/端口"可填**：服务端是被 CLI 直接拉起的子进程，
 * 通信走进程间管道，不监听端口、不发一个字节网络流量。所以它与用户的 VPN、系统代理、
 * 防火墙完全无关，也不可能被别的机器连上。stdio 语境下"可配置的地址"就是下面这三项
 * ——用哪个可执行文件、给什么参数、带什么环境变量。
 *
 * 全部留空即用内置服务端，这也是绝大多数用户永远不需要动这一区的原因。
 */
export function KnowledgeToolSection(): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useInvokeQuery("config:get");
  const saved = queryData(state)?.knowledgeTool;

  const [draft, setDraft] = useState<KnowledgeToolSettings | undefined>(undefined);
  const [envText, setEnvText] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const value = draft ?? saved ?? {};
  const env = envText ?? formatEnvLines(saved?.env);
  const dirty = draft !== undefined || envText !== undefined;

  /**
   * 改一个字段。清空输入 = **删掉这个键**而不是把它设成 undefined：
   * exactOptionalPropertyTypes 下二者是不同的类型，且落盘时前者才是"回到内置默认"。
   */
  const patch = (key: keyof KnowledgeToolSettings, next: string | readonly string[]): void => {
    const merged: Record<string, unknown> = { ...value };
    if (next === undefined || next.length === 0) {
      delete merged[key];
    } else {
      merged[key] = next;
    }
    setDraft(merged as KnowledgeToolSettings);
  };

  const save = async (): Promise<void> => {
    const parsedEnv = parseEnvLines(env);
    // 全部字段为空 → 整个 knowledgeTool 落回 undefined，config.json 里不留一个空壳对象
    const next: KnowledgeToolSettings = {
      ...(value.command !== undefined ? { command: value.command } : {}),
      ...(value.args !== undefined && value.args.length > 0 ? { args: value.args } : {}),
      ...(Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
      ...(value.serverName !== undefined ? { serverName: value.serverName } : {}),
    };
    setSaving(true);
    const settled = await invokeQuery("config:update", {
      ...(Object.keys(next).length > 0 ? { knowledgeTool: next } : {}),
    });
    setSaving(false);
    if (settled.status === "error") {
      toast.error(t("settings.knowledgeTool.error"), { description: settled.error.message });
      return;
    }
    setDraft(undefined);
    setEnvText(undefined);
    refetch();
    toast.success(t("settings.knowledgeTool.saved"));
  };

  const reset = (): void => {
    setDraft(undefined);
    setEnvText(undefined);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-fg">{t("settings.knowledgeTool.title")}</h2>
        <p className="text-xs text-fg-muted">{t("settings.knowledgeTool.subtitle")}</p>
        <p className="text-xs text-fg-subtle">{t("settings.knowledgeTool.transportNote")}</p>
      </div>

      {state.status === "loading" ? <LoadingState variant="detail" rows={3} /> : null}
      {state.status === "error" ? (
        <ErrorState error={state.error} onRetry={refetch} className="min-h-0" />
      ) : null}

      {state.status === "success" ? (
        <>
          <SettingRow
            label={t("settings.knowledgeTool.serverName")}
            description={t("settings.knowledgeTool.serverNameHint", {
              name: DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME,
            })}
            htmlFor="kt-server-name"
          >
            <Input
              id="kt-server-name"
              className="w-64"
              value={value.serverName ?? ""}
              placeholder={DEFAULT_KNOWLEDGE_TOOL_SERVER_NAME}
              onChange={(e) => patch("serverName", e.target.value.trim())}
            />
          </SettingRow>

          <SettingRow
            label={t("settings.knowledgeTool.command")}
            description={t("settings.knowledgeTool.commandHint")}
            htmlFor="kt-command"
          >
            <Input
              id="kt-command"
              className="w-64"
              value={value.command ?? ""}
              placeholder={t("settings.knowledgeTool.builtIn")}
              onChange={(e) => patch("command", e.target.value.trim())}
            />
          </SettingRow>

          <SettingRow
            label={t("settings.knowledgeTool.args")}
            description={t("settings.knowledgeTool.argsHint")}
            htmlFor="kt-args"
          >
            <Input
              id="kt-args"
              className="w-64"
              value={(value.args ?? []).join(" ")}
              disabled={value.command === undefined}
              onChange={(e) => {
                patch(
                  "args",
                  e.target.value.split(/\s+/).filter((part) => part.length > 0),
                );
              }}
            />
          </SettingRow>

          <div className="flex flex-col gap-1 py-2">
            <label className="text-sm text-fg" htmlFor="kt-env">
              {t("settings.knowledgeTool.env")}
            </label>
            <span className="text-xs text-fg-subtle">{t("settings.knowledgeTool.envHint")}</span>
            <textarea
              id="kt-env"
              rows={3}
              spellCheck={false}
              value={env}
              onChange={(e) => setEnvText(e.target.value)}
              className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={() => void save()}
              disabled={!dirty || saving}
              loading={saving}
            >
              {t("common.save")}
            </Button>
            {dirty ? (
              <Button variant="ghost" size="md" onClick={reset}>
                {t("common.cancel")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
