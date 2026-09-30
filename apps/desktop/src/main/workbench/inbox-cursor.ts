/**
 * 收件箱已读游标（T10.7a）。
 * 按窗口 lastReadId 存在应用数据目录，不进项目。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface CursorFile {
  readonly v: 1;
  readonly windows: Readonly<Record<string, { readonly lastReadId?: string }>>;
}

function emptyFile(): CursorFile {
  return { v: 1, windows: {} };
}

export interface InboxCursorStore {
  get(windowId: string): Promise<string | undefined>;
  set(windowId: string, lastReadId: string): Promise<void>;
}

export function createInboxCursorStore(filePath: string): InboxCursorStore {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const load = async (): Promise<CursorFile> => {
    try {
      const text = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object") {
        return emptyFile();
      }
      const raw = parsed as { readonly windows?: unknown };
      if (raw.windows === null || typeof raw.windows !== "object" || Array.isArray(raw.windows)) {
        return emptyFile();
      }
      return { v: 1, windows: raw.windows as CursorFile["windows"] };
    } catch {
      return emptyFile();
    }
  };

  return {
    get(windowId) {
      return run(async () => {
        const file = await load();
        const id = file.windows[windowId]?.lastReadId;
        return typeof id === "string" && id.length > 0 ? id : undefined;
      });
    },
    set(windowId, lastReadId) {
      return run(async () => {
        const file = await load();
        const next: CursorFile = {
          v: 1,
          windows: {
            ...file.windows,
            [windowId]: { lastReadId },
          },
        };
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = join(dirname(filePath), `.inbox-cursors-${process.pid}.tmp`);
        await writeFile(tmp, `${JSON.stringify(next)}\n`, "utf8");
        await rename(tmp, filePath);
      });
    },
  };
}

export function inboxCursorPath(dataRoot: string): string {
  return join(dataRoot, "workbench-inbox-cursors.json");
}
