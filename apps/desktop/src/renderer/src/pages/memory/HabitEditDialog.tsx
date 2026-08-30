import type { HabitConflict } from "@ff-pane/core";
import type { HabitCategory, HabitEntry, HabitSource } from "@ff-pane/shared";
import { HABIT_CATEGORIES } from "@ff-pane/shared";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { invokeQuery } from "../../ipc/query";

/** 新建时的预填种子（来源二提炼用：预填正文/分类，并携带 distilled 溯源）。 */
export interface HabitCreateSeed {
  readonly category?: HabitCategory;
  readonly content?: string;
  /** 来源（缺省 user_manual；来源二传 distilled 溯源）。 */
  readonly source?: HabitSource;
}

/** 新建 / 编辑习惯对话框（T5.1 手写 + T5.4 来源二提炼；§8.2.4 / §8.2.5）。 */
export interface HabitEditDialogProps {
  /** null = 关闭；{entry: null} = 新建（可带 seed 预填）；{entry} = 编辑既有条目。 */
  readonly editing: { readonly entry: HabitEntry | null; readonly seed?: HabitCreateSeed } | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}

const DEFAULT_IMPORTANCE = 50;

export function HabitEditDialog({
  editing,
  onOpenChange,
  onSaved,
}: HabitEditDialogProps): ReactElement {
  const { t } = useTranslation();
  const existing = editing?.entry ?? null;
  const isEdit = existing !== null;

  const [category, setCategory] = useState<HabitCategory>("workflow");
  const [content, setContent] = useState("");
  const [importance, setImportance] = useState(DEFAULT_IMPORTANCE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // 相近条目并排（§8.2.5）：非空即进入"确认冲突"视图，用户选替代 / 都保留 / 返回。
  const [conflicts, setConflicts] = useState<readonly HabitConflict[] | null>(null);

  useEffect(() => {
    if (editing !== null) {
      setCategory(existing?.category ?? editing.seed?.category ?? "workflow");
      setContent(existing?.content ?? editing.seed?.content ?? "");
      setImportance(existing?.importance ?? DEFAULT_IMPORTANCE);
      setError(undefined);
      setSaving(false);
      setConflicts(null);
    }
  }, [editing, existing]);

  // 新建来源：来源二提炼传 distilled 溯源，否则手写 user_manual。
  const createSource: HabitSource = editing?.seed?.source ?? { kind: "user_manual" };
  const isDistill = createSource.kind === "distilled";
  const trimmed = content.trim();

  const doCreate = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    const settled = await invokeQuery("habits:create", {
      draft: {
        category,
        content: trimmed,
        status: "active",
        enabled: true,
        source: createSource,
        importance,
      },
    });
    setSaving(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    onSaved();
    onOpenChange(false);
  };

  const doUpdate = async (target: HabitEntry): Promise<void> => {
    setSaving(true);
    setError(undefined);
    const settled = await invokeQuery("habits:update", {
      entry: { ...target, category, content: trimmed, importance },
    });
    setSaving(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    onSaved();
    onOpenChange(false);
  };

  const onPrimary = async (): Promise<void> => {
    if (trimmed.length === 0) {
      return;
    }
    if (isEdit && existing !== null) {
      await doUpdate(existing);
      return;
    }
    // 新建：入库前查相近条目
    setSaving(true);
    setError(undefined);
    const settled = await invokeQuery("habits:check-conflicts", { category, content: trimmed });
    setSaving(false);
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    if (settled.data.length > 0) {
      setConflicts(settled.data);
      return;
    }
    await doCreate();
  };

  const showConflicts = conflicts !== null && conflicts.length > 0;

  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader
          title={
            isEdit
              ? t("habit.editDialog.editTitle")
              : isDistill
                ? t("habit.editDialog.distillTitle")
                : t("habit.editDialog.createTitle")
          }
          description={
            showConflicts
              ? t("habit.conflict.description")
              : isDistill
                ? t("habit.editDialog.distillDescription")
                : t("habit.editDialog.description")
          }
        />
        {showConflicts ? (
          <>
            <DialogBody className="flex flex-col gap-2 py-3">
              {conflicts.map((c) => (
                <div
                  key={c.entry.id}
                  className="flex items-center gap-2 rounded-md border border-border p-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-2xs text-fg-subtle">
                      {t(`habit.category.${c.entry.category}`)} ·{" "}
                      {t("habit.conflict.similarity", {
                        percent: Math.round(c.similarity * 100),
                      })}
                    </p>
                    <p className="truncate text-sm text-fg-muted select-text">{c.entry.content}</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => void doUpdate(c.entry)}
                  >
                    {t("habit.conflict.replace")}
                  </Button>
                </div>
              ))}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="secondary"
                size="lg"
                disabled={saving}
                onClick={() => setConflicts(null)}
              >
                {t("habit.conflict.back")}
              </Button>
              <Button
                variant="primary"
                size="lg"
                loading={saving}
                disabled={saving}
                onClick={() => void doCreate()}
              >
                {t("habit.conflict.keepBoth")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="flex flex-col gap-3 py-3">
              <Field htmlFor="habit-category" label={t("habit.field.category")} required>
                <select
                  id="habit-category"
                  className="h-7 rounded-md border border-border bg-surface px-2 text-sm text-fg"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as HabitCategory)}
                >
                  {HABIT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`habit.category.${c}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                htmlFor="habit-content"
                label={t("habit.field.content")}
                required
                hint={isDistill ? t("habit.field.distillHint") : t("habit.field.contentHint")}
              >
                <Textarea
                  id="habit-content"
                  rows={4}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </Field>
              <Field htmlFor="habit-importance" label={t("habit.field.importance")}>
                <Input
                  id="habit-importance"
                  type="number"
                  min={0}
                  max={100}
                  value={importance}
                  onChange={(e) => setImportance(Number(e.target.value))}
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
                onClick={() => void onPrimary()}
                disabled={saving || trimmed.length === 0}
                loading={saving}
              >
                {isEdit ? t("common.save") : t("habit.create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
