/**
 * 路径作用域纯函数（W1.4c）：归一化、匹配、包含判定与交集。
 *
 * ## 归一化约定（比较键，storage 层须与此对齐）
 * 信封中的路径条目与被裁决的具体路径，都先折算为"比较键"再参与任何比较：
 * 1. Unicode NFC 归一（同一路径的组合/分解编码形态视为相同）；
 * 2. 反斜杠一律折算为正斜杠；
 * 3. 全小写（Windows 文件系统大小写不敏感）；
 * 4. 丢弃空段与 "."，词法解析 ".."，去除尾斜杠；
 * 5. 一切路径相对项目根：绝对路径（盘符 / UNC / 以 "/" 或 "\" 开头）、
 *    "~" 开头、解析后逃逸项目根的路径不属于项目内 → 比较键为 null。
 * 原始字符串仅供展示层使用；比较与持久化一律用比较键。
 *
 * ## 作用域语义（信封 readPaths / writePaths 的条目）
 * - 无通配符条目（如 "src/auth"）＝该路径自身及其整个子树（目录作用域）；
 * - 尾部 "/**" 与裸 "**" 同为子树语义（"**" ＝ 项目内全部，§7 的"项目内"）；
 * - 其余含 "*" / "?" 的条目为 glob："*" / "?" 不跨路径段，"**" 段匹配任意层级；
 * - 空数组＝无该项权限；含 ".." 或项目外形态的条目视为无效，不贡献任何权限
 *   （宁窄勿宽）。
 *
 * ## 交集语义（设计文档 §7 / §29：结果必须 ⊆ 每个输入）
 * 两个作用域的"交"取可证明的更窄者：子树×子树看祖先关系；glob 的全部匹配
 * 必然落在其静态前缀（首个通配段之前的字面段）之下，借此对"glob ⊆ 子树"
 * 给出充分条件；无法证明包含关系的组合按空交处理——只会更窄，绝不放宽。
 */

const WILDCARD_CHARS = /[*?]/;

/** 解析后的路径作用域。subtree＝路径自身及整个子树；glob＝逐段通配模式。 */
export type PathScope =
  | { readonly kind: "subtree"; readonly base: string }
  | {
      readonly kind: "glob";
      readonly segments: readonly string[];
      /** 首个通配段之前的字面段（比较键形态）；glob 的全部匹配都在其子树内。 */
      readonly staticPrefix: string;
    };

/** 项目外形态：绝对路径（盘符 / UNC / 根斜杠开头）或 "~" 开头。 */
function isNonProjectPath(path: string): boolean {
  return (
    /^[a-z]:([\\/]|$)/i.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\")
  );
}

/**
 * 把具体路径折算为项目内比较键（见文件头约定）；项目外 / 逃逸项目根 → null。
 * 项目根自身的比较键为 ""。
 */
export function normalizePathKey(rawPath: string): string | null {
  const trimmed = rawPath.trim().normalize("NFC");
  if (isNonProjectPath(trimmed)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of trimmed.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  return segments.join("/");
}

/**
 * 解析信封路径条目为作用域。无效条目（项目外形态或含 ".."）→ null，
 * 调用方应视其为"不贡献任何权限"。
 */
export function parsePathScope(rawPattern: string): PathScope | null {
  const trimmed = rawPattern.trim().normalize("NFC");
  if (isNonProjectPath(trimmed)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of trimmed.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment.toLowerCase());
  }
  const withoutTrailingGlobstars = [...segments];
  while (withoutTrailingGlobstars.at(-1) === "**") {
    withoutTrailingGlobstars.pop();
  }
  if (!withoutTrailingGlobstars.some((segment) => WILDCARD_CHARS.test(segment))) {
    return { kind: "subtree", base: withoutTrailingGlobstars.join("/") };
  }
  const staticPrefixSegments: string[] = [];
  for (const segment of segments) {
    if (WILDCARD_CHARS.test(segment)) {
      break;
    }
    staticPrefixSegments.push(segment);
  }
  return { kind: "glob", segments, staticPrefix: staticPrefixSegments.join("/") };
}

/** 作用域的规范字符串形态（子树渲染为裸路径，项目根子树渲染为 "**"）。 */
export function renderPathScope(scope: PathScope): string {
  if (scope.kind === "subtree") {
    return scope.base === "" ? "**" : scope.base;
  }
  return scope.segments.join("/");
}

/** base 子树是否覆盖比较键 key（相等或为其祖先；base "" ＝ 项目根 ＝ 全部）。 */
function subtreeCovers(base: string, key: string): boolean {
  return base === "" || key === base || key.startsWith(`${base}/`);
}

