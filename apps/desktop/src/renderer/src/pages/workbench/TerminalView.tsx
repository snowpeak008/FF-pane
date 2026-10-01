/**
 * xterm 终端视图（T10.1 / T10.2）：按 windowId 槽位复用 PTY；卸载只退订不杀进程。
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalInfo } from "../../../../shared-ipc/contracts";
import { Button } from "../../components/ui/Button";
import { invokeQuery } from "../../ipc/query";
import { useSubscription } from "../../ipc/useSubscription";
import { cn } from "../../lib/cn";
import { useTheme } from "../../theme";
import { forgetLiveTerminal, peekLiveTerminal, rememberLiveTerminal } from "./live-terminals";
import "@xterm/xterm/css/xterm.css";

export interface TerminalViewProps {
  /** 工作台窗口 id（槽位键；与 PTY id 分离）。 */
  readonly windowId: string;
  readonly projectId: string;
  /** 工作目录；缺省时主进程回退用户主目录。 */
  readonly cwd?: string;
  /** cwd 不可用时的回退目录（项目根）。 */
  readonly fallbackCwd?: string;
  readonly className?: string;
  readonly onTerminalIdChange?: (terminalId: string | undefined) => void;
  readonly onExitCodeChange?: (exitCode: number | undefined) => void;
  readonly onCwdFallback?: () => void;
  /** AI 窗口：不自动 spawn shell，改走 workbench:launch-cli。 */
  readonly cliLaunch?: {
    readonly profileId: string;
    readonly projectRoot: string;
    readonly nativeSessionId?: string;
    readonly initialPrompt?: string;
    readonly resume?: boolean;
    readonly permission?: import("@ff-pane/shared").WorkbenchPermissionLevel;
    readonly role?: import("@ff-pane/shared").WorkbenchRole;
    /** false = 应用恢复的已停止窗口，不自动启动。 */
    readonly autoStart: boolean;
  };
  /** AI 窗口退出后的额外操作按钮。 */
  readonly onResume?: () => void;
  readonly onRestartFresh?: () => void;
  readonly onConvertToShell?: () => void;
  /** 启动成功后回写原生会话 id。 */
  readonly onNativeSessionId?: (nativeSessionId: string | undefined) => void;
  /** T10.5'：启动时权限被祖先封顶。 */
  readonly onPermissionCapped?: (
    effective: import("@ff-pane/shared").WorkbenchPermissionLevel,
  ) => void;
  /** 没有 node.exe 时回合信号装不上，投递一直要手动确认。 */
  readonly onTurnSignal?: (signal: "auto" | "manual") => void;
  /** 外部触发启动（续接 / 重新开始）。 */
  readonly launchNonce?: number;
  /** 用户点续接或重新开始之前。返回 false 则不启动。 */
  readonly beforeUserRelaunch?: () => boolean | Promise<boolean>;
}

interface ThemeColors {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selectionBackground: string;
}

function readThemeColors(): ThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--ff-surface-sunken").trim() || "#0a0d11";
  const foreground = styles.getPropertyValue("--ff-fg").trim() || "#e7eaf0";
  const cursor = styles.getPropertyValue("--ff-fg-muted").trim() || foreground;
  const selectionBackground = styles.getPropertyValue("--ff-surface-active").trim() || "#232a34";
  return { background, foreground, cursor, selectionBackground };
}

function monoFontFamily(): string {
  const styles = getComputedStyle(document.documentElement);
  const fromToken = styles.getPropertyValue("--font-mono").trim();
  return fromToken || '"Cascadia Mono", Consolas, ui-monospace, "SFMono-Regular", Menlo, monospace';
}

async function tryLoadWebgl(terminal: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    terminal.loadAddon(addon);
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        // fall back to DOM renderer
      }
    });
  } catch {
    // WebGL unavailable — keep DOM renderer
  }
}

