/**
 * 工作台 MCP 工具执行（T10.7a）。
 * 主进程用 resolveCaller 认出窗口后进入这里。
 * 授权只走 authorize / canSetRole / 本进程管理者授予，sidecar 不参与。
 */

import { randomUUID } from "node:crypto";
import {
  authorize,
  canSetRole,
  isDescendantOf,
  type WorkbenchAuthNode,
  walkAncestors,
} from "@ff-pane/core";
import {
  isWorkbenchRole,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryEntryId,
  type WorkbenchOpenedBy,
  type WorkbenchPermissionLevel,
  type WorkbenchRole,
} from "@ff-pane/shared";
import { resolveBriefPath, writeBriefFile, writeStatusFile } from "./brief-files";
import { type CloseDescendantDeps, closeDescendantWindow } from "./close-descendant";
import {
  canAddProjectMemory,
  codePointLength,
  MEMORY_ADD_BODY_MAX_CHARS,
  MEMORY_ADD_MIN_INTERVAL_MS,
  MEMORY_ADD_TITLE_MAX_CHARS,
  MEMORY_SEARCH_MAX_BYTES,
  MEMORY_SEARCH_MAX_HITS,
  MEMORY_SEARCH_QUERY_MAX_CHARS,
  packMemorySearchHits,
  reserveMemoryAdd,
  resetMemoryAddSlots,
  sanitizeMemoryBody,
  sanitizeMemoryTitle,
  sanitizeSourceWindowTitle,
} from "./memory-policy";
import type { OpenChildArgs, OpenChildSuccess } from "./open-child";
import { openChildWindow } from "./open-child";
import { clampReadOutputBytes, stripTerminalControls } from "./output-text";
import {
  buildCoalescedReminder,
  buildNewMessageReminder,
  isReportStatus,
  type ReportStatus,
  sanitizeThreadText,
} from "./remind";
import type { SetWindowRoleResult } from "./set-role";
import { gateSupervisorToManager } from "./status-handoff";
import {
  appendThreadRecord,
  assertProjectFiles,
  latestReportStatus,
  readThreadIndex,
  recordsAddressedTo,
  type ThreadRecord,
  teamAnchorId,
  teamFileSlug,
} from "./thread-store";

export const MESSAGE_MAX_BYTES = 8 * 1024;
export const TOOL_CALLS_PER_SECOND = 30;
export const OPEN_PANEL_MIN_INTERVAL_MS = 3000;
const PANEL_NAMES = ["plan", "tasks", "runs"] as const;
export type WorkbenchPanelName = (typeof PANEL_NAMES)[number];
const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT = 50;

export interface ToolTextResult {
  readonly text: string;
  readonly isError?: boolean;
}

export interface ToolWindowView {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly role: WorkbenchRole;
  readonly permission: WorkbenchPermissionLevel;
  readonly running: boolean;
  readonly parentWindowId?: string;
  readonly parentTitle?: string;
  /** 开启者。缺省按用户开启处理会放宽写入，所以调用方必须填上。 */
  readonly openedBy: WorkbenchOpenedBy;
  /** 冷启动清洗锁。锁住的窗口不能新增记忆。 */
  readonly sanitizeLocked: boolean;
}

export interface WorkbenchToolDeps {
  readonly now: () => number;
  readonly snapshot: () => Readonly<Record<string, WorkbenchAuthNode>>;
  readonly isManagerGranted: (windowId: string) => boolean;
  readonly describe: (windowId: string) => Promise<ToolWindowView | undefined>;
  readonly setRole: (
    callerId: string,
    targetId: string,
    role: WorkbenchRole,
  ) => Promise<SetWindowRoleResult>;
  readonly openChild: (
    callerId: string,
    args: OpenChildArgs,
  ) => Promise<OpenChildSuccess | { readonly ok: false; readonly error: string }>;
  readonly remind: (windowId: string, textForCount: (count: number) => string) => void;
  readonly publishInbox: (input: {
    readonly windowId: string;
    readonly unread?: number;
    readonly lastReportStatus?: ReportStatus;
  }) => void;
  readonly getCursor: (windowId: string) => Promise<string | undefined>;
  readonly setCursor: (windowId: string, lastReadId: string) => Promise<void>;
  readonly readOutput: (
    windowId: string,
    maxBytes: number,
  ) => Promise<{ readonly running: boolean; readonly status: string; readonly text?: string }>;
  readonly closeDescendant: CloseDescendantDeps;
  readonly openPanel: (panel: WorkbenchPanelName, openerTitle: string, projectId: string) => void;
  /** 只查传入的项目根。工具层不会把参数里的项目路径传进来。 */
  readonly searchProjectMemory: (
    projectRoot: string,
    query: string,
    limit: number,
  ) => Promise<readonly MemoryEntry[]>;
  readonly addProjectMemory: (projectRoot: string, entry: MemoryEntry) => Promise<void>;
  readonly setModelEffort: (input: {
    readonly callerId: string;
    readonly windowId: string;
    readonly model?: unknown;
    readonly reasoningEffort?: unknown;
  }) => Promise<
    { readonly ok: true; readonly message: string } | { readonly ok: false; readonly error: string }
  >;
}

