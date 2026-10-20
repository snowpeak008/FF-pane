/**
 * 开窗前的资源护栏（E2）：可用内存或磁盘低于阈值时不开新窗口。
 * 磁盘查项目所在盘和系统临时目录所在盘（备份、构建常写在那里）。
 */

import { statfs } from "node:fs/promises";
import { freemem, tmpdir } from "node:os";
import { parse } from "node:path";

export const MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3;
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;

export interface ResourceSnapshot {
  readonly freeMemoryBytes: number;
  /** 盘符或根 → 可用字节。查不到的盘不出现。 */
  readonly freeDiskBytes: Readonly<Record<string, number>>;
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** 不够时返回给模型看的原因，够了返回 undefined。 */
export function describeShortage(
  snapshot: ResourceSnapshot,
  limits: { readonly memory: number; readonly disk: number } = {
    memory: MIN_FREE_MEMORY_BYTES,
    disk: MIN_FREE_DISK_BYTES,
  },
): string | undefined {
  if (snapshot.freeMemoryBytes < limits.memory) {
    return `可用内存只剩 ${gb(snapshot.freeMemoryBytes)} GB，低于 ${gb(limits.memory)} GB，没有开新窗口。先关掉不用的窗口或程序，再开。`;
  }
  for (const [root, free] of Object.entries(snapshot.freeDiskBytes)) {
    if (free < limits.disk) {
      return `${root} 可用空间只剩 ${gb(free)} GB，低于 ${gb(limits.disk)} GB，没有开新窗口。先清理磁盘再开。`;
    }
  }
  return undefined;
}

export async function takeResourceSnapshot(projectRoot: string): Promise<ResourceSnapshot> {
  const roots = new Set([parse(projectRoot).root, parse(tmpdir()).root].filter((r) => r !== ""));
  const freeDiskBytes: Record<string, number> = {};
  for (const root of roots) {
    try {
      const st = await statfs(root);
      freeDiskBytes[root] = Number(st.bavail) * Number(st.bsize);
    } catch {
      // 查不到就不拦
    }
  }
  return { freeMemoryBytes: freemem(), freeDiskBytes };
}
