/**
 * Provider.proxy 的消费点（设计文档 §4.1 的 proxy 字段）：把用户配置的代理地址
 * 变成一个带出口的 fetch，交给 core 的连接探测 / 模型拉取使用。
 *
 * 为什么落在主进程而不是 core：core 的 provider-probe 明确不依赖 Electron，也不该
 * 认识 undici——代理是**网络出口**这一宿主侧关切。core 只留了 ProbeFetch 函数接缝
 * （见 packages/core/src/provider-probe/types.ts），本模块是它在桌面端的唯一实现。
 *
 * 为什么用 undici 的 ProxyAgent 而不是别的：Node 24 的全局 fetch 本身就是 undici，
 * 且 RequestInit 支持 `dispatcher` 逐请求换出口——但 Node 并未导出 ProxyAgent
 * （没有 node:undici 这样的内置模块），要构造代理调度器只能显式依赖 undici 包。
 * 相比"自己用 node:http 手写 CONNECT 隧道"，显式依赖是侵入更小、也更不容易出错的
 * 一条：ProxyAgent 对 http 与 https 目标统一走 CONNECT 隧道，TLS 仍与目标站点直连，
 * 我们不碰证书链。全局 setGlobalDispatcher 一律不用——那会把一个 Provider 的代理
 * 强加给全进程的所有请求。
 *
 * 范围（本单只做这一路）：连接探测与 /models 拉取。Agent CLI 子进程的代理走它们
 * 各自的环境变量（用户 shell 已有，见 process/env.ts 的清洗规则不含代理类变量）；
 * 嵌入管道（rag）的代理消费不在本单范围内。
 *
 * 密钥纪律：本模块不写任何日志；代理地址若带 user:pass 凭据，回给界面的错误文案
 * 一律经 redactProxyCredentials 抹掉凭据段（Authorization 头的处置照旧在 core）。
 */

import type { ProbeFailure, ProbeFetch } from "@ff-pane/core";
import { ProxyAgent } from "undici";

/** 代理地址示例，进错误文案帮用户对格式。 */
const PROXY_URL_EXAMPLE = "http://127.0.0.1:7890";

/** URL 里的 `//user:pass@` 凭据段。对不合法的 URL 串同样有效（正则不依赖解析成功）。 */
const PROXY_CREDENTIALS_PATTERN = /\/\/[^/@\s]*@/g;

/**
 * 抹掉 URL 串里的凭据段。用户自己填的地址原样回显本无泄密之虞，但错误文案会被
 * 复制进反馈与截图，凭据不该跟着走。
 */
export function redactProxyCredentials(text: string): string {
  return text.replace(PROXY_CREDENTIALS_PATTERN, "//***@");
}

/**
 * 探测出口的解析结果：
 * - 未配代理 → ok 且 fetchImpl 缺席，探测走全局 fetch（与接入代理前逐字节同行为）；
 * - 配了合法代理 → ok 且带 fetchImpl 与 dispose（调用方用完必须 dispose，否则
 *   ProxyAgent 的 keep-alive 连接会随每次"测试连接"点击累积）；
 * - 代理地址非法 → 走既有探测错误通道（ProbeFailure / invalid-config），不抛异常。
 */
export type ProbeOutlet =
  | {
      readonly ok: true;
      readonly fetchImpl?: ProbeFetch;
      readonly dispose?: () => Promise<void>;
    }
  | { readonly ok: false; readonly failure: ProbeFailure };

function invalidProxy(rawError: string): ProbeOutlet {
  return { ok: false, failure: { ok: false, stage: "invalid-config", rawError } };
}

/**
 * 由 Provider.proxy 解析出探测用的网络出口。
 * 空串 / 全空白 / 未配一律视为未配（直连）——设置页把输入框留空就是这个意思。
 */
export function resolveProbeOutlet(proxy: string | undefined): ProbeOutlet {
  const raw = proxy?.trim() ?? "";
  if (raw === "") {
    return { ok: true };
  }
  const shown = redactProxyCredentials(raw);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidProxy(`代理地址不是合法 URL：${shown}（格式如 ${PROXY_URL_EXAMPLE}）`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidProxy(
      `代理地址必须是 http/https 形式：${shown}（格式如 ${PROXY_URL_EXAMPLE}；` +
        `socks 代理暂不支持，可改用本地 http 代理入口）`,
    );
  }

  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalidProxy(`代理地址无法使用：${shown}\n${redactProxyCredentials(detail)}`);
  }

  return {
    ok: true,
    fetchImpl: (url, init) => fetch(url, withDispatcher(init, agent)),
    dispose: () => agent.close(),
  };
}

/**
 * 逐请求换出口：`dispatcher` 是 undici 对 RequestInit 的扩展，Node 24 的全局 fetch
 * （其本体就是内置 undici）会读它。
 *
 * 这里必须断言一次：@types/node 的 `RequestInit.dispatcher` 取的是**内置**
 * undici-types 的 Dispatcher，而 ProxyAgent 来自独立安装的 undici 包——两套同形声明
 * 各自演进（如 onBodySent 的签名已漂移），编译器不认它们是一回事。运行期则是鸭子
 * 类型：fetch 只会调 dispatcher.dispatch。断言的正确性由本模块单测用真实代理服务器
 * 钉住——两侧真漂移到不兼容，测试会立刻红，而不是等到用户点"测试连接"。
 */
function withDispatcher(init: RequestInit, agent: ProxyAgent): RequestInit {
  return { ...init, dispatcher: agent } as unknown as RequestInit;
}
