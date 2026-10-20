/**
 * 待你拍板：窗口经 ffpane_request_decision 推来的事，连同选项列在工作台顶部。
 * 点一个选项或写下自己的决定，结果作为「来自用户」的消息发回给提问的窗口。
 */

import type { ProjectId } from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { WorkbenchDecision } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { SafeMarkdownView } from "./SafeMarkdownView";

/** 拍板附带的计划：直接读出来放在卡片里，不用另外打开文件。 */
function DecisionPlan({
  projectId,
  relativePath,
}: {
  readonly projectId: ProjectId;
  readonly relativePath: string;
}): ReactElement | null {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invokeQuery("workbench:read-brief", { projectId, relativePath }).then((settled) => {
      if (!cancelled && settled.status === "success") {
        setContent(settled.data.content);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, relativePath]);
  if (content === null) {
    return null;
  }
  return (
    <div
      className="max-h-80 overflow-auto rounded-sm border border-border bg-surface-sunken p-2 text-xs"
      data-testid="workbench-decision-plan"
    >
      <SafeMarkdownView source={content} />
    </div>
  );
}

export function WorkbenchDecisions({
  projectId,
}: {
  readonly projectId: ProjectId;
}): ReactElement | null {
  const { t } = useTranslation();
  const [decisions, setDecisions] = useState<readonly WorkbenchDecision[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invokeQuery("workbench:list-decisions", { projectId }).then((settled) => {
      if (!cancelled && settled.status === "success") {
        setDecisions(settled.data.decisions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useSubscription("workbench:decision-requested", (decision) => {
    if (decision.projectId !== projectId) {
      return;
    }
    setDecisions((prev) => [...prev.filter((item) => item.id !== decision.id), decision]);
    toast.message(t("workbench.decision.arrived", { title: decision.windowTitle }));
  });

  useSubscription("workbench:decision-resolved", (payload) => {
    if (payload.projectId !== projectId) {
      return;
    }
    setDecisions((prev) => prev.filter((item) => item.id !== payload.id));
  });

  const answer = (id: string, choice: string): void => {
    const trimmed = choice.trim();
    if (trimmed === "") {
      return;
    }
    setSending(id);
    void invokeQuery("workbench:answer-decision", { id, choice: trimmed }).then((settled) => {
      setSending(null);
      if (settled.status === "error") {
        toast.error(settled.error.message);
        return;
      }
      setDecisions((prev) => prev.filter((item) => item.id !== id));
      toast.success(t("workbench.decision.sent"));
    });
  };

  const openBrief = (relativePath: string): void => {
    void invokeQuery("workbench:open-ffpane", { projectId, relativePath }).then((settled) => {
      if (settled.status === "error") {
        toast.error(settled.error.message);
      }
    });
  };

  if (decisions.length === 0) {
    return null;
  }
  return (
    <section
      className="flex shrink-0 flex-col gap-2 border-b border-border bg-warning-surface px-2 py-2"
      data-testid="workbench-decisions"
    >
      <div className="text-xs font-medium text-warning-text">
        {t("workbench.decision.title", { count: decisions.length })}
      </div>
      {decisions.map((decision) => (
        <div
          key={decision.id}
          className="flex flex-col gap-1 rounded-sm border border-border bg-surface p-2"
          data-testid="workbench-decision"
        >
          <div className="text-2xs text-fg-muted">
            {t("workbench.decision.from", { title: decision.windowTitle })}
          </div>
          <div className="whitespace-pre-wrap text-xs text-fg">{decision.question}</div>
          {decision.briefPath !== undefined ? (
            <DecisionPlan projectId={projectId} relativePath={decision.briefPath} />
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            {decision.options.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant="secondary"
                disabled={sending === decision.id}
                onClick={() => answer(decision.id, option)}
              >
                {option}
              </Button>
            ))}
            {decision.briefPath !== undefined ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => openBrief(decision.briefPath ?? "")}
              >
                {t("workbench.decision.openBrief")}
              </Button>
            ) : null}
          </div>
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              answer(decision.id, drafts[decision.id] ?? "");
            }}
          >
            <Input
              value={drafts[decision.id] ?? ""}
              placeholder={t("workbench.decision.otherPlaceholder")}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [decision.id]: event.target.value }))
              }
            />
            <Button
              type="submit"
              size="sm"
              disabled={sending === decision.id || (drafts[decision.id] ?? "").trim() === ""}
            >
              {t("workbench.decision.submit")}
            </Button>
          </form>
        </div>
      ))}
    </section>
  );
}
