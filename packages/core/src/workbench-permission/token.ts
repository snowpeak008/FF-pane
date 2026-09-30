/**
 * 工作台窗口身份令牌（T10.5）：高熵、仅主进程内存、不落盘。
 * 送达 CLI / MCP 子进程环境变量；禁止进 argv / 布局 / renderer。
 * 随机源用 Web Crypto（Node / Electron 均可用），避免 barrel 导出拖进浏览器包。
 */

/** CLI / MCP 进程环境变量名。 */
export const FF_PANE_WINDOW_TOKEN_ENV = "FF_PANE_WINDOW_TOKEN";

/** 控制通道管道名（hook 与 T10.7 sidecar 继承）。值只在进程环境里，不进配置明文。 */
export const FF_PANE_WB_PIPE_ENV = "FF_PANE_WB_PIPE";

/** 令牌字节数（≥32）。 */
export const WINDOW_TOKEN_BYTES = 32;

export interface WindowTokenRegistry {
  /** 为窗口签发令牌；同窗口重复签发则吊销旧令牌。 */
  issue(windowId: string): string;
  /** 按窗口吊销。 */
  revoke(windowId: string): void;
  /** 解析调用方；未知或已吊销 → null。 */
  resolveCaller(token: string): string | null;
  /** 当前登记数（单测）。 */
  size(): number;
  /** 清空。 */
  clear(): void;
}

/** 生成 hex 高熵令牌（默认 32 字节 → 64 hex 字符）。 */
export function generateWindowToken(bytes = WINDOW_TOKEN_BYTES): string {
  if (bytes < WINDOW_TOKEN_BYTES) {
    throw new Error(`window token must be at least ${WINDOW_TOKEN_BYTES} bytes`);
  }
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let hex = "";
  for (const byte of buf) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** 内存注册表 { token → windowId }。 */
export function createWindowTokenRegistry(): WindowTokenRegistry {
  const byToken = new Map<string, string>();
  const byWindow = new Map<string, string>();

  return {
    issue(windowId: string): string {
      const previous = byWindow.get(windowId);
      if (previous !== undefined) {
        byToken.delete(previous);
      }
      const token = generateWindowToken();
      byToken.set(token, windowId);
      byWindow.set(windowId, token);
      return token;
    },
    revoke(windowId: string): void {
      const token = byWindow.get(windowId);
      if (token === undefined) {
        return;
      }
      byWindow.delete(windowId);
      byToken.delete(token);
    },
    resolveCaller(token: string): string | null {
      if (token.trim() === "") {
        return null;
      }
      return byToken.get(token) ?? null;
    },
    size(): number {
      return byToken.size;
    },
    clear(): void {
      byToken.clear();
      byWindow.clear();
    },
  };
}

/** 最小内部校验：resolveCaller(token) → windowId | null。 */
export function resolveCaller(
  registry: WindowTokenRegistry,
  token: string | undefined | null,
): string | null {
  if (token === undefined || token === null) {
    return null;
  }
  return registry.resolveCaller(token);
}

/** Claude MCP 配置 env 中的占位符（官方 `${VAR}` 展开；文件不得含令牌明文）。 */
export const FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER = `\${${FF_PANE_WINDOW_TOKEN_ENV}}`;

/** Claude MCP 配置里的管道名占位符（由 CLI 从进程 env 展开）。 */
export const FF_PANE_WB_PIPE_ENV_PLACEHOLDER = `\${${FF_PANE_WB_PIPE_ENV}}`;

export type McpTokenDeliveryMode = "claude-env-expand" | "codex-forward";

type McpSpecLike = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly envVars?: readonly string[];
  readonly allowedTools?: readonly string[];
};

/**
 * 把令牌通道接到 MCP 规格（值永不进配置明文 / Codex `-c`）：
 * - claude-env-expand：临时 MCP JSON 只写 `${FF_PANE_WINDOW_TOKEN}`，由 CLI 从进程 env 展开
 * - codex-forward：仅 env_vars 白名单名（值在 CLI 父进程 env）
 */
export function injectTokenIntoMcpServers<T extends McpSpecLike>(
  servers: Readonly<Record<string, T>>,
  _token: string,
  mode: McpTokenDeliveryMode,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (mode === "claude-env-expand") {
      out[name] = {
        ...spec,
        env: {
          ...(spec.env ?? {}),
          [FF_PANE_WINDOW_TOKEN_ENV]: FF_PANE_WINDOW_TOKEN_ENV_PLACEHOLDER,
          [FF_PANE_WB_PIPE_ENV]: FF_PANE_WB_PIPE_ENV_PLACEHOLDER,
        },
      };
      continue;
    }
    const envVars = [
      ...new Set([...(spec.envVars ?? []), FF_PANE_WINDOW_TOKEN_ENV, FF_PANE_WB_PIPE_ENV]),
    ];
    const env = { ...(spec.env ?? {}) };
    delete (env as Record<string, string>)[FF_PANE_WINDOW_TOKEN_ENV];
    delete (env as Record<string, string>)[FF_PANE_WB_PIPE_ENV];
    out[name] = {
      ...spec,
      ...(Object.keys(env).length > 0 ? { env } : { env: undefined }),
      envVars,
    };
  }
  return out;
}
