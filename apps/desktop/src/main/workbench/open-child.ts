/**
 * 管理者开子窗口（T10.7a）。
 * 顺序：确认本进程授予的管理者 → 权限封顶 → 窗口上限 → 先登记父级 → launch-cli → 放入布局。
 * 冷启动从布局读到的 manager 不能开窗口。
 */

import { randomUUID } from "node:crypto";
import { isDescendantOf } from "@ff-pane/core";
import {
  isWorkbenchPermissionLevel,
  isWorkbenchRole,
  minPermissionLevel,
  type ProjectId,
  type ProjectWorkbenchLayout,
  permissionLevelLte,
  type WorkbenchPermissionLevel,
  type WorkbenchRole,
  type WorkbenchWindow,
} from "@ff-pane/shared";
import { placeOpenedWindow } from "../../shared/workbench/place-child";
import type { WorkbenchAuthRegistry } from "./auth-registry";
import { resolveBriefPath } from "./brief-files";
import {
  type LaunchCliWindowInput,
  type LaunchCliWindowResult,
  MAX_INITIAL_PROMPT_CHARS,
} from "./launch-cli";
import { withModelEffortOverrides } from "./model-effort";
import { stripControls, WORKBENCH_ROLE_LABEL } from "./remind";
import type { LaunchCliRoute } from "./resolve-config";

export interface OpenChildArgs {
  readonly cli: "claude" | "codex" | "grok" | "deepseek";
  readonly role: WorkbenchRole;
  readonly permission: WorkbenchPermissionLevel;
  readonly title: string;
  readonly briefPath?: string;
  readonly message?: string;
  /** 挂上观察本窗口的监管者。必须是调用者的后代，角色是监管者。 */
  readonly supervisorWindowId?: string;
  /** 已校验的模型名。写进启动参数，也记在窗口上，以后重启照用。 */
  readonly model?: string;
  /** 已校验的思考强度。 */
  readonly reasoningEffort?: string;
}

export interface OpenChildSuccess {
  readonly ok: true;
  readonly windowId: string;
  readonly title: string;
  readonly permission: WorkbenchPermissionLevel;
  readonly capped: boolean;
  readonly note?: string;
  /** 实际写进启动参数的模型和强度。没有就是 CLI 读用户自己的配置。 */
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export interface OpenChildDeps {
  readonly authRegistry: WorkbenchAuthRegistry;
  readonly readLayouts: () => Promise<Readonly<Record<string, ProjectWorkbenchLayout>>>;
  readonly saveLayout: (layout: ProjectWorkbenchLayout) => Promise<void>;
  readonly launch: (input: LaunchCliWindowInput) => Promise<LaunchCliWindowResult>;
  readonly resolveRoute: (input: {
    readonly cli: "claude" | "codex" | "grok" | "deepseek";
    readonly projectId: string;
    readonly projectRoot: string;
  }) => Promise<
    | { readonly ok: true; readonly route: LaunchCliRoute }
    | { readonly ok: false; readonly error: string }
  >;
  readonly describeCaller: (windowId: string) => Promise<
    | {
        readonly title: string;
        readonly projectId: string;
        readonly projectRoot: string;
        readonly permission: WorkbenchPermissionLevel;
      }
    | undefined
  >;
  readonly aliveCount: () => number;
  readonly maxWindows: () => Promise<number>;
  /** 开窗前查内存和磁盘。不够时返回原因。 */
  readonly checkResources?: (projectRoot: string) => Promise<string | undefined>;
  readonly publish: (input: {
    readonly projectId: string;
    readonly window: WorkbenchWindow;
    readonly managerWindowId: string;
  }) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

function cleanTitle(title: string): string {
  const cleaned = stripControls(title).trim().slice(0, 80);
  return cleaned.length > 0 ? cleaned : "窗口";
}

function stripMessageControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += char;
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += char;
  }
  return out;
}

export function buildChildInitialPrompt(input: {
  readonly role: WorkbenchRole;
  readonly managerTitle: string;
  readonly briefPath?: string;
  readonly message?: string;
}): string {
  const role = WORKBENCH_ROLE_LABEL[input.role];
  const manager = cleanTitle(input.managerTitle);
  const read =
    input.briefPath !== undefined && input.briefPath.trim() !== ""
      ? `请先阅读任务说明 ${input.briefPath}，`
      : "";
  let text = `你是 ${role} 窗口，由 ${manager} 开启。${read}完成后用 ffpane_report 汇报。`;
  const extra = input.message !== undefined ? stripMessageControls(input.message).trim() : "";
  if (extra.length > 0) {
    text = `${text}\n${extra}`;
  }
  if (text.length > MAX_INITIAL_PROMPT_CHARS) {
    text = `${text.slice(0, MAX_INITIAL_PROMPT_CHARS - 20)}\n（消息已截断）`;
  }
  return text;
}

