import { type ReactElement, useEffect, useState } from "react";
import type { AppInfo } from "../../shared-ipc/contracts";

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly info: AppInfo }
  | { readonly phase: "error"; readonly message: string };

/**
 * T0.2 首页：仅展示应用名与版本（来自主进程，经 IPC 获取），验证三层链路真实打通。
 * 界面美化与设计系统是 Phase 3（T3.1）的事。
 */
export function App(): ReactElement {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    window.ffpane
      .invoke("app:get-info")
      .then((info) => {
        if (!cancelled) {
          setState({ phase: "ready", info });
        }
      })
      .catch((thrown: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: thrown instanceof Error ? thrown.message : String(thrown),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return <main>正在获取应用信息…</main>;
  }
  if (state.phase === "error") {
    return <main>应用信息获取失败：{state.message}</main>;
  }
  const { info } = state;
  return (
    <main>
      <h1>{info.name}</h1>
      <p>版本 {info.version}</p>
      <p>
        Electron {info.runtime.electron} · Chromium {info.runtime.chrome} · Node {info.runtime.node}
      </p>
    </main>
  );
}
