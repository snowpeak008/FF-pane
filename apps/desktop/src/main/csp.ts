import type { Session } from "electron";

/**
 * CSP 基线（技术选型 §2 安全模型 / 开发计划 T0.2）。
 * 经 onHeadersReceived 注入响应头，对开发模式（vite dev server, http）
 * 与生产模式（loadFile, file://）统一生效。
 *
 * 生产策略：脚本仅同源、禁 eval、禁内联脚本；style 放行内联（vite 注入样式所需）。
 * 开发策略：额外放行内联脚本（@vitejs/plugin-react 的 HMR preamble）与本地 ws/http（vite HMR）。
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function installCsp(session: Session, isDev: boolean): void {
  const policy = isDev ? DEV_CSP : PROD_CSP;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}