const buckets = new Map<string, { t: number; n: number }>();
const panelOpenedAt = new Map<string, number>();

export function allowToolCall(windowId: string, now: number): boolean {
  const bucket = buckets.get(windowId);
  if (bucket === undefined || now - bucket.t >= 1000) {
    buckets.set(windowId, { t: now, n: 1 });
    return true;
  }
  bucket.n += 1;
  return bucket.n <= TOOL_CALLS_PER_SECOND;
}

export function allowOpenPanel(windowId: string, now: number): boolean {
  const previous = panelOpenedAt.get(windowId);
  if (previous !== undefined && now - previous < OPEN_PANEL_MIN_INTERVAL_MS) {
    return false;
  }
  panelOpenedAt.set(windowId, now);
  return true;
}

export function resetToolCallBuckets(): void {
  buckets.clear();
  panelOpenedAt.clear();
  resetMemoryAddSlots();
}

function fail(text: string): ToolTextResult {
  return { text, isError: true };
}

function ok(value: unknown): ToolTextResult {
  return { text: JSON.stringify(value) };
}

function tooLong(): ToolTextResult {
  return fail("正文超过 8KB。请改用 ffpane_write_brief 写说明，消息里只放路径。");
}

export function visibleWindowIds(
  callerId: string,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
): readonly string[] {
  const ids = new Set<string>([callerId]);
  const walk = walkAncestors(callerId, tree);
  if (!walk.cycle && !walk.truncated) {
    for (const id of walk.ids) {
      ids.add(id);
    }
  }
  for (const id of Object.keys(tree)) {
    if (isDescendantOf(callerId, id, tree)) {
      ids.add(id);
    }
  }
  return [...ids];
}

function inboxAfter(
  records: readonly ThreadRecord[],
  windowId: string,
  lastReadId: string | undefined,
): readonly ThreadRecord[] {
  return recordsAddressedTo(records, windowId, lastReadId);
}

export async function executeWorkbenchTool(
  callerId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  if (!allowToolCall(callerId, deps.now())) {
    return fail("调用过于频繁（每秒最多 30 次），请稍后再试。");
  }
  const caller = await deps.describe(callerId);
  if (caller === undefined) {
    return fail("找不到调用窗口。");
  }
  const tree = deps.snapshot();
  switch (name) {
    case "ffpane_whoami":
      return ok({
        windowId: caller.id,
        title: caller.title,
        role: caller.role,
        permission: caller.permission,
        parent:
          caller.parentWindowId !== undefined
            ? {
                windowId: caller.parentWindowId,
                title: caller.parentTitle ?? caller.parentWindowId,
              }
            : null,
        projectName: caller.projectName,
        projectRoot: caller.projectRoot,
      });
    case "ffpane_list_windows":
      return listWindows(caller, tree, deps);
    case "ffpane_set_role":
      return setRole(callerId, args, tree, deps);
    case "ffpane_write_brief":
      return writeBrief(caller, args);
    case "ffpane_write_status":
      return writeStatus(caller, args);
    case "ffpane_open_window":
      return openWindow(callerId, args, deps);
    case "ffpane_send_message":
      return sendMessage(caller, args, tree, deps);
    case "ffpane_report":
      return report(caller, args, tree, deps);
    case "ffpane_read_inbox":
      return readInbox(caller, args, deps);
    case "ffpane_read_output":
      return readOutput(caller, args, tree, deps);
    case "ffpane_close_window":
      return closeWindow(caller, args, tree, deps);
    case "ffpane_open_panel":
      return openPanel(caller, args, deps);
    case "ffpane_memory_search":
      return searchMemory(caller, args, deps);
    case "ffpane_memory_add":
      return addMemory(caller, args, deps);
    case "ffpane_set_model_effort":
      return setModelEffort(callerId, args, deps);
    default:
      return fail(`未知工具：${name}`);
  }
}