export async function openChildWindow(
  callerId: string,
  args: OpenChildArgs,
  deps: OpenChildDeps,
): Promise<OpenChildSuccess | { readonly ok: false; readonly error: string }> {
  const caller = deps.authRegistry.get(callerId);
  if (caller === undefined) {
    return { ok: false, error: "找不到调用窗口。" };
  }
  if (caller.role !== "manager" || !deps.authRegistry.isManagerGranted(callerId)) {
    return {
      ok: false,
      error:
        "只有管理者可以开窗口，而且必须是本进程里通过 ffpane_set_role 或界面确认过的管理者。从布局读到的管理者身份不能直接开窗口，请先调用 ffpane_set_role。",
    };
  }
  if (!isWorkbenchRole(args.role) || !isWorkbenchPermissionLevel(args.permission)) {
    return { ok: false, error: "角色或权限无效。" };
  }
  if (
    args.cli !== "claude" &&
    args.cli !== "codex" &&
    args.cli !== "grok" &&
    args.cli !== "deepseek"
  ) {
    return { ok: false, error: "cli 只能是 claude、codex、grok 或 deepseek。" };
  }
  const described = await deps.describeCaller(callerId);
  if (described === undefined) {
    return { ok: false, error: "找不到调用窗口所属的项目。" };
  }
  const callerPermission = caller.permission;
  const capped = !permissionLevelLte(args.permission, callerPermission);
  const permission = capped
    ? minPermissionLevel(args.permission, callerPermission)
    : args.permission;
  const max = await deps.maxWindows();
  if (deps.aliveCount() >= max) {
    return { ok: false, error: `已达到窗口上限（${max}）。` };
  }
  let briefRelative: string | undefined;
  if (args.briefPath !== undefined && args.briefPath.trim() !== "") {
    const brief = await resolveBriefPath(described.projectRoot, args.briefPath);
    if (!brief.ok) {
      return brief;
    }
    briefRelative = brief.relativePath;
  }
  const route = await deps.resolveRoute({
    cli: args.cli,
    projectId: described.projectId,
    projectRoot: described.projectRoot,
  });
  if (!route.ok) {
    return {
      ok: false,
      error: `${route.error}可以改用已经配好的 CLI 开窗，或请用户在设置里给这个配置补上这一路。不要反复重试。`,
    };
  }
  const layouts = await deps.readLayouts();
  const layout = layouts[described.projectId];
  if (layout === undefined || layout.windows[callerId] === undefined) {
    return { ok: false, error: "布局里没有这个管理者窗口。" };
  }
  let watcherWindowId: string | undefined;
  if (args.supervisorWindowId !== undefined && args.supervisorWindowId.trim() !== "") {
    const watcherId = args.supervisorWindowId.trim();
    const watcher = layout.windows[watcherId];
    const watcherNode = deps.authRegistry.get(watcherId);
    const role = watcherNode?.role ?? watcher?.role;
    if (
      watcher === undefined ||
      role !== "supervisor" ||
      !isDescendantOf(callerId, watcherId, deps.authRegistry.snapshot())
    ) {
      return {
        ok: false,
        error: "supervisorWindowId 必须是你开的、角色为监管者的窗口。",
      };
    }
    watcherWindowId = watcherId;
  } else if (args.role === "worker") {
    // 没指定时：管理者手下正好一个监管者，就挂到它下面，免得漏挂后状态提醒都绕过监管者。
    const supervisors = Object.values(layout.windows).filter(
      (window) =>
        window.parentWindowId === callerId &&
        (deps.authRegistry.get(window.id)?.role ?? window.role) === "supervisor",
    );
    if (supervisors.length === 1) {
      watcherWindowId = supervisors[0]?.id;
    }
  }
  const shortage = await deps.checkResources?.(described.projectRoot);
  if (shortage !== undefined) {
    return { ok: false, error: shortage };
  }
  const windowCount = Object.keys(layout.windows).length;
  if (windowCount >= max) {
    return { ok: false, error: `已达到窗口上限（${max}）。` };
  }

  const windowId = deps.newId?.() ?? `win-${randomUUID().slice(0, 12)}`;
  const title = cleanTitle(args.title);
  const openedBy = { windowId: callerId } as const;
  deps.authRegistry.pin(
    {
      id: windowId,
      permission,
      openedBy,
      parentWindowId: callerId,
      role: args.role,
    },
    described.projectId as ProjectId,
  );

  const prompt = buildChildInitialPrompt({
    role: args.role,
    managerTitle: described.title,
    ...(briefRelative !== undefined ? { briefPath: briefRelative } : {}),
    ...(args.message !== undefined ? { message: args.message } : {}),
  });

  let launched: LaunchCliWindowResult;
  try {
    launched = await deps.launch({
      windowId,
      projectId: described.projectId as LaunchCliWindowInput["projectId"],
      projectRoot: described.projectRoot,
      kind: args.cli,
      route: withModelEffortOverrides(route.route, {
        ...(args.model !== undefined ? { modelOverride: args.model } : {}),
        ...(args.reasoningEffort !== undefined ? { effortOverride: args.reasoningEffort } : {}),
      }),
      cols: 80,
      rows: 24,
      cwd: described.projectRoot,
      initialPrompt: prompt,
      permission,
      role: args.role,
    });
  } catch (thrown) {
    deps.authRegistry.unpin(windowId);
    deps.authRegistry.remove(windowId);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, error: `子窗口启动失败：${message}` };
  }

  const effective = launched.effectivePermission;
  const actuallyCapped = capped || launched.permissionCapped || effective !== args.permission;
  const child: WorkbenchWindow = {
    id: windowId,
    projectId: described.projectId as WorkbenchWindow["projectId"],
    title,
    kind: launched.kind,
    cwd: described.projectRoot,
    createdAt: deps.now?.() ?? Date.now(),
    terminalId: launched.terminal.id,
    role: args.role,
    routeMode: launched.connectionMode,
    ...(launched.providerName !== undefined ? { routeProviderName: launched.providerName } : {}),
    ...(launched.model !== undefined ? { routeModel: launched.model } : {}),
    ...(launched.reasoningEffort !== undefined ? { routeEffort: launched.reasoningEffort } : {}),
    ...(args.model !== undefined ? { modelOverride: args.model } : {}),
    ...(args.reasoningEffort !== undefined ? { effortOverride: args.reasoningEffort } : {}),
    permission: effective,
    openedBy,
    parentWindowId: callerId,
    ...(watcherWindowId !== undefined ? { watcherWindowId } : {}),
    ...(launched.nativeSessionId !== undefined
      ? { nativeSessionId: launched.nativeSessionId }
      : {}),
    ...(actuallyCapped ? { permissionNeedsDowngrade: true } : {}),
  };
  let placed = placeOpenedWindow(layout, callerId, child, `tab-${randomUUID().slice(0, 12)}`);
  // 新开监管者：自己名下还没有监管者（或原来那个已经关了）的执行、检查窗口改挂到它下面。
  // 否则换了监管者以后，旧执行的状态提醒全落到管理者身上。
  const adopted: string[] = [];
  if (args.role === "supervisor") {
    const windows = { ...placed.windows };
    for (const window of Object.values(placed.windows)) {
      const node = deps.authRegistry.get(window.id);
      const parentId = node?.parentWindowId ?? window.parentWindowId;
      const role = node?.role ?? window.role;
      const watcherAlive =
        window.watcherWindowId !== undefined &&
        placed.windows[window.watcherWindowId] !== undefined;
      if (
        window.id === windowId ||
        parentId !== callerId ||
        (role !== "worker" && role !== "reviewer") ||
        watcherAlive
      ) {
        continue;
      }
      windows[window.id] = { ...window, watcherWindowId: windowId };
      adopted.push(cleanTitle(window.title));
    }
    placed = { ...placed, windows };
  }
  await deps.saveLayout(placed);
  deps.authRegistry.unpin(windowId);
  deps.publish({
    projectId: described.projectId,
    window: child,
    managerWindowId: callerId,
  });
  const notes = [
    ...(actuallyCapped
      ? [`请求权限 ${args.permission} 高于你的 ${callerPermission}，已封顶为 ${effective}。`]
      : []),
    ...(watcherWindowId !== undefined
      ? [
          `已挂到监管者 ${cleanTitle(layout.windows[watcherWindowId]?.title ?? watcherWindowId)}（${watcherWindowId}）下。`,
        ]
      : args.role === "worker"
        ? ["没有挂监管者：状态提醒会直接发给你。"]
        : []),
    ...(adopted.length > 0
      ? [`原来没有监管者（或监管者已关闭）的 ${adopted.join("、")} 已改挂到它下面。`]
      : []),
  ];
  const note = notes.length > 0 ? notes.join("") : undefined;
  return {
    ok: true,
    windowId,
    title,
    permission: effective,
    capped: actuallyCapped,
    ...(note !== undefined ? { note } : {}),
    ...(launched.model !== undefined ? { model: launched.model } : {}),
    ...(launched.reasoningEffort !== undefined
      ? { reasoningEffort: launched.reasoningEffort }
      : {}),
  };
}
