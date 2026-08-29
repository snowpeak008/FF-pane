import { app, type BrowserWindow, ipcMain } from "electron";
import type { SmokeReport } from "../shared-ipc/contracts";
import { publishEvent, registerInvokeHandlers } from "../shared-ipc/server";
import { runSqliteCheck } from "./sqlite-check";

/**
 * 冒烟自测模式（pnpm smoke → electron . --smoke），本任务的客观验收手段：
 * 1. 主进程直接验证 better-sqlite3 内存库查询（风险 R1）
 * 2. 创建隐藏窗口加载 renderer（URL 带 ?smoke=1）
 * 3. renderer 依次执行：IPC ping-pong / app-info / 经 IPC 的 sqlite 检查 / 事件订阅 / CSP 拦截 eval
 * 4. renderer 经 smoke:report 上报，全部通过退出码 0，任一失败退出码 1；超时兜底退出码 1
 */
const SMOKE_TIMEOUT_MS = 30_000;
const EXIT_DELAY_MS = 100;

export function startSmokeMode(createWindow: () => BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error(`[smoke] FAIL renderer-report —— ${SMOKE_TIMEOUT_MS}ms 内未收到 renderer 上报`);
    app.exit(1);
  }, SMOKE_TIMEOUT_MS);

  let mainSqliteOk = false;
  try {
    const report = runSqliteCheck();
    console.log(
      `[smoke] PASS main-sqlite —— 主进程 better-sqlite3 内存库查询成功（SQLite ${report.sqliteVersion}）`,
    );
    mainSqliteOk = true;
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`[smoke] FAIL main-sqlite —— ${message}`);
  }

  const window = createWindow();

  registerInvokeHandlers(ipcMain, {
    "smoke:emit-event": (request) => {
      publishEvent(window.webContents, "smoke:event", {
        seq: request.seq,
        emittedAt: Date.now(),
      });
      return { emitted: true as const };
    },
    "smoke:report": (report) => {
      clearTimeout(timeout);
      finish(report, mainSqliteOk);
      return { acknowledged: true as const };
    },
  });

  window.webContents.on("did-fail-load", (_event, code, description) => {
    clearTimeout(timeout);
    console.error(`[smoke] FAIL renderer-load —— 页面加载失败（${code} ${description}）`);
    app.exit(1);
  });
}

function finish(report: SmokeReport, mainSqliteOk: boolean): void {
  for (const check of report.checks) {
    const line = `[smoke] ${check.ok ? "PASS" : "FAIL"} ${check.name} —— ${check.detail}`;
    if (check.ok) {
      console.log(line);
    } else {
      console.error(line);
    }
  }
  const allOk = mainSqliteOk && report.checks.length > 0 && report.checks.every((c) => c.ok);
  if (allOk) {
    console.log("[smoke] ALL PASS：IPC ping-pong、事件订阅、better-sqlite3、CSP 全部通过");
  } else {
    console.error("[smoke] 存在失败项，退出码 1");
  }
  // 留出时间让 smoke:report 的响应送达 renderer，再带退出码退出
  setTimeout(() => app.exit(allOk ? 0 : 1), EXIT_DELAY_MS);
}