async function listWindows(
  caller: ToolWindowView,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const records = await readThreadIndex(caller.projectRoot);
  const windows = [];
  for (const id of visibleWindowIds(caller.id, tree)) {
    const view = id === caller.id ? caller : await deps.describe(id);
    if (view === undefined) {
      continue;
    }
    const status = latestReportStatus(records, id);
    windows.push({
      id: view.id,
      title: view.title,
      role: view.role,
      permission: view.permission,
      running: view.running,
      ...(status !== undefined ? { lastReportStatus: status } : {}),
      ...(view.parentWindowId !== undefined ? { parentWindowId: view.parentWindowId } : {}),
    });
  }
  return ok({ windows });
}

async function setRole(
  callerId: string,
  args: Readonly<Record<string, unknown>>,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const windowId = args["windowId"];
  const role = args["role"];
  if (typeof windowId !== "string" || windowId.trim() === "" || !isWorkbenchRole(role)) {
    return fail("ffpane_set_role 需要 windowId 和合法 role。");
  }
  const target = tree[windowId];
  const allowed = canSetRole(
    { kind: "window", windowId: callerId },
    {
      id: windowId,
      ...(target?.openedBy !== undefined ? { openedBy: target.openedBy } : {}),
      ...(target?.parentWindowId !== undefined ? { parentWindowId: target.parentWindowId } : {}),
    },
    role,
    tree,
  );
  if (!allowed) {
    return fail("不能设定这个窗口的角色。");
  }
  const result = await deps.setRole(callerId, windowId, role);
  if (!result.ok) {
    return fail(result.reason === "forbidden" ? "不能设定这个窗口的角色。" : "设定角色失败。");
  }
  return ok({ ok: true, windowId, role: result.role });
}

