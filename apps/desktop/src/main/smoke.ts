import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, ipcMain } from "electron";
import type { SmokeReport } from "../shared-ipc/contracts";
import { publishEvent, registerInvokeHandlers } from "../shared-ipc/server";
import { runSecretsCheck } from "./secrets";
import { runSqliteCheck } from "./sqlite-check";
import { runPtyCheck } from "./terminal";
import { resolveWorkbenchRoleResourcesDir } from "./workbench/role-resources";

/**
 * 冒烟自测模式（pnpm smoke → electron . --smoke），本任务的客观验收手段：
 * 1. 主进程直接验证 better-sqlite3 内存库查询（风险 R1）
 * 2. 主进程验证真实 safeStorage 密钥往返（W1.5b：store→reveal + maskedTail + delete）
 * 3. 主进程验证 PTY 加载并 spawn 拿到输出（T10.1）
 * 4. 创建隐藏窗口加载 renderer（URL 带 ?smoke=1；该模式下 renderer 只跑自检、
 *    **不挂载全功能 App**——本模式只装配下面那几个通道，挂上 App 会让默认页发起
 *    一个没有 handler 的页面级查询，见 renderer/src/main.tsx 的说明）
 * 5. renderer 依次执行：IPC ping-pong / app-info / 经 IPC 的 sqlite 检查 / 事件订阅 / CSP 拦截 eval
 * 6. renderer 经 smoke:report 上报，全部通过退出码 0，任一失败退出码 1；超时兜底退出码 1
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

  // T10.1：PTY 自检与 secrets 一样异步并行，结果在 finish 统一汇总
  const ptyCheck: Promise<SecretsCheckOutcome> = Promise.race([
    runPtyCheck().then(
      (report): SecretsCheckOutcome => ({
        ok: true,
        detail: `shell=${report.shell} marker=${report.marker}`,
      }),
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
      void finish(report, mainSqliteOk, secretsCheck, ptyCheck);
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
  ptyCheck: Promise<SecretsCheckOutcome>,
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
  const pty = await ptyCheck;
  const ptyLine = `[smoke] ${pty.ok ? "PASS" : "FAIL"} main-pty —— ${pty.detail}`;
  if (pty.ok) {
    console.log(ptyLine);
  } else {
    console.error(ptyLine);
  }
  const roleDir = resolveWorkbenchRoleResourcesDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const roleBase = join(roleDir, "base.md");
  const hookScript = app.isPackaged
    ? join(process.resourcesPath, "workbench-hook.mjs")
    : join(app.getAppPath(), "out", "main", "workbench-hook.mjs");
  const hookText = existsSync(hookScript) ? readFileSync(hookScript, "utf8") : "";
  const builderPath = join(app.getAppPath(), "electron-builder.yml");
  const builderText =
    !app.isPackaged && existsSync(builderPath) ? readFileSync(builderPath, "utf8") : "";
  const hookOutsideAsar = app.isPackaged
    ? existsSync(hookScript)
    : builderText.includes("to: workbench-hook.mjs") &&
      builderText.includes("!out/main/workbench-hook.mjs");
  const hookPlainNode =
    hookText.includes("agent-turn-complete") &&
    !hookText.includes("electron") &&
    !hookText.includes("cmd.exe");
  const hookOk = existsSync(hookScript) && hookOutsideAsar && hookPlainNode;
  const hookLine = `[smoke] ${hookOk ? "PASS" : "FAIL"} workbench-hook —— ${hookOk ? hookScript : "missing plain node script outside asar"}`;
  if (hookOk) {
    console.log(hookLine);
  } else {
    console.error(hookLine);
  }
  const roleOk = existsSync(roleBase);
  const roleLine = `[smoke] ${roleOk ? "PASS" : "FAIL"} role-manuals —— ${roleOk ? roleDir : `missing ${roleBase}`}`;
  if (roleOk) {
    console.log(roleLine);
  } else {
    console.error(roleLine);
  }
  const workbenchMcp = join(app.getAppPath(), "out", "main", "workbench-mcp.js");
  const workbenchMcpOk = existsSync(workbenchMcp);
  const workbenchMcpLine = `[smoke] ${workbenchMcpOk ? "PASS" : "FAIL"} workbench-mcp —— ${workbenchMcpOk ? workbenchMcp : "missing sidecar"}`;
  if (workbenchMcpOk) {
    console.log(workbenchMcpLine);
  } else {
    console.error(workbenchMcpLine);
  }
  const allOk =
    mainSqliteOk &&
    secrets.ok &&
    pty.ok &&
    roleOk &&
    hookOk &&
    workbenchMcpOk &&
    report.checks.length > 0 &&
    report.checks.every((c) => c.ok);
  if (allOk) {
    console.log(
      "[smoke] ALL PASS：IPC ping-pong、事件订阅、better-sqlite3、CSP、密钥往返、PTY、角色说明书、hook 脚本全部通过",
    );
  } else {
    console.error("[smoke] 存在失败项，退出码 1");
  }
  // 留出时间让 smoke:report 的响应送达 renderer，再带退出码退出
  setTimeout(() => app.exit(allOk ? 0 : 1), EXIT_DELAY_MS);
}
