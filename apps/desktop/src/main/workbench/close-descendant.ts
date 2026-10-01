/**
 * 关闭后代窗口（T10.7b）。
 * 杀 PTY、吊销令牌、丢掉投递队列、从布局移除，直接子窗口标记 parentClosed。
 * 在关闭者的团队 Markdown 追加一条系统记录。
 */

import { randomUUID } from "node:crypto";
import type { WorkbenchAuthNode } from "@ff-pane/core";
import type { ProjectWorkbenchLayout, WorkbenchRole } from "@ff-pane/shared";
import { detachWindowFromLayout } from "../../shared/workbench/detach-window";
import { appendThreadRecord, type ThreadRecord, teamAnchorId, teamFileSlug } from "./thread-store";

export interface CloseParty {
  readonly id: string;
  readonly title: string;
  readonly role: WorkbenchRole;
  readonly projectId: string;
  readonly projectRoot: string;
}

export interface CloseDescendantDeps {
  readonly findTerminalId: (windowId: string) => string | undefined;
  readonly killTerminal: (terminalId: string) => void;
  readonly dropQueue: (terminalId: string) => void;
  readonly revokeToken: (windowId: string) => void;
  readonly releaseRuntime: (windowId: string) => void;
  readonly closeRegistered: (windowId: string) => void;
  readonly readLayouts: () => Promise<Readonly<Record<string, ProjectWorkbenchLayout>>>;
  readonly saveLayout: (layout: ProjectWorkbenchLayout) => Promise<void>;
  readonly publishClosed: (projectId: string, windowId: string) => void;
}

export async function closeDescendantWindow(
  caller: CloseParty,
  target: CloseParty,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  now: number,
  deps: CloseDescendantDeps,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const terminalId = deps.findTerminalId(target.id);
  if (terminalId !== undefined) {
    deps.dropQueue(terminalId);
    try {
      deps.killTerminal(terminalId);
    } catch {
      return { ok: false, error: "关闭终端失败。" };
    }
  }
  deps.revokeToken(target.id);
  deps.releaseRuntime(target.id);
  deps.closeRegistered(target.id);

  const layouts = await deps.readLayouts();
  for (const layout of Object.values(layouts)) {
    if (layout.windows[target.id] === undefined) {
      continue;
    }
    const next = detachWindowFromLayout(layout, target.id);
    await deps.saveLayout(next);
    deps.publishClosed(layout.projectId, target.id);
    break;
  }

  const date = new Date(now);
  const anchor = teamAnchorId(caller.id, target.id, tree);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const anchorTitle =
    anchor === caller.id ? caller.title : anchor === target.id ? target.title : "团队";
  const record: ThreadRecord = {
    v: 1,
    id: `m-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: date.toISOString(),
    projectId: caller.projectId,
    from: { windowId: caller.id, title: caller.title, role: caller.role },
    to: { windowId: target.id, title: target.title, role: target.role },
    kind: "system",
    text: `已关闭窗口「${target.title}」。`,
    threadFile: `${day}-${teamFileSlug(anchorTitle, anchor)}.md`,
  };
  await appendThreadRecord(caller.projectRoot, record, date);
  return { ok: true };
}
