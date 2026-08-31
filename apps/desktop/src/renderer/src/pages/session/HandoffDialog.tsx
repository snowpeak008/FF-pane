import type { AgentProfile, ProfileId } from "@ff-pane/shared";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { HandoffPreview } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Field, Textarea } from "../../components/ui/Input";
import { inputVariants } from "../../components/ui/input.variants";
import { invokeQuery, queryData } from "../../ipc/query";
import { useInvokeQuery } from "../../ipc/useInvokeQuery";
import { cn } from "../../lib/cn";
import { startSessionTurn } from "../../lib/session-run";
import { useSessionStore } from "../../stores/session";
import { defaultHandoffTargetId, deriveHandoffTargets } from "./handoff-view";

export interface HandoffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectRoot: string;
  /** 当前承载会话的 Profile（用于把自己排除出迁移目标）。 */
  readonly currentProfile: AgentProfile | null;
}

/**
 * 跨 Agent 迁移（T7.1，设计文档 §10.4）：预览交接包 → 可编辑 → 确认后注入新 Agent 会话。
 *
 * **预览框里的文本就是要注入的文本**——不是"参考"、不是"摘要"。§10.4 写的是"生成后展示给
 * 用户预览（可编辑），确认后注入"，若确认时再从结构体渲染一遍，用户改的每个字都白改了。
 * 故这里把编辑后的字符串原样交给 `session:start` 的 handoffText。
 *
 * 迁移**开的是新会话**而不是续接：新 Agent 没有旧 Agent 的会话文件，续接在物理上不成立。
 * 主进程据 handoffText 强制开新会话并把会话类型标成 handoff，状态条会如实显示"跨 Agent 迁移"
 * （§2「不伪装成会话恢复」）。
 */
export function HandoffDialog({
  open,
  onOpenChange,
  projectRoot,
  currentProfile,
}: HandoffDialogProps): ReactElement {
  const { t } = useTranslation();
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const { state: profilesState } = useInvokeQuery("profiles:list");
  const profiles = useMemo(() => queryData(profilesState) ?? [], [profilesState]);
  const targets = useMemo(
    () => deriveHandoffTargets(profiles, currentProfile),
    [profiles, currentProfile],
  );

  const [targetId, setTargetId] = useState<ProfileId | "">("");
  const [preview, setPreview] = useState<HandoffPreview | undefined>(undefined);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // 每次打开都重新生成：交接包是"此刻的项目现状"的快照，缓存住上一次的等于交接过期事实。
  useEffect(() => {
    if (!open) {
      return;
    }
    setError(undefined);
    setPreview(undefined);
    setText("");
    setLoading(true);
    let cancelled = false;
    void invokeQuery("handoff:generate", { projectRoot }).then((settled) => {
      if (cancelled) {
        return;
      }
      setLoading(false);
      if (settled.status === "error") {
        setError(settled.error.message);
        return;
      }
      setPreview(settled.data);
      setText(settled.data.text);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectRoot]);

  // 目标 Profile 的缺省选中在候选列表就绪后落定；用户改过就不再覆盖。
  useEffect(() => {
    if (open && targetId === "") {
      setTargetId(defaultHandoffTargetId(targets) ?? "");
    }
  }, [open, targets, targetId]);

  const confirm = async (): Promise<void> => {
    if (targetId === "") {
      return;
    }
    setSending(true);
    const { ack } = await startSessionTurn({
      projectRoot,
      profileId: targetId,
      input: { kind: "planner-message", text: t("session.handoff.kickoff") },
      handoffText: text,
    });
    setSending(false);
    if (ack === null || !ack.accepted) {
      // 未受理的原因已由 startSessionTurn 落进 store 并显示在消息流；这里不重复报错文案
      onOpenChange(false);
      return;
    }
    // 迁移后的当前会话换成新会话——否则下一次发言会带着旧会话 ID 去续接旧 Agent
    setActiveSessionId(ack.sessionId);
    onOpenChange(false);
    toast.success(t("session.handoff.migrated"));
  };

  const selectClass = cn(inputVariants({}), "cursor-pointer");
  const summary =
    preview === undefined
      ? undefined
      : t("session.handoff.summary", {
          plan:
            preview.planVersion === undefined
              ? t("session.handoff.noPlan")
              : t("session.handoff.planVersion", { version: preview.planVersion }),
          tasks: preview.taskCount,
          decisions: preview.decisionCount,
          rules: preview.ruleCount,
          lessons: preview.lessonCount,
          issues: preview.openIssueCount,
        });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="diff" className="flex h-[85vh] flex-col gap-3">
        <DialogHeader
          title={t("session.handoff.title")}
          description={t("session.handoff.description")}
        />
        {/* 主体不自己滚：唯一该滚的是交接包正文框（它随对话框高度伸缩）。
            否则正文框与主体各出一根滚动条，用户拖哪根都只滚一半。 */}
        <DialogBody className="flex min-h-0 flex-col gap-3 overflow-hidden py-3">
          <Field
            htmlFor="handoff-target"
            label={t("session.handoff.target")}
            required
            hint={t("session.handoff.targetHint")}
          >
            <select
              id="handoff-target"
              className={selectClass}
              value={targetId}
              onChange={(e) => setTargetId(e.target.value as ProfileId)}
            >
              <option value="">{t("session.handoff.targetPlaceholder")}</option>
              {targets.map(({ profile, runtimeChanged }) => (
                <option key={profile.id} value={profile.id}>
                  {runtimeChanged
                    ? t("session.handoff.targetOptionSwitch", {
                        name: profile.name,
                        runtime: profile.runtime,
                      })
                    : t("session.handoff.targetOptionSame", {
                        name: profile.name,
                        runtime: profile.runtime,
                      })}
                </option>
              ))}
            </select>
          </Field>
          {summary !== undefined ? (
            <p className="text-xs text-muted-foreground select-text">{summary}</p>
          ) : null}
          <Field
            className="min-h-0 flex-1"
            htmlFor="handoff-text"
            label={t("session.handoff.previewLabel")}
            hint={t("session.handoff.previewHint")}
          >
            <Textarea
              id="handoff-text"
              className="min-h-0 flex-1 resize-none font-mono text-xs"
              value={text}
              disabled={loading}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          {error !== undefined ? (
            <p className="font-mono text-xs text-danger-text select-text" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void confirm()}
            disabled={loading || sending || targetId === "" || text.trim().length === 0}
            loading={sending}
          >
            {t("session.handoff.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
