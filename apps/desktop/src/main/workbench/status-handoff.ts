/**
 * 监管者交接（T10.19）。
 * 近况只有四行。四行不齐不叫醒管理者，并说清哪一行不对（T11.0b）。消息只带路径和这四行，不带详细记录正文。
 */

import type { WorkbenchRole } from "@ff-pane/shared";
import { hasControlChar } from "./remind";

const STATUS_PREFIXES = ["结论：", "改了：", "还没做：", "要决定："] as const;
const CONCLUSIONS = ["做完", "卡住", "失败"] as const;

/** 四行模板。错误提示和 supervisor.md 都用这一份。 */
export const STATUS_TEMPLATE = [
  "结论：做完；已跑 pnpm test，通过。（「做完」「卡住」「失败」三选一开头；没跑就写「没跑」）",
  "改了：改过的文件，没有就写无",
  "还没做：还没做的，没有就写无",
  "要决定：要管理者拍板的一件事，没有就写无",
].join("\n");

export type StatusConclusion = (typeof CONCLUSIONS)[number];

export type SupervisorReportStatus = "done" | "blocked" | "failed";

const BRIEF_MARKER = ".ffpane/briefs/";

export function conclusionToReportStatus(conclusion: StatusConclusion): SupervisorReportStatus {
  if (conclusion === "做完") {
    return "done";
  }
  if (conclusion === "卡住") {
    return "blocked";
  }
  return "failed";
}

/** 路径必须落在 `.ffpane/briefs/` 的单个文件上。含 `..`、越出该目录，都拒绝。 */
export function briefPathError(briefPath: string): string | undefined {
  if (typeof briefPath !== "string" || briefPath.trim() === "" || hasControlChar(briefPath)) {
    return "路径无效。";
  }
  if (briefPath.includes("..")) {
    return "路径不能包含 .. 。";
  }
  const normalized = briefPath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf(BRIEF_MARKER);
  if (index < 0) {
    return "路径必须位于 .ffpane/briefs/ 内。";
  }
  const rest = normalized.slice(index + BRIEF_MARKER.length);
  if (rest.length === 0 || rest.includes("/") || rest === "." || rest === "..") {
    return "路径必须位于 .ffpane/briefs/ 内。";
  }
  return undefined;
}

export function toBriefRelative(briefPath: string): string | undefined {
  if (briefPathError(briefPath) !== undefined) {
    return undefined;
  }
  const normalized = briefPath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf(BRIEF_MARKER);
  return `.ffpane/briefs/${normalized.slice(index + BRIEF_MARKER.length)}`;
}

function matchConclusion(rest: string): StatusConclusion | undefined {
  for (const word of CONCLUSIONS) {
    if (!rest.startsWith(word)) {
      continue;
    }
    const next = rest[word.length];
    if (
      next === undefined ||
      next === "。" ||
      next === "." ||
      next === "，" ||
      next === "," ||
      next === " " ||
      next === "；" ||
      next === ";"
    ) {
      return word;
    }
  }
  return undefined;
}

function hasRunResult(text: string): boolean {
  if (text.includes("没跑") || text.includes("未跑")) {
    return true;
  }
  if (!text.includes("已跑")) {
    return false;
  }
  return text.includes("通过") || text.includes("失败");
}

export function parseStatusPage(text: string):
  | {
      readonly ok: true;
      readonly lines: readonly [string, string, string, string];
      readonly conclusion: StatusConclusion;
    }
  | { readonly ok: false; readonly reason: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalized.split("\n").map((line) => line.trim());
  if (lines.length !== STATUS_PREFIXES.length) {
    return { ok: false, reason: `要正好 4 行，现在是 ${lines.length} 行` };
  }
  for (let i = 0; i < STATUS_PREFIXES.length; i += 1) {
    const prefix = STATUS_PREFIXES[i];
    const line = lines[i];
    if (prefix === undefined || line === undefined || !line.startsWith(prefix)) {
      return { ok: false, reason: `第 ${i + 1} 行要以「${prefix ?? ""}」开头` };
    }
  }
  const [conclusionLine, changed, pending, decision] = lines;
  const conclusionPrefix = STATUS_PREFIXES[0];
  if (
    conclusionLine === undefined ||
    changed === undefined ||
    pending === undefined ||
    decision === undefined
  ) {
    return { ok: false, reason: "要正好 4 行" };
  }
  const conclusion = matchConclusion(conclusionLine.slice(conclusionPrefix.length));
  if (conclusion === undefined) {
    return { ok: false, reason: "第 1 行「结论：」后面要紧跟「做完」「卡住」或「失败」" };
  }
  if (!hasRunResult(lines.join("\n"))) {
    return { ok: false, reason: "要写跑没跑：「已跑 …，通过」「已跑 …，失败」或「没跑」" };
  }
  return {
    ok: true,
    lines: [conclusionLine, changed, pending, decision],
    conclusion,
  };
}

