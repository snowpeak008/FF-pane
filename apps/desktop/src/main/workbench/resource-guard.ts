/**
 * 开窗前的资源护栏（E2）：可用内存或磁盘低于阈值时不开新窗口。
 * 磁盘查项目所在盘和系统临时目录所在盘（备份、构建常写在那里）。
 */

import { statfs } from "node:fs/promises";
import { freemem, tmpdir } from "node:os";
import { parse } from "node:path";
import {
  clampResourceMb,
  DEFAULT_MIN_FREE_DISK_MB,
  DEFAULT_MIN_FREE_MEMORY_MB,
} from "@ff-pane/shared";

export interface ResourceLimits {
  /** 最少可用内存（字节），0 不检查。 */
  readonly memory: number;
  /** 最少可用磁盘（字节），0 不检查。 */
  readonly disk: number;
}

/** 按设置里的 MB 数换成字节门槛；没设就用默认。 */
export function resourceLimitsFromConfig(config: {
  readonly workbenchMinFreeMemoryMb?: number;
  readonly workbenchMinFreeDiskMb?: number;
}): ResourceLimits {
  return {
    memory:
      clampResourceMb(config.workbenchMinFreeMemoryMb, DEFAULT_MIN_FREE_MEMORY_MB) * 1024 * 1024,
    disk: clampResourceMb(config.workbenchMinFreeDiskMb, DEFAULT_MIN_FREE_DISK_MB) * 1024 * 1024,
  };
}

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
  limits: ResourceLimits,
): string | undefined {
  if (limits.memory > 0 && snapshot.freeMemoryBytes < limits.memory) {
    return `可用内存只剩 ${gb(snapshot.freeMemoryBytes)} GB，低于设置的 ${gb(limits.memory)} GB，没有开新窗口。先关掉不用的窗口或程序再开；门槛在设置的工作台窗口里调。`;
  }
  for (const [root, free] of Object.entries(snapshot.freeDiskBytes)) {
    if (limits.disk > 0 && free < limits.disk) {
      return `${root} 可用空间只剩 ${gb(free)} GB，低于设置的 ${gb(limits.disk)} GB，没有开新窗口。先清理磁盘再开；门槛在设置的工作台窗口里调。`;
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
