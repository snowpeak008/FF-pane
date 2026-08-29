import type { SmokeCheck } from "../../shared-ipc/contracts";

/**
 * 渲染侧冒烟自测：逐项执行检查并经 smoke:report 上报主进程，
 * 由主进程决定进程退出码（见 src/main/smoke.ts）。
 */
export async function runRendererSmoke(): Promise<void> {
  const checks: SmokeCheck[] = [];

  const step = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (thrown) {
      checks.push({
        name,
        ok: false,
        detail: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  };

  await step("ipc-ping-pong", async () => {
    const sentAt = Date.now();
    const response = await window.ffpane.invoke("app:ping", { message: "ping", sentAt });
    if (response.reply !== "pong" || response.echoed !== "ping") {
      throw new Error(`响应不符合契约：${JSON.stringify(response)}`);
    }
    return `renderer 发 ping、main 回 pong（往返 ${Date.now() - sentAt}ms）`;
  });

  await step("app-info", async () => {
    const info = await window.ffpane.invoke("app:get-info");
    if (info.name !== "FF-pane" || info.version.length === 0) {
      throw new Error(`应用信息异常：${JSON.stringify(info)}`);
    }
    return `${info.name} v${info.version}（Electron ${info.runtime.electron}）`;
  });

  await step("sqlite-via-ipc", async () => {
    const report = await window.ffpane.invoke("diagnostics:check-sqlite");
    return `经 IPC 触发主进程 better-sqlite3 查询成功（SQLite ${report.sqliteVersion}）`;
  });

  await step("event-subscription", () => {
    return new Promise<string>((resolve, reject) => {
      const seq = Math.floor(Math.random() * 1_000_000);
      const timer = window.setTimeout(() => {
        unsubscribe();
        reject(new Error("5s 内未收到 smoke:event 推送"));
      }, 5_000);
      const unsubscribe = window.ffpane.subscribe("smoke:event", (payload) => {
        if (payload.seq !== seq) {
          return;
        }
        window.clearTimeout(timer);
        unsubscribe();
        resolve(`订阅 smoke:event 并收到 seq=${payload.seq} 的推送`);
      });
      window.ffpane.invoke("smoke:emit-event", { seq }).catch((thrown: unknown) => {
        window.clearTimeout(timer);
        unsubscribe();
        reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      });
    });
  });

  await step("csp-blocks-eval", async () => {
    try {
      // biome-ignore lint/security/noGlobalEval: 冒烟自测故意调用 eval，验证 CSP 拦截生效
      globalThis.eval("1 + 1");
    } catch (thrown) {
      if (thrown instanceof EvalError) {
        return "CSP 已拦截 eval（script-src 未放行 'unsafe-eval'）";
      }
      throw new Error(`eval 抛出了非 CSP 异常：${String(thrown)}`);
    }
    throw new Error("eval 未被 CSP 拦截，安全基线未生效");
  });

  await window.ffpane.invoke("smoke:report", { checks });
}