async function writeBrief(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolTextResult> {
  const name = args["name"];
  const content = args["content"];
  if (typeof name !== "string" || typeof content !== "string") {
    return fail("ffpane_write_brief 需要 name 和 content。");
  }
  const written = await writeBriefFile({
    projectRoot: caller.projectRoot,
    name,
    content,
  });
  if (!written.ok) {
    return fail(written.error);
  }
  return ok({ relativePath: written.relativePath, absolutePath: written.absolutePath });
}

async function writeStatus(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolTextResult> {
  const name = args["name"];
  const content = args["content"];
  if (typeof name !== "string" || typeof content !== "string") {
    return fail("ffpane_write_status 需要 name 和 content。");
  }
  const written = await writeStatusFile({
    projectRoot: caller.projectRoot,
    name,
    content,
  });
  if (!written.ok) {
    return fail(written.error);
  }
  return ok({ relativePath: written.relativePath, absolutePath: written.absolutePath });
}

async function openWindow(
  callerId: string,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const cli = args["cli"];
  const role = args["role"];
  const permission = args["permission"];
  const title = args["title"];
  if (cli !== "claude" && cli !== "codex" && cli !== "grok" && cli !== "deepseek") {
    return fail("cli 只能是 claude、codex、grok 或 deepseek。");
  }
  if (!isWorkbenchRole(role) || typeof permission !== "string" || typeof title !== "string") {
    return fail("ffpane_open_window 需要 cli、role、permission 和 title。");
  }
  if (
    permission !== "read-only" &&
    permission !== "edit" &&
    permission !== "edit-exec" &&
    permission !== "yolo"
  ) {
    return fail("权限无效。");
  }
  const opened = await deps.openChild(callerId, {
    cli,
    role,
    permission,
    title,
    ...(typeof args["briefPath"] === "string" ? { briefPath: args["briefPath"] } : {}),
    ...(typeof args["message"] === "string" ? { message: args["message"] } : {}),
  });
  if (!opened.ok) {
    return fail(opened.error);
  }
  return ok({
    windowId: opened.windowId,
    title: opened.title,
    permission: opened.permission,
    capped: opened.capped,
    ...(opened.note !== undefined ? { note: opened.note } : {}),
  });
}

async function sendMessage(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const targetId = args["windowId"];
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return fail("ffpane_send_message 需要 windowId。");
  }
  const decision = authorize({
    actor: { kind: "window", windowId: caller.id },
    action: "send-message",
    targetWindowId: targetId,
    tree,
  });
  if (!decision.ok) {
    return fail("只能给自己的后代发消息。");
  }
  const text = typeof args["text"] === "string" ? args["text"] : "";
  const briefRaw = typeof args["briefPath"] === "string" ? args["briefPath"] : undefined;
  if (text.trim() === "" && (briefRaw === undefined || briefRaw.trim() === "")) {
    return fail("消息需要 text 或 briefPath。");
  }
  if (Buffer.byteLength(text, "utf8") > MESSAGE_MAX_BYTES) {
    return tooLong();
  }
  const brief = await optionalBrief(caller.projectRoot, briefRaw);
  if (!brief.ok) {
    return fail(brief.error);
  }
  const detailRaw = typeof args["detailPath"] === "string" ? args["detailPath"] : undefined;
  const detail = await optionalBrief(caller.projectRoot, detailRaw);
  if (!detail.ok) {
    return fail(detail.error);
  }
  const target = await deps.describe(targetId);
  if (target === undefined) {
    return fail("找不到目标窗口。");
  }
  const gated = gateSupervisorToManager({
    callerRole: caller.role,
    targetRole: target.role,
    ...(brief.path !== undefined ? { statusPath: brief.path } : {}),
    ...(detail.path !== undefined ? { detailPath: detail.path } : {}),
    statusText: text,
  });
  if (!gated.ok) {
    return fail(gated.error);
  }
  if (gated.kind === "silent") {
    return ok({ delivered: false, reason: "近况四行不齐，未叫醒管理者。" });
  }
  const deliveredText = gated.kind === "wake" ? gated.text : text;
  const deliveredBrief = gated.kind === "wake" ? gated.statusPath : brief.path;
  const record = await persist(
    caller,
    target,
    {
      kind: "message",
      text: deliveredText,
      ...(deliveredBrief !== undefined ? { briefPath: deliveredBrief } : {}),
    },
    tree,
    deps,
  );
  remindTarget(target, caller, "message", undefined, deps);
  await publishUnread(target, deps);
  return ok({ id: record.id, threadFile: record.threadFile });
}

async function report(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const status = args["status"];
  if (!isReportStatus(status)) {
    return fail("status 只能是 done、blocked、failed 或 progress。");
  }
  const summary = args["summary"];
  if (typeof summary !== "string" || summary.trim() === "") {
    return fail("ffpane_report 需要 summary。");
  }
  if (Buffer.byteLength(summary, "utf8") > MESSAGE_MAX_BYTES) {
    return tooLong();
  }
  const node = tree[caller.id];
  const explicit = args["windowId"];
  const targetId =
    typeof explicit === "string" && explicit.trim() !== "" ? explicit : node?.parentWindowId;
  if (targetId === undefined || targetId.trim() === "") {
    return fail("没有上级可以汇报。");
  }
  const decision = authorize({
    actor: { kind: "window", windowId: caller.id },
    action: "report",
    targetWindowId: targetId,
    tree,
  });
  if (!decision.ok) {
    return fail("只能向上级链汇报。");
  }
  const filesRaw = args["files"];
  let files: readonly string[] | undefined;
  if (filesRaw !== undefined) {
    if (!Array.isArray(filesRaw) || filesRaw.some((item) => typeof item !== "string")) {
      return fail("files 必须是字符串数组。");
    }
    const checked = await assertProjectFiles(caller.projectRoot, filesRaw);
    if (!checked.ok) {
      return fail(checked.error);
    }
    files = checked.files;
  }
  const briefRaw = typeof args["briefPath"] === "string" ? args["briefPath"] : undefined;
  const brief = await optionalBrief(caller.projectRoot, briefRaw);
  if (!brief.ok) {
    return fail(brief.error);
  }
  const detailRaw = typeof args["detailPath"] === "string" ? args["detailPath"] : undefined;
  const detail = await optionalBrief(caller.projectRoot, detailRaw);
  if (!detail.ok) {
    return fail(detail.error);
  }
  const target = await deps.describe(targetId);
  if (target === undefined) {
    return fail("找不到上级窗口。");
  }
  const gated = gateSupervisorToManager({
    callerRole: caller.role,
    targetRole: target.role,
    ...(brief.path !== undefined ? { statusPath: brief.path } : {}),
    ...(detail.path !== undefined ? { detailPath: detail.path } : {}),
    statusText: summary,
  });
  if (!gated.ok) {
    return fail(gated.error);
  }
  if (gated.kind === "silent") {
    return ok({ delivered: false, reason: "近况四行不齐，未叫醒管理者。" });
  }
  const deliveredText = gated.kind === "wake" ? gated.text : summary;
  const deliveredStatus = gated.kind === "wake" ? gated.status : status;
  const deliveredBrief = gated.kind === "wake" ? gated.statusPath : brief.path;
  const record = await persist(
    caller,
    target,
    {
      kind: "report",
      text: deliveredText,
      status: deliveredStatus,
      ...(files !== undefined ? { files } : {}),
      ...(deliveredBrief !== undefined ? { briefPath: deliveredBrief } : {}),
    },
    tree,
    deps,
  );
  remindTarget(target, caller, "report", deliveredStatus, deps);
  await publishUnread(target, deps);
  deps.publishInbox({ windowId: caller.id, lastReportStatus: deliveredStatus });
  return ok({ id: record.id, threadFile: record.threadFile, status: deliveredStatus });
}

async function readInbox(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const mode = args["mode"] === undefined ? "unread" : args["mode"];
  if (mode !== "unread" && mode !== "all") {
    return fail("mode 只能是 unread 或 all。");
  }
  const requested = args["limit"];
  const limit =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(1, Math.min(INBOX_MAX_LIMIT, Math.floor(requested)))
      : INBOX_DEFAULT_LIMIT;
  const records = await readThreadIndex(caller.projectRoot);
  const mine = records.filter((record) => record.to.windowId === caller.id);
  const cursor = await deps.getCursor(caller.id);
  const slice =
    mode === "all"
      ? mine.slice(Math.max(0, mine.length - limit))
      : inboxAfter(records, caller.id, cursor).slice(0, limit);
  if (mode === "all") {
    const newest = mine.at(-1)?.id;
    if (newest !== undefined) {
      await deps.setCursor(caller.id, newest);
    }
  } else if (slice.length > 0) {
    const last = slice.at(-1)?.id;
    if (last !== undefined) {
      await deps.setCursor(caller.id, last);
    }
  }
  const nextCursor =
    mode === "all" ? mine.at(-1)?.id : slice.length > 0 ? slice.at(-1)?.id : cursor;
  const unread = inboxAfter(records, caller.id, nextCursor).length;
  deps.publishInbox({ windowId: caller.id, unread });
  return ok({
    messages: slice.map((record) => ({
      id: record.id,
      ts: record.ts,
      from: record.from,
      kind: record.kind,
      ...(record.status !== undefined ? { status: record.status } : {}),
      text: record.text,
      ...(record.files !== undefined ? { files: record.files } : {}),
      ...(record.briefPath !== undefined ? { briefPath: record.briefPath } : {}),
    })),
    unreadRemaining: unread,
  });
}

async function readOutput(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const targetId = args["windowId"];
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return fail("ffpane_read_output 需要 windowId。");
  }
  const decision = authorize({
    actor: { kind: "window", windowId: caller.id },
    action: "read-output",
    targetWindowId: targetId,
    tree,
  });
  if (!decision.ok) {
    return fail("只能读取自己后代窗口的终端输出。");
  }
  const maxBytes = clampReadOutputBytes(args["maxBytes"]);
  const output = await deps.readOutput(targetId, maxBytes);
  if (!output.running) {
    return ok({ running: false, status: output.status });
  }
  return ok({
    running: true,
    status: output.status,
    text: stripTerminalControls(output.text ?? ""),
  });
}

