import { app, type BrowserWindow, ipcMain } from "electron";
import type { SmokeReport } from "../shared-ipc/contracts";
import { publishEvent, registerInvokeHandlers } from "../shared-ipc/server";
import { runSecretsCheck } from "./secrets";
import { runSqliteCheck } from "./sqlite-check";

/**
 * 冒烟自测模式（pnpm smoke → electron . --smoke），本任务的客观验收手段：
 * 1. 主进程直接验证 better-sqlite3 内存库查询（风险 R1）
 * 2. 主进程验证真实 safeStorage 密钥往返（W1.5b：store→reveal + maskedTail + delete）
 * 3. 创建隐藏窗口加载 renderer（URL 带 ?smoke=1）
 * 4. renderer 依次执行：IPC ping-pong / app-info / 经 IPC 的 sqlite 检查 / 事件订阅 / CSP 拦截 eval
 * 5. renderer 经 smoke:report 上报，全部通过退出码 0，任一失败退出码 1；超时兜底退出码 1
 */
const SMOKE_TIMEOUT_MS = 30_000;
const EXIT_DELAY_MS = 100;
/** secrets-roundtrip 自测的独立兜底：极端情况下 DPAPI 挂起不应拖死整个冒烟流程。 */
const SECRETS_CHECK_TIMEOUT_MS = 10_000;

/** W1.5b secrets-roundtrip 自测结果（detail 永不含明文 / 密文）。 */
interface SecretsCheckOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

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

  // W1.5b：真实 safeStorage 的密钥往返自测（Node 单测拿不到 safeStorage，只能在此回归）。
  // 与 renderer 检查并行执行，结果在 finish 阶段统一输出
  const secretsCheck: Promise<SecretsCheckOutcome> = Promise.race([
    runSecretsCheck().then(
      (detail): SecretsCheckOutcome => ({ ok: true, detail }),
      (thrown: unknown): SecretsCheckOutcome => ({
        ok: false,
        detail: thrown instanceof Error ? thrown.message : String(thrown),
      }),
    ),
    new Promise<SecretsCheckOutcome>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, detail: `${SECRETS_CHECK_TIMEOUT_MS}ms 内未完成` }),
        SECRETS_CHECK_TIMEOUT_MS,
      ),
    ),
  ]);

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
      void finish(report, mainSqliteOk, secretsCheck);
      return { acknowledged: true as const };
    },
  });

  window.webContents.on("did-fail-load", (_event, code, description) => {
    clearTimeout(timeout);
    console.error(`[smoke] FAIL renderer-load —— 页面加载失败（${code} ${description}）`);
    app.exit(1);
  });
}

async function finish(
  report: SmokeReport,
  mainSqliteOk: boolean,
  secretsCheck: Promise<SecretsCheckOutcome>,
): Promise<void> {
  for (const check of report.checks) {
    const line = `[smoke] ${check.ok ? "PASS" : "FAIL"} ${check.name} —— ${check.detail}`;
    if (check.ok) {
      console.log(line);
    } else {
      console.error(line);
    }
  }
  const secrets = await secretsCheck;
  const secretsLine = `[smoke] ${secrets.ok ? "PASS" : "FAIL"} secrets-roundtrip —— ${secrets.detail}`;
  if (secrets.ok) {
    console.log(secretsLine);
  } else {
    console.error(secretsLine);
  }
  const allOk =
    mainSqliteOk && secrets.ok && report.checks.length > 0 && report.checks.every((c) => c.ok);
  if (allOk) {
    console.log("[smoke] ALL PASS：IPC ping-pong、事件订阅、better-sqlite3、CSP、密钥往返全部通过");
  } else {
    console.error("[smoke] 存在失败项，退出码 1");
  }
  // 留出时间让 smoke:report 的响应送达 renderer，再带退出码退出
  setTimeout(() => app.exit(allOk ? 0 : 1), EXIT_DELAY_MS);
}
