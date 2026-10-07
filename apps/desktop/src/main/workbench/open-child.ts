/**
 * 管理者开子窗口（T10.7a）。
 * 顺序：确认本进程授予的管理者 → 权限封顶 → 窗口上限 → 先登记父级 → launch-cli → 放入布局。
 * 冷启动从布局读到的 manager 不能开窗口。
 */

import { randomUUID } from "node:crypto";
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
import { stripControls, WORKBENCH_ROLE_LABEL } from "./remind";
import type { LaunchCliRoute } from "./resolve-config";

export interface OpenChildArgs {
  readonly cli: "claude" | "codex" | "grok";
  readonly role: WorkbenchRole;
  readonly permission: WorkbenchPermissionLevel;
  readonly title: string;
  readonly briefPath?: string;
  readonly message?: string;
}

export interface OpenChildSuccess {
  readonly ok: true;
  readonly windowId: string;
  readonly title: string;
  readonly permission: WorkbenchPermissionLevel;
  readonly capped: boolean;
  readonly note?: string;
}

export interface OpenChildDeps {
  readonly authRegistry: WorkbenchAuthRegistry;
  readonly readLayouts: () => Promise<Readonly<Record<string, ProjectWorkbenchLayout>>>;
  readonly saveLayout: (layout: ProjectWorkbenchLayout) => Promise<void>;
  readonly launch: (input: LaunchCliWindowInput) => Promise<LaunchCliWindowResult>;
  readonly resolveRoute: (input: {
    readonly cli: "claude" | "codex" | "grok";
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
  if (args.cli !== "claude" && args.cli !== "codex" && args.cli !== "grok") {
    return { ok: false, error: "cli 只能是 claude、codex 或 grok。" };
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
    return route;
  }
  const layouts = await deps.readLayouts();
  const layout = layouts[described.projectId];
  if (layout === undefined || layout.windows[callerId] === undefined) {
    return { ok: false, error: "布局里没有这个管理者窗口。" };
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
      route: route.route,
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
    permission: effective,
    openedBy,
    parentWindowId: callerId,
    ...(launched.nativeSessionId !== undefined
      ? { nativeSessionId: launched.nativeSessionId }
      : {}),
    ...(actuallyCapped ? { permissionNeedsDowngrade: true } : {}),
  };
  const placed = placeOpenedWindow(layout, callerId, child, `tab-${randomUUID().slice(0, 12)}`);
  await deps.saveLayout(placed);
  deps.authRegistry.unpin(windowId);
  deps.publish({
    projectId: described.projectId,
    window: child,
    managerWindowId: callerId,
  });
  const note = actuallyCapped
    ? `请求权限 ${args.permission} 高于你的 ${callerPermission}，已封顶为 ${effective}。`
    : undefined;
  return {
    ok: true,
    windowId,
    title,
    permission: effective,
    capped: actuallyCapped,
    ...(note !== undefined ? { note } : {}),
  };
}
