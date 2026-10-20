/**
 * Codex 工作台会话识别：由 Codex 自己报编号，不去别处找。
 *
 * 每个 Codex 窗口启动时只给这一个进程装了 notify（`-c notify=[node, hook 脚本]`），
 * hook 带着这个窗口的令牌回报，主进程凭令牌认出是哪个窗口。Codex 每做完一轮调用一次 notify，
 * 事件 JSON 里的 `thread-id` 就是会话编号（codex-cli 0.162.0 实测，与 rollout 文件名里的编号一致）。
 *
 * 不扫描 CODEX_HOME/sessions，不读任何别的会话（包括用户在 Codex 桌面版等别处的会话）。
 * 第一轮做完之前没有编号：Codex 本来也是首条消息之后才落盘，此前没有可续接的对话。
 */

import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import process from "node:process";

/** Codex 会话编号（UUID）。只认这个形状，别的一律当成没报。 */
export const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isCodexThreadId(value: unknown): value is string {
  return typeof value === "string" && CODEX_THREAD_ID_PATTERN.test(value);
}

/** 是否处于自动化测试（仅认明确测试标记；不含生产可用的 FF_PANE_DATA_ROOT）。 */
export function isAutomatedTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["VITEST"] !== undefined && env["VITEST"] !== "") {
    return true;
  }
  return env["FF_PANE_E2E"] === "1";
}

/** 解析 CODEX_HOME（环境变量优先，否则 ~/.codex）。 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["CODEX_HOME"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return join(homedir(), ".codex");
}

/**
 * 判断路径是否落在用户真实 `~/.codex`（或其子路径）。
 * 用于测试隔离守卫。
 */
export function isRealUserCodexPath(candidate: string): boolean {
  const real = normalizeWorkbenchCwd(join(homedir(), ".codex"));
  const pathNorm = normalizeWorkbenchCwd(candidate);
  return (
    pathNorm === real || pathNorm.startsWith(`${real}${sep}`) || pathNorm.startsWith(`${real}/`)
  );
}

/**
 * 测试环境下若 CODEX_HOME 解析到真实用户 ~/.codex 则抛错。
 * 生产环境无操作。
 */
export function assertTestCodexHomeIsolated(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isAutomatedTestEnv(env)) {
    return;
  }
  if (isRealUserCodexPath(codexHome) || isRealUserCodexPath(join(codexHome, "sessions"))) {
    throw new Error(
      `test isolation violated: CODEX_HOME resolves under real user ~/.codex (${codexHome})`,
    );
  }
}

/** 路径规范化：绝对化、去尾部分隔符、Windows 大小写不敏感比较用。 */
export function normalizeWorkbenchCwd(cwd: string): string {
  let resolved = normalize(resolve(cwd.trim()));
  if (resolved.length > 1 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function cwdEquals(a: string, b: string): boolean {
  return normalizeWorkbenchCwd(a) === normalizeWorkbenchCwd(b);
}

export interface CodexClaimRequest {
  readonly windowId: string;
}

/**
 * 等这个窗口的 Codex 报出会话编号。
 * 新开的 Codex 窗口调用 start；hook 收到本窗口 notify 里的 thread-id 时调用 noteThreadId。
 * 没有超时：用户迟迟不发第一条消息时，本来就没有可续接的对话，不该标成「未识别」。
 */
export class CodexSessionClaimer {
  private readonly pending = new Map<string, (id: string | undefined) => void>();

  start(request: CodexClaimRequest): Promise<string | undefined> {
    this.cancel(request.windowId);
    return new Promise((resolvePromise) => {
      this.pending.set(request.windowId, resolvePromise);
    });
  }

  /** 本窗口报来了编号。有在等的就交给它并返回 true。 */
  noteThreadId(windowId: string, threadId: string): boolean {
    const resolvePending = this.pending.get(windowId);
    if (resolvePending === undefined || !isCodexThreadId(threadId)) {
      return false;
    }
    this.pending.delete(windowId);
    resolvePending(threadId);
    return true;
  }

  isWaiting(windowId: string): boolean {
    return this.pending.has(windowId);
  }

  /** 窗口退出或重启：不再等，交回 undefined。 */
  cancel(windowId: string): void {
    const resolvePending = this.pending.get(windowId);
    if (resolvePending === undefined) {
      return;
    }
    this.pending.delete(windowId);
    resolvePending(undefined);
  }

  dispose(): void {
    for (const windowId of [...this.pending.keys()]) {
      this.cancel(windowId);
    }
  }
}