async function closeWindow(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const targetId = args["windowId"];
  if (typeof targetId !== "string" || targetId.trim() === "") {
    return fail("ffpane_close_window 需要 windowId。");
  }
  if (targetId === caller.id || !isDescendantOf(caller.id, targetId, tree)) {
    return fail("只能关闭自己的后代窗口。");
  }
  const decision = authorize({
    actor: { kind: "window", windowId: caller.id },
    action: "close",
    targetWindowId: targetId,
    tree,
  });
  if (!decision.ok) {
    return fail("只能关闭自己的后代窗口。");
  }
  const target = await deps.describe(targetId);
  if (target === undefined) {
    return fail("找不到目标窗口。");
  }
  const closed = await closeDescendantWindow(
    caller,
    target,
    tree,
    deps.now(),
    deps.closeDescendant,
  );
  if (!closed.ok) {
    return fail(closed.error);
  }
  return ok({ ok: true, windowId: targetId });
}

function openPanel(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): ToolTextResult {
  const panel = args["panel"];
  if (panel !== "plan" && panel !== "tasks" && panel !== "runs") {
    return fail("panel 只能是 plan、tasks 或 runs。");
  }
  if (!allowOpenPanel(caller.id, deps.now())) {
    return fail("打开面板过于频繁，请稍后再试。");
  }
  deps.openPanel(panel, caller.title, caller.projectId);
  return ok({ ok: true, panel });
}