function segmentToRegExp(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`);
}

function segmentMatches(patternSegment: string, pathSegment: string): boolean {
  if (!WILDCARD_CHARS.test(patternSegment)) {
    return patternSegment === pathSegment;
  }
  return segmentToRegExp(patternSegment).test(pathSegment);
}

function matchSegments(
  patternSegments: readonly string[],
  pathSegments: readonly string[],
): boolean {
  const [head, ...restPattern] = patternSegments;
  if (head === undefined) {
    return pathSegments.length === 0;
  }
  if (head === "**") {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (matchSegments(restPattern, pathSegments.slice(skip))) {
        return true;
      }
    }
    return false;
  }
  const [first, ...restPath] = pathSegments;
  if (first === undefined) {
    return false;
  }
  return segmentMatches(head, first) && matchSegments(restPattern, restPath);
}

/** 作用域是否覆盖某个比较键（key 必须已是 normalizePathKey 的产物）。 */
export function scopeMatchesKey(scope: PathScope, key: string): boolean {
  if (scope.kind === "subtree") {
    return subtreeCovers(scope.base, key);
  }
  return matchSegments(scope.segments, key === "" ? [] : key.split("/"));
}

/**
 * 充分条件判定：inner 的全部匹配是否必然落入 outer。
 * - outer 为子树：inner（子树取 base，glob 取静态前缀）落在 outer.base 子树内即可；
 * - outer 为 glob：仅当两者为同一 glob（规范形态相等）才可证明。
 * 无法证明时返回 false——交集因此只会变窄，不会放宽。
 */
export function scopeWithinScope(inner: PathScope, outer: PathScope): boolean {
  if (outer.kind === "subtree") {
    const innerFloor = inner.kind === "subtree" ? inner.base : inner.staticPrefix;
    return subtreeCovers(outer.base, innerFloor);
  }
  return inner.kind === "glob" && renderPathScope(inner) === renderPathScope(outer);
}

/** 具体路径是否被作用域列表放行（任一条目命中即放行；项目外路径一律 false）。 */
export function isPathAllowedByScopes(scopes: readonly string[], path: string): boolean {
  const key = normalizePathKey(path);
  if (key === null) {
    return false;
  }
  return scopes.some((raw) => {
    const scope = parsePathScope(raw);
    return scope !== null && scopeMatchesKey(scope, key);
  });
}

/**
 * 模式（可含通配符）的全部可能匹配是否必然落入作用域列表之一。
 * 充分条件判定：无法证明 → false（宁严勿松），供删除命令目标分析等场景使用。
 */
export function isPatternCoveredByScopes(scopes: readonly string[], pattern: string): boolean {
  const inner = parsePathScope(pattern);
  if (inner === null) {
    return false;
  }
  return scopes.some((raw) => {
    const outer = parsePathScope(raw);
    return outer !== null && scopeWithinScope(inner, outer);
  });
}

function parseScopeList(scopes: readonly string[]): readonly PathScope[] {
  const parsed: PathScope[] = [];
  for (const raw of scopes) {
    const scope = parsePathScope(raw);
    if (scope !== null) {
      parsed.push(scope);
    }
  }
  return parsed;
}

/** 去重并剔除被同伴覆盖的冗余项（列表为"或"语义，被覆盖者多余）。 */
function pruneScopes(scopes: readonly PathScope[]): readonly PathScope[] {
  let kept: PathScope[] = [];
  for (const candidate of scopes) {
    if (kept.some((existing) => scopeWithinScope(candidate, existing))) {
      continue;
    }
    kept = kept.filter((existing) => !scopeWithinScope(existing, candidate));
    kept.push(candidate);
  }
  return kept;
}

/**
 * 两个作用域列表的交集（设计文档 §7 / §29）。
 * 逐对取可证明的更窄者，无法证明包含关系的组合按空交处理；
 * 结果以规范字符串形态返回，保证对任意路径 p：
 * 结果放行 p ⇒ a 放行 p 且 b 放行 p。
 */
export function intersectScopeLists(a: readonly string[], b: readonly string[]): readonly string[] {
  const scopesA = parseScopeList(a);
  const scopesB = parseScopeList(b);
  const picked: PathScope[] = [];
  for (const scopeA of scopesA) {
    for (const scopeB of scopesB) {
      if (scopeWithinScope(scopeA, scopeB)) {
        picked.push(scopeA);
      } else if (scopeWithinScope(scopeB, scopeA)) {
        picked.push(scopeB);
      }
    }
  }
  return pruneScopes(picked).map(renderPathScope);
}