export function TerminalView({
  windowId,
  projectId,
  cwd,
  fallbackCwd,
  className,
  onTerminalIdChange,
  onExitCodeChange,
  onCwdFallback,
  cliLaunch,
  onResume,
  onRestartFresh,
  onConvertToShell,
  onNativeSessionId,
  onPermissionCapped,
  onTurnSignal,
  launchNonce = 0,
  beforeUserRelaunch,
}: TerminalViewProps): ReactElement {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const infoRef = useRef<TerminalInfo | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [exitCode, setExitCode] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [stopped, setStopped] = useState(
    () => cliLaunch !== undefined && cliLaunch.autoStart === false,
  );
  const [resumePickerHint, setResumePickerHint] = useState(false);

  const onTerminalIdChangeRef = useRef(onTerminalIdChange);
  onTerminalIdChangeRef.current = onTerminalIdChange;
  const onExitCodeChangeRef = useRef(onExitCodeChange);
  onExitCodeChangeRef.current = onExitCodeChange;
  const onCwdFallbackRef = useRef(onCwdFallback);
  onCwdFallbackRef.current = onCwdFallback;
  const cliLaunchRef = useRef(cliLaunch);
  cliLaunchRef.current = cliLaunch;
  const nativeSessionIdRef = useRef<string | undefined>(cliLaunch?.nativeSessionId);
  if (cliLaunch?.nativeSessionId !== undefined) {
    nativeSessionIdRef.current = cliLaunch.nativeSessionId;
  }
  const onNativeSessionIdRef = useRef(onNativeSessionId);
  onNativeSessionIdRef.current = onNativeSessionId;
  const onPermissionCappedRef = useRef(onPermissionCapped);
  onPermissionCappedRef.current = onPermissionCapped;
  const onTurnSignalRef = useRef(onTurnSignal);
  onTurnSignalRef.current = onTurnSignal;

  const writeToPty = useCallback((data: string) => {
    const current = infoRef.current;
    if (current === null || current.exited) {
      return;
    }
    void invokeQuery("terminal:write", { id: current.id, data });
  }, []);

  const attachExisting = useCallback(
    async (existingId: string, cols: number, rows: number): Promise<boolean> => {
      const term = termRef.current;
      if (term === null) {
        return false;
      }
      const listed = await invokeQuery("terminal:list");
      const found =
        listed.status === "success"
          ? listed.data.find((item) => item.id === existingId && !item.exited)
          : undefined;
      if (found === undefined) {
        forgetLiveTerminal(windowId);
        return false;
      }
      infoRef.current = found;
      setInfo(found);
      onTerminalIdChangeRef.current?.(found.id);
      void invokeQuery("terminal:resize", { id: found.id, cols, rows });
      const replay = await invokeQuery("terminal:get-replay", { id: found.id });
      if (replay.status === "success" && replay.data.data.length > 0) {
        term.reset();
        term.write(replay.data.data);
      }
      return true;
    },
    [windowId],
  );

  const createWithCwd = useCallback(
    async (targetCwd: string | undefined, cols: number, rows: number) => {
      return invokeQuery("terminal:create", {
        ...(targetCwd === undefined ? {} : { cwd: targetCwd }),
        cols,
        rows,
        metadata: { windowId, projectId },
      });
    },
    [projectId, windowId],
  );

  const launchCli = useCallback(
    async (cols: number, rows: number, override?: Partial<NonNullable<typeof cliLaunch>>) => {
      const launch = { ...cliLaunchRef.current, ...override };
      if (
        launch.profileId === undefined ||
        launch.projectRoot === undefined ||
        launch.projectRoot.trim() === ""
      ) {
        return { status: "error" as const, error: { message: "missing cli launch config" } };
      }
      const resuming = launch.resume === true;
      const sessionId = resuming
        ? (override?.nativeSessionId ?? launch.nativeSessionId ?? nativeSessionIdRef.current)
        : undefined;
      return invokeQuery("workbench:launch-cli", {
        windowId,
        projectId: projectId as never,
        projectRoot: launch.projectRoot,
        profileId: launch.profileId,
        cols,
        rows,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(launch.initialPrompt !== undefined ? { initialPrompt: launch.initialPrompt } : {}),
        ...(resuming ? { resume: true } : {}),
        ...(sessionId !== undefined ? { nativeSessionId: sessionId } : {}),
        ...(launch.permission !== undefined ? { permission: launch.permission } : {}),
        ...(launch.role !== undefined ? { role: launch.role } : {}),
      });
    },
    [cwd, projectId, windowId],
  );

  const spawnTerminal = useCallback(async () => {
    const host = hostRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (host === null || term === null || fit === null) {
      return;
    }
    setError(undefined);
    setExitCode(undefined);
    setStopped(false);
    onExitCodeChangeRef.current?.(undefined);
    fit.fit();
    const cols = Math.max(term.cols, 2);
    const rows = Math.max(term.rows, 2);

    const existingId = peekLiveTerminal(windowId);
    if (existingId !== undefined) {
      if (await attachExisting(existingId, cols, rows)) {
        return;
      }
    }

    if (cliLaunchRef.current !== undefined) {
      const settled = await launchCli(cols, rows);
      if (settled.status === "error") {
        setError(settled.error.message);
        setStopped(true);
        onTerminalIdChangeRef.current?.(undefined);
        return;
      }
      rememberLiveTerminal(windowId, settled.data.terminal.id);
      infoRef.current = settled.data.terminal;
      setInfo(settled.data.terminal);
      onTerminalIdChangeRef.current?.(settled.data.terminal.id);
      if (settled.data.nativeSessionId !== undefined) {
        nativeSessionIdRef.current = settled.data.nativeSessionId;
      }
      onNativeSessionIdRef.current?.(settled.data.nativeSessionId);
      if (settled.data.permissionCapped === true) {
        onPermissionCappedRef.current?.(settled.data.effectivePermission);
      }
      onTurnSignalRef.current?.(settled.data.turnSignal);
      setResumePickerHint(settled.data.resumePicker === true);
      const replay = await invokeQuery("terminal:get-replay", { id: settled.data.terminal.id });
      if (replay.status === "success" && replay.data.data.length > 0) {
        term.write(replay.data.data);
      }
      return;
    }

    let settled = await createWithCwd(cwd, cols, rows);
    if (settled.status === "error" && fallbackCwd !== undefined && fallbackCwd !== cwd) {
      settled = await createWithCwd(fallbackCwd, cols, rows);
      if (settled.status === "success") {
        onCwdFallbackRef.current?.();
      }
    }
    if (settled.status === "error") {
      setError(settled.error.message);
      onTerminalIdChangeRef.current?.(undefined);
      return;
    }
    rememberLiveTerminal(windowId, settled.data.id);
    infoRef.current = settled.data;
    setInfo(settled.data);
    onTerminalIdChangeRef.current?.(settled.data.id);
    const replay = await invokeQuery("terminal:get-replay", { id: settled.data.id });
    if (replay.status === "success" && replay.data.data.length > 0) {
      term.write(replay.data.data);
    }
  }, [attachExisting, createWithCwd, cwd, fallbackCwd, launchCli, windowId]);

  const restart = useCallback(async () => {
    const previous = infoRef.current;
    if (previous !== null) {
      forgetLiveTerminal(windowId);
      await invokeQuery("terminal:kill", { id: previous.id });
    }
    infoRef.current = null;
    setInfo(null);
    onTerminalIdChangeRef.current?.(undefined);
    termRef.current?.reset();
    await spawnTerminal();
  }, [spawnTerminal, windowId]);

  const relaunchWith = useCallback(
    async (override: Partial<NonNullable<typeof cliLaunch>>) => {
      const host = hostRef.current;
      const term = termRef.current;
      const fit = fitRef.current;
      if (host === null || term === null || fit === null) {
        return;
      }
      const previous = infoRef.current;
      if (previous !== null) {
        forgetLiveTerminal(windowId);
        await invokeQuery("terminal:kill", { id: previous.id });
      }
      infoRef.current = null;
      setInfo(null);
      setError(undefined);
      setExitCode(undefined);
      setStopped(false);
      setResumePickerHint(false);
      onExitCodeChangeRef.current?.(undefined);
      onTerminalIdChangeRef.current?.(undefined);
      term.reset();
      fit.fit();
      const cols = Math.max(term.cols, 2);
      const rows = Math.max(term.rows, 2);
      const settled = await launchCli(cols, rows, override);
      if (settled.status === "error") {
        setError(settled.error.message);
        setStopped(true);
        return;
      }
      rememberLiveTerminal(windowId, settled.data.terminal.id);
      infoRef.current = settled.data.terminal;
      setInfo(settled.data.terminal);
      onTerminalIdChangeRef.current?.(settled.data.terminal.id);
      if (settled.data.nativeSessionId !== undefined) {
        nativeSessionIdRef.current = settled.data.nativeSessionId;
        onNativeSessionIdRef.current?.(settled.data.nativeSessionId);
      }
      if (settled.data.permissionCapped === true) {
        onPermissionCappedRef.current?.(settled.data.effectivePermission);
      }
      onTurnSignalRef.current?.(settled.data.turnSignal);
      setResumePickerHint(settled.data.resumePicker === true);
      const replay = await invokeQuery("terminal:get-replay", { id: settled.data.terminal.id });
      if (replay.status === "success" && replay.data.data.length > 0) {
        term.write(replay.data.data);
      }
    },
    [launchCli, windowId],
  );

  // 外部 nonce：父级驱动的再拉起（若仍使用）
  const lastNonceRef = useRef(0);
  useEffect(() => {
    if (launchNonce === 0 || launchNonce === lastNonceRef.current) {
      return;
    }
    lastNonceRef.current = launchNonce;
    const resume = cliLaunchRef.current?.resume === true;
    if (resume) {
      void relaunchWith({
        resume: true,
        ...(nativeSessionIdRef.current !== undefined
          ? { nativeSessionId: nativeSessionIdRef.current }
          : {}),
      });
    } else {
      nativeSessionIdRef.current = undefined;
      void relaunchWith({ resume: false });
    }
  }, [launchNonce, relaunchWith]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const colors = readThemeColors();
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: monoFontFamily(),
      fontSize: 13,
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        selectionBackground: colors.selectionBackground,
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    void tryLoadWebgl(term);

    term.onData((data) => {
      writeToPty(data);
    });

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      if (ctrlShift && (event.key === "C" || event.key === "c")) {
        const selection = term.getSelection();
        if (selection.length > 0) {
          void navigator.clipboard.writeText(selection);
        }
        return false;
      }
      if (ctrlShift && (event.key === "V" || event.key === "v")) {
        void navigator.clipboard.readText().then((text) => {
          if (text.length > 0) {
            writeToPty(text);
          }
        });
        return false;
      }
      return true;
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        const current = infoRef.current;
        if (current !== null && !current.exited) {
          void invokeQuery("terminal:resize", {
            id: current.id,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch {
        // ignore fit races during teardown
      }
    });
    observer.observe(host);

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY });
    };
    host.addEventListener("contextmenu", onContextMenu);

    const shouldAutoStart =
      cliLaunchRef.current === undefined || cliLaunchRef.current.autoStart !== false;
    if (shouldAutoStart || peekLiveTerminal(windowId) !== undefined) {
      void spawnTerminal();
    } else {
      setStopped(true);
    }

    return () => {
      host.removeEventListener("contextmenu", onContextMenu);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [spawnTerminal, writeToPty, windowId]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    void resolvedTheme;
    const colors = readThemeColors();
    term.options.theme = {
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.cursor,
      selectionBackground: colors.selectionBackground,
    };
  }, [resolvedTheme]);

  useEffect(() => {
    if (menu === null) {
      return;
    }
    const dismiss = (): void => {
      setMenu(null);
    };
    document.addEventListener("mousedown", dismiss);
    return () => {
      document.removeEventListener("mousedown", dismiss);
    };
  }, [menu]);

  useSubscription("terminal:output", (payload) => {
    const current = infoRef.current;
    if (current === null || payload.id !== current.id) {
      return;
    }
    termRef.current?.write(payload.data);
  });

  useSubscription("terminal:exit", (payload) => {
    const current = infoRef.current;
    if (current === null || payload.id !== current.id) {
      return;
    }
    forgetLiveTerminal(windowId);
    infoRef.current = { ...current, exited: true, exitCode: payload.exitCode };
    setInfo(infoRef.current);
    setExitCode(payload.exitCode);
    setStopped(cliLaunchRef.current !== undefined);
    onExitCodeChangeRef.current?.(payload.exitCode);
  });

  useSubscription("workbench:session-claimed", (payload) => {
    if (payload.windowId !== windowId) {
      return;
    }
    nativeSessionIdRef.current = payload.nativeSessionId;
    onNativeSessionIdRef.current?.(payload.nativeSessionId);
  });

  const copySelection = (): void => {
    const selection = termRef.current?.getSelection() ?? "";
    if (selection.length > 0) {
      void navigator.clipboard.writeText(selection);
    }
    setMenu(null);
  };

  const pasteClipboard = (): void => {
    void navigator.clipboard.readText().then((text) => {
      if (text.length > 0) {
        writeToPty(text);
      }
    });
    setMenu(null);
  };

  const showCliActions = cliLaunch !== undefined && (stopped || exitCode !== undefined);

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col bg-surface-sunken", className)}>
      <div ref={hostRef} className="min-h-0 flex-1 p-1" data-testid="terminal-host" />
      {error !== undefined ? (
        <div className="absolute inset-x-0 bottom-0 border-t border-danger-border bg-danger-surface px-3 py-2 text-xs text-danger-text">
          {error}
          <Button className="ml-2" size="sm" variant="secondary" onClick={() => void restart()}>
            {t("workbench.terminal.restart")}
          </Button>
        </div>
      ) : null}
      {resumePickerHint && !showCliActions ? (
        <div
          className="absolute inset-x-0 bottom-0 z-10 border-t border-border bg-surface px-3 py-2 text-xs text-fg-muted"
          data-testid="terminal-resume-picker-hint"
        >
          {t("workbench.terminal.resumePickerHint")}
        </div>
      ) : null}
      {showCliActions ? (
        <div
          className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2 text-xs text-fg-muted"
          data-testid="terminal-cli-stopped"
        >
          {exitCode !== undefined ? (
            <span className="font-mono">{t("workbench.terminal.exited", { code: exitCode })}</span>
          ) : (
            <span>{t("workbench.window.status.stopped")}</span>
          )}
          <Button
            size="sm"
            variant="secondary"
            data-testid="cli-resume"
            onClick={() => {
              void (async () => {
                if (beforeUserRelaunch !== undefined && !(await beforeUserRelaunch())) {
                  return;
                }
                onResume?.();
                void relaunchWith({
                  resume: true,
                  ...(nativeSessionIdRef.current !== undefined
                    ? { nativeSessionId: nativeSessionIdRef.current }
                    : {}),
                });
              })();
            }}
          >
            {t("workbench.terminal.resume")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="cli-restart-fresh"
            onClick={() => {
              void (async () => {
                if (beforeUserRelaunch !== undefined && !(await beforeUserRelaunch())) {
                  return;
                }
                nativeSessionIdRef.current = undefined;
                onRestartFresh?.();
                void relaunchWith({ resume: false });
              })();
            }}
          >
            {t("workbench.terminal.restartFresh")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="cli-convert-shell"
            onClick={() => onConvertToShell?.()}
          >
            {t("workbench.terminal.convertToShell")}
          </Button>
        </div>
      ) : exitCode !== undefined ? (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-border bg-surface px-3 py-2 text-xs text-fg-muted"
          data-testid="terminal-exited"
        >
          <span className="font-mono">{t("workbench.terminal.exited", { code: exitCode })}</span>
          <Button size="sm" variant="secondary" onClick={() => void restart()}>
            {t("workbench.terminal.restart")}
          </Button>
        </div>
      ) : null}
      {menu !== null ? (
        <div
          className="fixed z-50 min-w-28 rounded-md border border-border bg-surface-raised py-1 shadow-overlay"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-hover"
            role="menuitem"
            onClick={copySelection}
          >
            {t("workbench.terminal.copy")}
          </button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-hover"
            role="menuitem"
            onClick={pasteClipboard}
          >
            {t("workbench.terminal.paste")}
          </button>
        </div>
      ) : null}
      {info !== null ? (
        <span className="sr-only" data-testid="terminal-id">
          {info.id}
        </span>
      ) : null}
      <span className="sr-only" data-testid="workbench-window-id">
        {windowId}
      </span>
    </div>
  );
}
