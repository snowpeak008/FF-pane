/**
 * 导入 / 重建的生命周期 hook（T6.5）。
 *
 * 一次导入是「一个长 invoke + 一串进度事件」：invoke 的应答就是最终报告，
 * 中途的推进走 `knowledge:import-progress`。之所以不做成「立刻 ack + 全靠事件」
 *（会话层那种形态），是因为导入没有会话那样的中途交互——没有需要用户回答的权限请求，
 * 只有进度。让应答直接承载报告，调用方就不必再拼一套「等哪个事件算结束」的状态机。
 *
 * importId 由渲染层生成并贯穿进度事件与取消请求，与会话层的 turnId 同一套路数。
 */

import type { KnowledgeEntryId } from "@ff-pane/shared";
import { useCallback, useRef, useState } from "react";
import type {
  KnowledgeImportPhase,
  KnowledgeImportReport,
  KnowledgePickKind,
} from "../../../../shared-ipc/contracts";
import { invokeQuery, type SettledQueryState } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";

/** 界面要显示的进度快照。 */
export interface KnowledgeImportProgress {
  readonly importId: string;
  readonly phase: KnowledgeImportPhase;
  readonly done: number;
  readonly total: number;
  readonly currentPath?: string;
}

export interface UseKnowledgeImportResult {
  /** 在飞时的进度；空闲为 null。 */
  readonly progress: KnowledgeImportProgress | null;
  readonly running: boolean;
  /** 选文件 / 选目录 → 导入。用户在选择器里取消则整个流程静默结束。 */
  readonly importPaths: (
    kind: KnowledgePickKind,
    options?: { readonly tags?: readonly string[] },
  ) => Promise<KnowledgeImportReport | null>;
  /** 重建索引。entryIds 省略即全部重建。 */
  readonly rebuild: (options?: {
    readonly entryIds?: readonly KnowledgeEntryId[];
    readonly resetVectors?: boolean;
  }) => Promise<KnowledgeImportReport | null>;
  /** 取消在飞的导入 / 重建。 */
  readonly cancel: () => void;
}

/** 失败上报（错误原文由调用方决定怎么呈现，本 hook 不 toast）。 */
export interface UseKnowledgeImportOptions {
  readonly onError: (summary: "import" | "rebuild", message: string) => void;
}

export function useKnowledgeImport(options: UseKnowledgeImportOptions): UseKnowledgeImportResult {
  const [progress, setProgress] = useState<KnowledgeImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  // ref 而不是 state：订阅回调里要拿到「当前这一轮是谁」，用 state 会读到闭包里的旧值
  const activeId = useRef<string | null>(null);

  useSubscription("knowledge:import-progress", (payload) => {
    if (payload.importId !== activeId.current) {
      return;
    }
    setProgress({
      importId: payload.importId,
      phase: payload.phase,
      done: payload.done,
      total: payload.total,
      ...(payload.currentPath === undefined ? {} : { currentPath: payload.currentPath }),
    });
  });

  const run = useCallback(
    async (
      summary: "import" | "rebuild",
      importId: string,
      call: () => Promise<SettledQueryState<KnowledgeImportReport>>,
    ): Promise<KnowledgeImportReport | null> => {
      activeId.current = importId;
      setRunning(true);
      setProgress({ importId, phase: "scanning", done: 0, total: 0 });
      const settled = await call();
      activeId.current = null;
      setRunning(false);
      setProgress(null);
      if (settled.status === "error") {
        options.onError(summary, settled.error.message);
        return null;
      }
      return settled.data;
    },
    [options],
  );

  const importPaths = useCallback<UseKnowledgeImportResult["importPaths"]>(
    async (kind, importOptions) => {
      const picked = await invokeQuery("knowledge:pick-paths", { kind });
      if (picked.status === "error") {
        options.onError("import", picked.error.message);
        return null;
      }
      if (picked.data.cancelled) {
        return null;
      }
      const { paths } = picked.data;
      const importId = crypto.randomUUID();
      return run("import", importId, () =>
        invokeQuery("knowledge:import", {
          importId,
          paths,
          ...(importOptions?.tags === undefined ? {} : { tags: importOptions.tags }),
        }),
      );
    },
    [options, run],
  );

  const rebuild = useCallback<UseKnowledgeImportResult["rebuild"]>(
    (rebuildOptions) => {
      const importId = crypto.randomUUID();
      return run("rebuild", importId, () =>
        invokeQuery("knowledge:rebuild", {
          importId,
          ...(rebuildOptions?.entryIds === undefined ? {} : { entryIds: rebuildOptions.entryIds }),
          ...(rebuildOptions?.resetVectors === undefined
            ? {}
            : { resetVectors: rebuildOptions.resetVectors }),
        }),
      );
    },
    [run],
  );

  const cancel = useCallback(() => {
    const importId = activeId.current;
    if (importId !== null) {
      void invokeQuery("knowledge:cancel-import", { importId });
    }
  }, []);

  return { progress, running, importPaths, rebuild, cancel };
}