/** 近况不合格时给监管者看的话：哪里不对，再附模板。 */
export function statusPageProblem(reason: string): string {
  return `近况不合格：${reason}。照这个格式重写，正好四行：\n${STATUS_TEMPLATE}`;
}

export type SupervisorWake =
  | { readonly ok: true; readonly wake: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly wake: true;
      readonly text: string;
      readonly status: SupervisorReportStatus;
      readonly statusPath: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * 叫醒管理者的消息只含近况路径、可选的详细记录路径，和四行近况。
 * `detailText` 不会写进消息。四行不齐时没有消息正文。
 */
export function buildSupervisorWake(input: {
  readonly statusPath: string;
  readonly detailPath?: string;
  readonly statusText: string;
  readonly detailText?: string;
}): SupervisorWake {
  const statusError = briefPathError(input.statusPath);
  if (statusError !== undefined) {
    return { ok: false, error: `近况${statusError}` };
  }
  const statusPath = toBriefRelative(input.statusPath);
  if (statusPath === undefined) {
    return { ok: false, error: "近况路径必须位于 .ffpane/briefs/ 内。" };
  }
  let detailPath: string | undefined;
  if (input.detailPath !== undefined && input.detailPath.trim() !== "") {
    const detailError = briefPathError(input.detailPath);
    if (detailError !== undefined) {
      return { ok: false, error: `详细记录${detailError}` };
    }
    detailPath = toBriefRelative(input.detailPath);
    if (detailPath === undefined) {
      return { ok: false, error: "详细记录路径必须位于 .ffpane/briefs/ 内。" };
    }
  }
  const parsed = parseStatusPage(input.statusText);
  if (!parsed.ok) {
    return { ok: true, wake: false, reason: parsed.reason };
  }
  const lines = [`近况：${statusPath}`];
  if (detailPath !== undefined) {
    lines.push(`详细记录：${detailPath}`);
  }
  lines.push(...parsed.lines);
  const text = lines.join("\n");
  const detail = input.detailText?.trim() ?? "";
  if (detail.length >= 20 && text.includes(detail)) {
    return { ok: true, wake: false, reason: "消息里只放四行，不要放详细记录的正文" };
  }
  return {
    ok: true,
    wake: true,
    text,
    status: conclusionToReportStatus(parsed.conclusion),
    statusPath,
  };
}

export type SupervisorGate =
  | { readonly ok: true; readonly kind: "passthrough" }
  | { readonly ok: true; readonly kind: "silent"; readonly reason: string }
  | {
      readonly ok: true;
      readonly kind: "wake";
      readonly text: string;
      readonly status: SupervisorReportStatus;
      readonly statusPath: string;
    }
  | { readonly ok: false; readonly error: string };

/** 只有监管者交给管理者时才套用近况门闩。其它收发原样通过。 */
export function gateSupervisorToManager(input: {
  readonly callerRole: WorkbenchRole;
  readonly targetRole: WorkbenchRole;
  readonly statusPath?: string;
  readonly detailPath?: string;
  readonly statusText: string;
  readonly detailText?: string;
}): SupervisorGate {
  if (input.callerRole !== "supervisor" || input.targetRole !== "manager") {
    return { ok: true, kind: "passthrough" };
  }
  const wake = buildSupervisorWake({
    statusPath: input.statusPath ?? "",
    ...(input.detailPath !== undefined ? { detailPath: input.detailPath } : {}),
    statusText: input.statusText,
    ...(input.detailText !== undefined ? { detailText: input.detailText } : {}),
  });
  if (!wake.ok) {
    return wake;
  }
  if (!wake.wake) {
    return { ok: true, kind: "silent", reason: wake.reason };
  }
  return {
    ok: true,
    kind: "wake",
    text: wake.text,
    status: wake.status,
    statusPath: wake.statusPath,
  };
}
