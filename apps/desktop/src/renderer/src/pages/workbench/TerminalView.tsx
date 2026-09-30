/**
 * xterm 终端视图（T10.1）：挂载回放 → 订阅增量；卸载只退订不杀进程。
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
import "@xterm/xterm/css/xterm.css";

export interface TerminalViewProps {
  /** 工作目录；缺省时主进程回退用户主目录。 */
  readonly cwd?: string;
  readonly className?: string;
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

const liveTerminalByKey = new Map<string, string>();

function slotKey(cwd: string | undefined): string {
  return cwd ?? "__home__";
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

export function TerminalView({ cwd, className }: TerminalViewProps): ReactElement {
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

  const writeToPty = useCallback((data: string) => {
    const current = infoRef.current;
    if (current === null || current.exited) {
      return;
    }
    void invokeQuery("terminal:write", { id: current.id, data });
  }, []);

  const spawnTerminal = useCallback(async () => {
    const host = hostRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (host === null || term === null || fit === null) {
      return;
    }
    setError(undefined);
    setExitCode(undefined);
    fit.fit();
    const cols = Math.max(term.cols, 2);
    const rows = Math.max(term.rows, 2);
    const key = slotKey(cwd);

    // StrictMode 双挂载 / 切页回来：复用同槽位未退出的 PTY，只回放+订阅
    const existingId = liveTerminalByKey.get(key);
    if (existingId !== undefined) {
      const listed = await invokeQuery("terminal:list");
      const found =
        listed.status === "success"
          ? listed.data.find((item) => item.id === existingId && !item.exited)
          : undefined;
      if (found !== undefined) {
        infoRef.current = found;
        setInfo(found);
        void invokeQuery("terminal:resize", { id: found.id, cols, rows });
        const replay = await invokeQuery("terminal:get-replay", { id: found.id });
        if (replay.status === "success" && replay.data.data.length > 0) {
          term.reset();
          term.write(replay.data.data);
        }
        return;
      }
      liveTerminalByKey.delete(key);
    }

    const settled = await invokeQuery("terminal:create", {
      ...(cwd === undefined ? {} : { cwd }),
      cols,
      rows,
    });
    if (settled.status === "error") {
      setError(settled.error.message);
      return;
    }
    liveTerminalByKey.set(key, settled.data.id);
    infoRef.current = settled.data;
    setInfo(settled.data);
    const replay = await invokeQuery("terminal:get-replay", { id: settled.data.id });
    if (replay.status === "success" && replay.data.data.length > 0) {
      term.write(replay.data.data);
    }
  }, [cwd]);

  const restart = useCallback(async () => {
    const previous = infoRef.current;
    if (previous !== null) {
      liveTerminalByKey.delete(slotKey(cwd));
      await invokeQuery("terminal:kill", { id: previous.id });
    }
    infoRef.current = null;
    setInfo(null);
    termRef.current?.reset();
    await spawnTerminal();
  }, [cwd, spawnTerminal]);

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

    void spawnTerminal();

    return () => {
      host.removeEventListener("contextmenu", onContextMenu);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // 卸载只退订 / 销毁视图，不杀 PTY 进程（由 infoRef 保留 id；进程由主进程管）
    };
  }, [spawnTerminal, writeToPty]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) {
      return;
    }
    // resolvedTheme 变化时重读 CSS 变量（readThemeColors 读的是 DOM，biome 看不到依赖）
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
    liveTerminalByKey.delete(slotKey(cwd));
    infoRef.current = { ...current, exited: true, exitCode: payload.exitCode };
    setInfo(infoRef.current);
    setExitCode(payload.exitCode);
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
      {exitCode !== undefined ? (
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
    </div>
  );
}
