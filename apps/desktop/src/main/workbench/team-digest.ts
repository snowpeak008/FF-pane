/**
 * 「待处理」：管理者暂停（限流）或不在时，团队里的汇报和状态先记在这里，不打进它的终端。
 *
 * 每个窗口只占一行、只留最新的状态，后来的覆盖前面的，所以不管攒了多少事，这页都只有窗口数那么多行。
 * 管理者醒来只收到一句话（有几件事、在哪一页），先读这一页，要细节再看对应的汇报。
 * 管理者给哪个窗口发过消息、叫醒或关掉了它，那一行就划掉。
 * 文件写在项目的 .ffpane/briefs/ 里，管理者和用户都能直接打开；应用重启也不丢。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripControls } from "./remind";

export interface DigestLine {
  readonly windowId: string;
  readonly title: string;
  readonly text: string;
  readonly at: number;
}

export interface TeamDigest {
  /** 记一件事。返回这页现在有几行、相对项目根的路径。 */
  note(input: {
    readonly managerId: string;
    readonly projectRoot: string;
    readonly windowId: string;
    readonly title: string;
    readonly text: string;
  }): Promise<{ readonly count: number; readonly relativePath: string }>;
  /** 管理者处理过这个窗口：划掉它那一行。 */
  clear(managerId: string, windowId: string): Promise<void>;
  count(managerId: string): number;
  relativePath(managerId: string): string;
  /** 这一版有没有告诉过管理者。告诉过且没有新事就不再说。 */
  takeAnnouncement(managerId: string): boolean;
  forgetManager(managerId: string): Promise<void>;
}

export function digestRelativePath(managerId: string): string {
  return `.ffpane/briefs/待处理-${managerId}.md`;
}

function oneLine(text: string, max: number): string {
  return stripControls(text.replace(/[\r\n\t]+/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function renderDigest(lines: readonly DigestLine[]): string {
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  return [
    "# 待处理",
    "",
    "你暂停或不在期间，团队里每个窗口的最新状态。每个窗口一行，后来的覆盖前面的。",
    "处理完的不用改这页：你给那个窗口发过消息、叫醒或关掉它，平台会划掉那一行。",
    "",
    ...sorted.map(
      (line) => `- ${stamp(line.at)} ${oneLine(line.title, 40)}（${line.windowId}）：${line.text}`,
    ),
    "",
  ].join("\n");
}

export function createTeamDigest(deps: { readonly now: () => number }): TeamDigest {
  const teams = new Map<
    string,
    { projectRoot: string; lines: Map<string, DigestLine>; version: number; announced: number }
  >();

  const flush = async (managerId: string): Promise<void> => {
    const team = teams.get(managerId);
    if (team === undefined) {
      return;
    }
    const path = join(team.projectRoot, digestRelativePath(managerId));
    if (team.lines.size === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(join(team.projectRoot, ".ffpane", "briefs"), { recursive: true });
    await writeFile(path, renderDigest([...team.lines.values()]), "utf8");
  };

  return {
    async note(input) {
      let team = teams.get(input.managerId);
      if (team === undefined) {
        team = { projectRoot: input.projectRoot, lines: new Map(), version: 0, announced: 0 };
        teams.set(input.managerId, team);
      }
      team.projectRoot = input.projectRoot;
      team.lines.set(input.windowId, {
        windowId: input.windowId,
        title: input.title,
        text: oneLine(input.text, 300),
        at: deps.now(),
      });
      team.version += 1;
      await flush(input.managerId);
      return { count: team.lines.size, relativePath: digestRelativePath(input.managerId) };
    },
    async clear(managerId, windowId) {
      const team = teams.get(managerId);
      if (team === undefined || !team.lines.delete(windowId)) {
        return;
      }
      await flush(managerId);
    },
    count(managerId) {
      return teams.get(managerId)?.lines.size ?? 0;
    },
    relativePath(managerId) {
      return digestRelativePath(managerId);
    },
    takeAnnouncement(managerId) {
      const team = teams.get(managerId);
      if (team === undefined || team.lines.size === 0 || team.announced === team.version) {
        return false;
      }
      team.announced = team.version;
      return true;
    },
    async forgetManager(managerId) {
      const team = teams.get(managerId);
      if (team === undefined) {
        return;
      }
      team.lines.clear();
      await flush(managerId);
      teams.delete(managerId);
    },
  };
}