async function optionalBrief(
  projectRoot: string,
  briefPath: string | undefined,
): Promise<
  { readonly ok: true; readonly path?: string } | { readonly ok: false; readonly error: string }
> {
  if (briefPath === undefined || briefPath.trim() === "") {
    return { ok: true };
  }
  const resolved = await resolveBriefPath(projectRoot, briefPath);
  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, path: resolved.relativePath };
}

function displayTitle(title: string): string {
  const cleaned = sanitizeThreadText(title).trim();
  return cleaned.length > 0 ? cleaned : "窗口";
}

async function persist(
  from: ToolWindowView,
  to: ToolWindowView,
  body: {
    readonly kind: "message" | "report";
    readonly text: string;
    readonly status?: ReportStatus;
    readonly files?: readonly string[];
    readonly briefPath?: string;
  },
  tree: Readonly<Record<string, WorkbenchAuthNode>>,
  deps: WorkbenchToolDeps,
): Promise<ThreadRecord> {
  const anchor = teamAnchorId(from.id, to.id, tree);
  const anchorView =
    anchor === from.id ? from : anchor === to.id ? to : await deps.describe(anchor);
  const date = new Date(deps.now());
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const record: ThreadRecord = {
    v: 1,
    id: `m-${deps.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: date.toISOString(),
    projectId: from.projectId,
    from: { windowId: from.id, title: displayTitle(from.title), role: from.role },
    to: { windowId: to.id, title: displayTitle(to.title), role: to.role },
    kind: body.kind,
    ...(body.status !== undefined ? { status: body.status } : {}),
    text: body.text,
    ...(body.files !== undefined ? { files: body.files } : {}),
    ...(body.briefPath !== undefined ? { briefPath: body.briefPath } : {}),
    threadFile: `${day}-${teamFileSlug(anchorView?.title ?? "team", anchor)}.md`,
  };
  await appendThreadRecord(from.projectRoot, record, date);
  return record;
}

function remindTarget(
  target: ToolWindowView,
  from: ToolWindowView,
  kind: "message" | "report",
  status: ReportStatus | undefined,
  deps: WorkbenchToolDeps,
): void {
  deps.remind(target.id, (count) =>
    count <= 1
      ? buildNewMessageReminder({
          title: from.title,
          role: from.role,
          kind,
          ...(status !== undefined ? { status } : {}),
        })
      : buildCoalescedReminder(count),
  );
}

async function publishUnread(target: ToolWindowView, deps: WorkbenchToolDeps): Promise<void> {
  const records = await readThreadIndex(target.projectRoot);
  const cursor = await deps.getCursor(target.id);
  deps.publishInbox({
    windowId: target.id,
    unread: inboxAfter(records, target.id, cursor).length,
  });
}

const MEMORY_ADD_DENIED =
  "只有已授权的管理者，或用户自己打开且没有被冷启动清洗锁住的窗口，才能添加项目记忆。请用 ffpane_report 请上级添加，不要反复尝试。";

function isMemoryAddCategory(value: unknown): value is Exclude<MemoryCategory, "state"> {
  return value === "decision" || value === "rule" || value === "lesson";
}

async function searchMemory(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const raw = args["query"];
  if (typeof raw !== "string") {
    return fail("需要 query。");
  }
  const query = raw.trim();
  if (query.length === 0) {
    return fail("查询不能为空。");
  }
  if (codePointLength(query) > MEMORY_SEARCH_QUERY_MAX_CHARS) {
    return fail(`查询超过 ${MEMORY_SEARCH_QUERY_MAX_CHARS} 字。请改短后再查。`);
  }
  let entries: readonly MemoryEntry[];
  try {
    entries = await deps.searchProjectMemory(caller.projectRoot, query, MEMORY_SEARCH_MAX_HITS + 1);
  } catch {
    return fail("检索项目记忆失败。");
  }
  const packed = packMemorySearchHits(entries, MEMORY_SEARCH_MAX_HITS, MEMORY_SEARCH_MAX_BYTES);
  return ok({ hits: packed.hits, truncated: packed.truncated });
}

async function addMemory(
  caller: ToolWindowView,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  if (
    !canAddProjectMemory({
      managerGranted: deps.isManagerGranted(caller.id),
      openedBy: caller.openedBy,
      sanitizeLocked: caller.sanitizeLocked,
    })
  ) {
    return fail(MEMORY_ADD_DENIED);
  }
  const category = args["category"];
  const rawTitle = args["title"];
  const rawBody = args["body"];
  if (!isMemoryAddCategory(category)) {
    return fail("category 只能是 decision、rule 或 lesson。");
  }
  if (typeof rawTitle !== "string" || typeof rawBody !== "string") {
    return fail("需要 title 和 body。");
  }
  const title = sanitizeMemoryTitle(rawTitle);
  const body = sanitizeMemoryBody(rawBody);
  if (title.length === 0) {
    return fail("标题不能为空。");
  }
  if (body.length === 0) {
    return fail("正文不能为空。");
  }
  if (codePointLength(title) > MEMORY_ADD_TITLE_MAX_CHARS) {
    return fail(`标题超过 ${MEMORY_ADD_TITLE_MAX_CHARS} 字。`);
  }
  if (codePointLength(body) > MEMORY_ADD_BODY_MAX_CHARS) {
    return fail(`正文超过 ${MEMORY_ADD_BODY_MAX_CHARS} 字。`);
  }
  const now = deps.now();
  if (!reserveMemoryAdd(caller.id, now)) {
    return fail(`添加记忆过于频繁，请至少间隔 ${MEMORY_ADD_MIN_INTERVAL_MS / 1000} 秒。`);
  }
  const entry: MemoryEntry = {
    id: `mem-${randomUUID()}` as MemoryEntryId,
    category,
    title,
    body,
    status: "candidate",
    confidence: "low",
    source: {
      kind: "workbench",
      windowId: caller.id,
      windowTitle: sanitizeSourceWindowTitle(caller.title),
      role: caller.role,
    },
    createdAt: now,
    updatedAt: now,
  };
  try {
    await deps.addProjectMemory(caller.projectRoot, entry);
  } catch {
    return fail("写入项目记忆失败。");
  }
  return ok({
    id: entry.id,
    status: entry.status,
    category: entry.category,
    title: entry.title,
  });
}

async function setModelEffort(
  callerId: string,
  args: Readonly<Record<string, unknown>>,
  deps: WorkbenchToolDeps,
): Promise<ToolTextResult> {
  const windowId = args["windowId"];
  if (typeof windowId !== "string" || windowId.trim() === "") {
    return fail("ffpane_set_model_effort 需要目标窗口 id。");
  }
  const result = await deps.setModelEffort({
    callerId,
    windowId: windowId.trim(),
    ...(args["model"] !== undefined ? { model: args["model"] } : {}),
    ...(args["reasoningEffort"] !== undefined ? { reasoningEffort: args["reasoningEffort"] } : {}),
  });
  if (!result.ok) {
    return fail(result.error);
  }
  return ok({ ok: true, windowId: windowId.trim(), message: result.message });
}

export { openChildWindow };
