/**
 * OpenCode 路径归一化（W2.6）。
 *
 * 动机（docs/adapters/opencode.md §8.2 坑 3 实测）：同一次权限请求里三种路径
 * 形态并存——
 * - `permission.asked.properties.patterns[0]` = `Users\NAME\...\proj\hello.txt`
 *   （**无盘符**的反斜杠路径）；
 * - `permission.asked.properties.metadata.filepath` = `C:\Users\NAME\...\hello.txt`
 *   （绝对路径）；
 * - 工具 `state.input.filePath` = `hello.txt`（相对工作目录）。
 * 直接把 patterns 写进 PermissionRequestPayload.path，权限层（W2.7）的路径裁决
 * 就会把项目内的写入判成越界。故进事件前统一归一到"以 cwd 的根为根的绝对路径"。
 *
 * 实现刻意不用 node:path：本模块要在任意宿主平台上对 Windows 形态的路径给出
 * 同一答案（fixture 回放测试在 Linux CI 上也必须通过），而 node:path 的行为
 * 随运行平台切换。分隔符风格取自 cwd，不强行改写 Runtime 给出的形态。
 */

/** 路径的根与其余部分。root 为空串表示这是相对路径。 */
export interface PathRootSplit {
  /** `C:\`、`/`、`\\`（UNC）之一，或空串。 */
  readonly root: string;
  /** 去掉根之后的部分。 */
  readonly rest: string;
}

const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/** 切出路径的根。 */
export function splitPathRoot(path: string): PathRootSplit {
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    return { root: "\\\\", rest: path.slice(2) };
  }
  if (WINDOWS_DRIVE_ROOT.test(path)) {
    return { root: path.slice(0, 3), rest: path.slice(3) };
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    return { root: path.slice(0, 1), rest: path.slice(1) };
  }
  return { root: "", rest: path };
}

/** 是否为绝对路径（含 Windows 盘符与 UNC）。 */
export function isAbsolutePath(path: string): boolean {
  return splitPathRoot(path).root !== "";
}

function toSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== "");
}

/** 消解 `.` 与 `..`（`..` 越过根时被吃掉，与操作系统一致）。 */
function resolveSegments(segments: readonly string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

function separatorOf(path: string): "\\" | "/" {
  return path.includes("\\") ? "\\" : "/";
}

/** Windows 盘符与 UNC 根下的路径比较不区分大小写。 */
function isCaseInsensitiveRoot(root: string): boolean {
  return root === "\\\\" || WINDOWS_DRIVE_ROOT.test(root);
}

function formatPath(root: string, segments: readonly string[], separator: "\\" | "/"): string {
  const body = segments.join(separator);
  if (root === "") {
    return body;
  }
  if (root === "\\\\") {
    return `\\\\${body}`;
  }
  // `C:\` 已自带分隔符，`/` 亦然。
  return root + body;
}

function startsWithSegments(
  path: readonly string[],
  prefix: readonly string[],
  caseInsensitive: boolean,
): boolean {
  if (prefix.length === 0 || path.length < prefix.length) {
    return false;
  }
  return prefix.every((segment, index) => {
    const candidate = path[index] ?? "";
    return caseInsensitive
      ? candidate.toLowerCase() === segment.toLowerCase()
      : candidate === segment;
  });
}

/**
 * 把 OpenCode 给出的任意形态路径归一为绝对路径。
 *
 * 三条规则，按序命中：
 * 1. 已是绝对路径（`C:\...` / `/...` / `\\server\...`）→ 只消解 `.`/`..` 与重复
 *    分隔符，根与分隔符风格原样保留；
 * 2. 无盘符绝对路径（`Users\NAME\proj\a.txt`）且其前缀与 cwd 去根后一致 →
 *    补回 cwd 的根（`C:\`）。这是 permission.asked 的 patterns 形态；
 * 3. 其余一律视为相对 cwd 的路径（工具 input.filePath 形态）→ 与 cwd 拼接。
 *
 * cwd 本身不是绝对路径时（理论上不该发生）退化为规则 3 的字符串拼接，不抛异常：
 * 映射器在事件流中不允许因为一个字段而中断整条流。
 */
export function normalizeOpenCodePath(raw: string, cwd: string): string {
  const value = raw.trim();
  if (value === "") {
    return raw;
  }

  const rawSplit = splitPathRoot(value);
  if (rawSplit.root !== "") {
    return formatPath(
      rawSplit.root,
      resolveSegments(toSegments(rawSplit.rest)),
      separatorOf(rawSplit.root === "\\\\" ? "\\" : value),
    );
  }

  const cwdSplit = splitPathRoot(cwd);
  const cwdSegments = resolveSegments(toSegments(cwdSplit.rest));
  const separator = separatorOf(cwd);
  const valueSegments = toSegments(value);

  if (
    cwdSplit.root !== "" &&
    startsWithSegments(valueSegments, cwdSegments, isCaseInsensitiveRoot(cwdSplit.root))
  ) {
    return formatPath(cwdSplit.root, resolveSegments(valueSegments), separator);
  }

  return formatPath(cwdSplit.root, resolveSegments([...cwdSegments, ...valueSegments]), separator);
}

/**
 * 两个路径是否指向同一位置（用于 resume 绑定的 cwd 校验）。
 * Windows 根下不区分大小写，分隔符风格与末尾分隔符不参与比较。
 */
export function isSamePath(left: string, right: string): boolean {
  const a = splitPathRoot(left);
  const b = splitPathRoot(right);
  const caseInsensitive = isCaseInsensitiveRoot(a.root) || isCaseInsensitiveRoot(b.root);
  const normalizeRoot = (root: string): string =>
    caseInsensitive ? root.toLowerCase().replace(/\//g, "\\") : root;
  if (normalizeRoot(a.root) !== normalizeRoot(b.root)) {
    return false;
  }
  const aSegments = resolveSegments(toSegments(a.rest));
  const bSegments = resolveSegments(toSegments(b.rest));
  if (aSegments.length !== bSegments.length) {
    return false;
  }
  return aSegments.every((segment, index) => {
    const other = bSegments[index] ?? "";
    return caseInsensitive ? segment.toLowerCase() === other.toLowerCase() : segment === other;
  });
}
