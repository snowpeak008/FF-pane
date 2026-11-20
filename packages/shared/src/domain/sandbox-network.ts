/**
 * Claude 沙盒里命令能连的域名（T11.20，Tony 2026-11-21 定）。
 * Claude 的 Windows 沙盒（sandbox-runtime）不认「全部放行」，只能列名单；名单外的直接拒，不弹问。
 * 写法跟着 sandbox-runtime：`example.com`、`*.example.com`、可带 `:端口`；不认 `*`、`*.com` 这类太宽的。
 */

/** 默认名单：装包、拉代码够用。项目卡片里可以再加。 */
export const DEFAULT_SANDBOX_NETWORK_DOMAINS: readonly string[] = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const PORT = /^[0-9]{1,5}$/;

/**
 * 能不能写进名单。和 sandbox-runtime 的校验对齐（实测它拒 `*` 和 `*.com`）：
 * 至少两段；`*.` 开头时后面至少还要两段；端口 1–65535。IP、IPv6 不收（用不上，也容易写错）。
 */
export function isValidSandboxDomain(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "") {
    return false;
  }
  const colon = value.lastIndexOf(":");
  const host = colon >= 0 ? value.slice(0, colon) : value;
  if (colon >= 0) {
    const port = value.slice(colon + 1);
    if (!PORT.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return false;
    }
  }
  const wildcard = host.startsWith("*.");
  const labels = (wildcard ? host.slice(2) : host).split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return false;
  }
  // 最后一段不能全是数字（那是 IP）
  return !/^[0-9]+$/.test(labels[labels.length - 1] ?? "");
}

/** 去空、去重（不分大小写）、转小写；不合法的单独返回，给界面报错用。 */
export function cleanSandboxDomains(domains: readonly string[]): {
  readonly domains: readonly string[];
  readonly invalid: readonly string[];
} {
  const seen = new Set<string>();
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of domains) {
    const value = raw.trim().toLowerCase();
    if (value === "") {
      continue;
    }
    if (!isValidSandboxDomain(value)) {
      invalid.push(raw.trim());
      continue;
    }
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return { domains: out, invalid };
}

/** 窗口实际用的名单：默认名单加项目加的，去重。 */
export function sandboxNetworkDomainsFor(extra: readonly string[] | undefined): readonly string[] {
  return cleanSandboxDomains([...DEFAULT_SANDBOX_NETWORK_DOMAINS, ...(extra ?? [])]).domains;
}
