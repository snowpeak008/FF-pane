/**
 * 递归分屏布局（T10.2）：react-resizable-panels PanelGroup 二叉树。
 */

import type { PaneNode, ProjectId, WorkbenchWindow } from "@ff-pane/shared";
import type { ReactElement } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  percentToSizes,
  sizesToPercent,
  splitNodeKey,
} from "../../../../shared/workbench/pane-tree";
import { cn } from "../../lib/cn";
import { WindowPane } from "./WindowPane";

export interface SplitLayoutProps {
  readonly root: PaneNode;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly windows: Readonly<Record<string, WorkbenchWindow>>;
  readonly focusedWindowId: string | null;
  readonly maximizedWindowId: string | null;
  readonly onFocus: (windowId: string) => void;
  readonly onClose: (windowId: string) => void;
  readonly onSplitRight: (windowId: string) => void;
  readonly onSplitDown: (windowId: string) => void;
  readonly onToggleMaximize: (windowId: string) => void;
  readonly onRename: (windowId: string, title: string) => void;
  readonly onTerminalIdChange: (windowId: string, terminalId: string | undefined) => void;
  readonly onCwdFallback: (windowId: string) => void;
  readonly onSizesChange: (splitKey: string, percents: readonly [number, number]) => void;
}

export function SplitLayout(props: SplitLayoutProps): ReactElement | null {
  const { root, maximizedWindowId, windows } = props;
  if (maximizedWindowId !== null) {
    const window = windows[maximizedWindowId];
    if (window === undefined) {
      return null;
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col p-1">
        <WindowPane
          window={window}
          projectRoot={props.projectRoot}
          focused
          maximized
          onFocus={() => props.onFocus(window.id)}
          onClose={() => props.onClose(window.id)}
          onSplitRight={() => props.onSplitRight(window.id)}
          onSplitDown={() => props.onSplitDown(window.id)}
          onToggleMaximize={() => props.onToggleMaximize(window.id)}
          onRename={(title) => props.onRename(window.id, title)}
          onTerminalIdChange={(id) => props.onTerminalIdChange(window.id, id)}
          onCwdFallback={() => props.onCwdFallback(window.id)}
        />
      </div>
    );
  }
  return <PaneTree node={root} {...props} />;
}

function PaneTree({
  node,
  ...props
}: SplitLayoutProps & { readonly node: PaneNode }): ReactElement | null {
  if (node.type === "leaf") {
    const window = props.windows[node.windowId];
    if (window === undefined) {
      return null;
    }
    return (
      <WindowPane
        window={window}
        projectRoot={props.projectRoot}
        focused={props.focusedWindowId === window.id}
        maximized={false}
        onFocus={() => props.onFocus(window.id)}
        onClose={() => props.onClose(window.id)}
        onSplitRight={() => props.onSplitRight(window.id)}
        onSplitDown={() => props.onSplitDown(window.id)}
        onToggleMaximize={() => props.onToggleMaximize(window.id)}
        onRename={(title) => props.onRename(window.id, title)}
        onTerminalIdChange={(id) => props.onTerminalIdChange(window.id, id)}
        onCwdFallback={() => props.onCwdFallback(window.id)}
      />
    );
  }

  const [leftPct, rightPct] = sizesToPercent(node.sizes);
  const key = splitNodeKey(node);

  return (
    <PanelGroup
      direction={node.direction}
      className="min-h-0 min-w-0 flex-1"
      onLayout={(sizes) => {
        if (sizes.length < 2) {
          return;
        }
        const left = sizes[0] ?? leftPct;
        const right = sizes[1] ?? rightPct;
        if (Math.abs(left - leftPct) < 0.5 && Math.abs(right - rightPct) < 0.5) {
          return;
        }
        const next = percentToSizes([left, right]);
        props.onSizesChange(key, [next[0] * 100, next[1] * 100]);
      }}
      id={key}
    >
      <Panel defaultSize={leftPct} minSize={15} className="min-h-0 min-w-0">
        <div className="flex h-full min-h-0 flex-col p-0.5">
          <PaneTree node={node.children[0]} {...props} />
        </div>
      </Panel>
      <PanelResizeHandle
        className={cn(
          "bg-border transition-colors hover:bg-primary",
          node.direction === "horizontal" ? "w-1" : "h-1",
        )}
      />
      <Panel defaultSize={rightPct} minSize={15} className="min-h-0 min-w-0">
        <div className="flex h-full min-h-0 flex-col p-0.5">
          <PaneTree node={node.children[1]} {...props} />
        </div>
      </Panel>
    </PanelGroup>
  );
}
