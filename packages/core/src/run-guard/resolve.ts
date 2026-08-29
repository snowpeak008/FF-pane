/**
 * 运行时路径解析（W2.7a）：把 Runtime 事件给出的路径折算为"项目内比较键"。
 *
 * 为什么需要这一步：W1.4c 的 normalizePathKey 只认相对项目根的路径，绝对路径
 * 一律判为项目外（信封只表达项目内作用域）；而四家 Runtime 的文件事件多给
 * 绝对路径（adapters 的 FileChangeEvent.path 注释明确把归一化留给权限层）。
 * 本模块用 Run 的工作目录（约定即项目根）把绝对路径还原为相对路径，还原不了
 * 就是项目外——方向恒为宁窄勿宽。
 *
 * 归一化与 W1.4c 完全对齐：NFC → 反斜杠折算正斜杠 → 全小写 → 词法解析 "." / ".."
 * → 去尾斜杠。额外处理 Windows 实况：盘符根、UNC 根（//server/share）、
 * Win32 设备路径前缀（\\?\ 与 \\.\）。
 *
 * "前缀陷阱"是本模块的核心正确性要求：字符串前缀比较会把 D:\projext 误判为
 * D:\proj 的子路径，故一律按路径段逐段比较。
 */

import { normalizePathKey } from "../permission/index.js";

/** 绝对路径的结构化形态：根 + 逐段路径（均为小写比较键形态）。 */
interface AbsolutePath {
  /** 根标识："d:"（盘符）/ "//server/share"（UNC）/ "/"（POSIX 根）。 */
  readonly root: string;
  readonly segments: readonly string[];
}

/** 路径解析结果。 */
export type RunPathResolution =
  | { readonly inProject: true; readonly key: string }
  | { readonly inProject: false; readonly reason: string };

/** Win32 设备路径前缀 \\?\ 与 \\.\ 折算为正斜杠后的形态。 */
const WIN32_DEVICE_PREFIX = /^\/\/[?.]\//;

function lexicalSegments(rest: string): readonly string[] {
  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // 越过根按停在根处理（与文件系统一致：/.. 即 /）
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** 解析绝对路径；非绝对路径形态返回 null。 */
function parseAbsolutePath(rawPath: string): AbsolutePath | null {
  const slashed = rawPath.trim().normalize("NFC").replaceAll("\\", "/");
  const lowered = slashed.replace(WIN32_DEVICE_PREFIX, "").toLowerCase();
  if (/^[a-z]:(?:\/|$)/.test(lowered)) {
    return { root: lowered.slice(0, 2), segments: lexicalSegments(lowered.slice(2)) };
  }
  if (lowered.startsWith("//")) {
    const parts = lowered
      .slice(2)
      .split("/")
      .filter((part) => part !== "");
    const [server, share] = parts;
    if (server === undefined || share === undefined) {
      return null;
    }
    return { root: `//${server}/${share}`, segments: lexicalSegments(parts.slice(2).join("/")) };
  }
  if (lowered.startsWith("/")) {
    return { root: "/", segments: lexicalSegments(lowered) };
  }
  return null;
}

/** base 的路径段是否为 candidate 的前缀（逐段比较，规避前缀陷阱）。 */
function isSegmentPrefix(base: readonly string[], candidate: readonly string[]): boolean {
  return base.length <= candidate.length && base.every((seg, index) => seg === candidate[index]);
}

/**
 * 把路径折算为项目内比较键。
 *
 * - 相对路径：直接走 W1.4c 的 normalizePathKey（"~" 开头、逃逸项目根 → 项目外）；
 * - 绝对路径：需要 cwd（Run 工作目录 = 项目根）；根不同或不在 cwd 子树内 → 项目外；
 *   未提供 cwd 时一切绝对路径判为项目外（无法证明在项目内，宁窄勿宽）。
 *
 * 项目根自身的比较键为 ""（与 normalizePathKey 一致）。
 */
export function resolveRunPath(rawPath: string, cwd?: string): RunPathResolution {
  const absolute = parseAbsolutePath(rawPath);
  if (absolute === null) {
    const key = normalizePathKey(rawPath);
    if (key === null) {
      return {
        inProject: false,
        reason: `相对路径 ${JSON.stringify(rawPath)} 逃逸项目根或指向用户主目录（"~"）`,
      };
    }
    return { inProject: true, key };
  }
  if (cwd === undefined) {
    return {
      inProject: false,
      reason: `未提供 Run 工作目录（项目根），无法证明绝对路径 ${JSON.stringify(rawPath)} 在项目内`,
    };
  }
  const base = parseAbsolutePath(cwd);
  if (base === null) {
    return {
      inProject: false,
      reason: `Run 工作目录 ${JSON.stringify(cwd)} 不是绝对路径，无法作为项目根折算`,
    };
  }
  if (absolute.root !== base.root || !isSegmentPrefix(base.segments, absolute.segments)) {
    return {
      inProject: false,
      reason: `路径 ${JSON.stringify(rawPath)} 不在项目根 ${JSON.stringify(cwd)} 之内`,
    };
  }
  return { inProject: true, key: absolute.segments.slice(base.segments.length).join("/") };
}
