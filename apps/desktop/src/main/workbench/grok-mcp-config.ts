/**
 * 把工作台 MCP 合并进项目 `.grok/config.toml`。
 * 只改本软件拥有的 `[mcp_servers.<name>]`，其余原文保留。
 * 令牌与信箱路径只写 `${VAR}`，由 Grok 在启动工具时从本进程环境展开。
 * 绝不写用户 `~/.grok`。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeTextAtomic } from "@ff-pane/storage";

export interface GrokMcpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const writeLocks = new Map<string, Promise<void>>();

export function grokProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".grok", "config.toml");
}

function pathIsUnder(candidate: string, root: string): boolean {
  const left = candidate.toLowerCase();
  const right = root.toLowerCase();
  return left === right || left.startsWith(right + sep);
}

/** 目标若落在用户 `~/.grok`（含符号链接）则拒绝。 */
export function assertNotUserGrokPath(target: string): void {
  const homeGrok = resolve(homedir(), ".grok");
  const candidates = [resolve(target)];
  if (existsSync(target)) {
    try {
      candidates.push(realpathSync(target));
    } catch {
      // 打不开就只看 resolve 结果
    }
  }
  const parent = dirname(target);
  if (existsSync(parent)) {
    try {
      candidates.push(resolve(realpathSync(parent), basename(target)));
    } catch {
      // 父目录打不开时不额外放行
    }
  }
  for (const candidate of candidates) {
    if (pathIsUnder(candidate, homeGrok)) {
      throw new Error("refusing to write user ~/.grok");
    }
  }
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\f/g, "\\f")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function serverNameFromHeader(header: string): string | undefined {
  const trimmed = header.trim();
  if (!trimmed.startsWith("mcp_servers.")) {
    return undefined;
  }
  const first = trimmed.slice("mcp_servers.".length).split(".")[0] ?? "";
  if (first.startsWith('"') && first.endsWith('"') && first.length >= 2) {
    return first.slice(1, -1);
  }
  return first;
}

function stripManagedTables(existing: string, managed: ReadonlySet<string>): string {
  const lines = existing.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const match = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      const name = serverNameFromHeader(match[1]);
      skipping = name !== undefined && managed.has(name);
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

/** 把服务器写成 Grok 项目配置里的 `[mcp_servers.*]`。 */
export function renderGrokMcpServers(servers: Readonly<Record<string, GrokMcpServerSpec>>): string {
  const blocks: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`invalid mcp server name: ${name}`);
    }
    const lines = [`[mcp_servers.${name}]`, `command = ${tomlString(spec.command)}`];
    if (spec.args !== undefined && spec.args.length > 0) {
      lines.push(`args = [${spec.args.map((arg) => tomlString(arg)).join(", ")}]`);
    }
    const env = spec.env ?? {};
    const keys = Object.keys(env);
    if (keys.length > 0) {
      const pairs = keys.map((key) => `${tomlKey(key)} = ${tomlString(env[key] ?? "")}`);
      lines.push(`env = { ${pairs.join(", ")} }`);
    }
    lines.push("enabled = true");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * 合并已有 toml。managedNames 里的服务器表会被拿掉再按 servers 重写；
 * 不在 servers 里的受管名字只删除，不补回。其它段落原样保留。
 */
export function mergeGrokProjectConfig(
  existing: string,
  servers: Readonly<Record<string, GrokMcpServerSpec>>,
  managedNames: readonly string[],
): string {
  const managed = new Set<string>([...managedNames, ...Object.keys(servers)]);
  const kept = stripManagedTables(existing, managed);
  const rendered = renderGrokMcpServers(servers);
  const body = kept.length === 0 ? rendered : `${kept}\n\n${rendered}`;
  return body.endsWith("\n") ? body : `${body}\n`;
}

async function withWriteLock(key: string, write: () => Promise<void>): Promise<void> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  writeLocks.set(key, tail);
  await previous;
  try {
    await write();
  } finally {
    release();
    if (writeLocks.get(key) === tail) {
      writeLocks.delete(key);
    }
  }
}

/** 读入项目里已有的 config.toml（没有则当空），合并后原子写回。 */
export async function writeGrokProjectMcpConfig(input: {
  readonly projectRoot: string;
  readonly servers: Readonly<Record<string, GrokMcpServerSpec>>;
  readonly managedNames: readonly string[];
}): Promise<string> {
  const filePath = grokProjectConfigPath(input.projectRoot);
  assertNotUserGrokPath(filePath);
  await withWriteLock(resolve(input.projectRoot), async () => {
    assertNotUserGrokPath(filePath);
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const next = mergeGrokProjectConfig(existing, input.servers, input.managedNames);
    await writeTextAtomic(filePath, next);
  });
  return filePath;
}
