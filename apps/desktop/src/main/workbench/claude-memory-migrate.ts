/**
 * T11.8b：把 Claude 自己存的记忆整理成项目记忆候选。
 *
 * Claude 的记忆在 `~/.claude/projects/<cwd 转义>/memory/<slug>.md`，每条一个文件，
 * frontmatter 有 name、description、metadata.type（user / feedback / project / reference），
 * 正文可能带 **Why:** / **How to apply:** 两段。FF-pane 的项目记忆是 `MemoryEntry`
 * （category、title、body、status…）。这里只做转换，不写盘、不碰索引；写回和用户审核在记忆页。
 *
 * 原来的文件不删（计划 §5）。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryCategory, MemoryEntry, MemoryEntryId } from "@ff-pane/shared";

/** Claude 记忆的四种类型 → 项目记忆分类。 */
const CATEGORY_BY_TYPE: Readonly<Record<string, MemoryCategory>> = {
  // 用户是谁、偏好什么：当作规则类，长期有效
  user: "rule",
  // 对工作方式的纠正：同样是规则
  feedback: "rule",
  // 正在做的事、目标、约束：决定类
  project: "decision",
  // 外部资料指针：当作经验，便于检索
  reference: "lesson",
};

export interface ClaudeMemoryFile {
  /** 文件名，去掉 .md。 */
  readonly slug: string;
  readonly text: string;
}

export interface ParsedClaudeMemory {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly body: string;
}

/** 只认开头 `---` 包住的 frontmatter；没有就当整篇是正文。 */
export function parseClaudeMemory(slug: string, text: string): ParsedClaudeMemory {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const head = { name: "", description: "", type: "" };
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    let index = 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim() === "---") {
        bodyStart = index + 1;
        break;
      }
      const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
      if (match === null) {
        // metadata 下的子键（缩进）也在这里：只认 type
        continue;
      }
      const key = (match[1] ?? "").toLowerCase();
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      if (key === "name") {
        head.name = value;
      } else if (key === "description") {
        head.description = value;
      } else if (key === "type") {
        head.type = value;
      }
    }
    if (bodyStart === 0) {
      // 没有收尾的 ---：不当 frontmatter，整篇都是正文
      bodyStart = 0;
    }
  }
  const body = lines.slice(bodyStart).join("\n").trim();
  return {
    slug,
    name: head.name !== "" ? head.name : slug,
    description: head.description,
    type: head.type.toLowerCase(),
    body,
  };
}

/** 把一条 Claude 记忆转成项目记忆候选；标题或正文都空的不转。 */
export function toMemoryCandidate(
  parsed: ParsedClaudeMemory,
  now: number,
): MemoryEntry | undefined {
  const title = (
    parsed.description !== "" ? parsed.description : (parsed.body.split("\n")[0] ?? "")
  )
    .trim()
    .slice(0, 120);
  const body = parsed.body !== "" ? parsed.body : parsed.description;
  if (title === "" || body === "") {
    return undefined;
  }
  const id = `claude-${parsed.slug}`.slice(0, 80) as MemoryEntryId;
  return {
    id,
    category: CATEGORY_BY_TYPE[parsed.type] ?? "lesson",
    title,
    body: body.slice(0, 4000),
    status: "candidate",
    source: { kind: "agent_proposed" },
    confidence: "low",
    createdAt: now,
    updatedAt: now,
  };
}

/** 一批文件 → 候选，跳过已经存在的 id，按 slug 排序，结果稳定。 */
export function migrateClaudeMemories(
  files: readonly ClaudeMemoryFile[],
  existingIds: ReadonlySet<string>,
  now: number,
): { readonly entries: readonly MemoryEntry[]; readonly skipped: readonly string[] } {
  const entries: MemoryEntry[] = [];
  const skipped: string[] = [];
  for (const file of [...files].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const candidate = toMemoryCandidate(parseClaudeMemory(file.slug, file.text), now);
    if (candidate === undefined) {
      skipped.push(`${file.slug}（没内容）`);
      continue;
    }
    if (existingIds.has(candidate.id)) {
      skipped.push(`${file.slug}（已经有）`);
      continue;
    }
    entries.push(candidate);
  }
  return { entries, skipped };
}

/** 单条超过这个大小就不搬（Claude 自己的记忆一般几百到几千字）。 */
const MAX_FILE_BYTES = 64 * 1024;

/** 读某个目录下所有 .md（不递归）。目录不在返回空。 */
export async function readClaudeMemoryFiles(dir: string): Promise<readonly ClaudeMemoryFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: ClaudeMemoryFile[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const slug = name.slice(0, -3);
    // MEMORY.md 是索引文件，不是一条记忆
    if (slug.toLowerCase() === "memory") {
      continue;
    }
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        continue;
      }
      const text = await readFile(full, "utf8");
      files.push({ slug, text });
    } catch {
      // 读不了就跳过，不阻断其余的
    }
  }
  return files;
}
