/**
 * T11.0d：团队消息索引按文件缓存，只往后追加时只读新加的部分，结果和整份解析一样。
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readThreadIndex, readThreadIndexText } from "../src/main/workbench/thread-store";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { root: string; index: string } {
  const root = mkdtempSync(join(tmpdir(), "ffpane-threads-"));
  roots.push(root);
  const dir = join(root, ".ffpane", "threads");
  mkdirSync(dir, { recursive: true });
  return { root, index: join(dir, "index.jsonl") };
}

function line(id: number, text = `第 ${id} 条`): string {
  return `${JSON.stringify({
    v: 1,
    id: `msg-${id}`,
    ts: new Date(Date.UTC(2026, 9, 27, 0, 0, id)).toISOString(),
    kind: "message",
    from: { windowId: "win-a", title: "A", role: "worker" },
    to: { windowId: "win-b", title: "B", role: "manager" },
    text,
    threadFile: "2026-10-27-A-win.md",
  })}\n`;
}

async function sameAsFullParse(root: string, index: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  expect(await readThreadIndex(root)).toEqual(readThreadIndexText(readFileSync(index, "utf8")));
}

describe("readThreadIndex 缓存", () => {
  it("追加、半行、补完、换掉整份，结果都和整份解析一样", async () => {
    const { root, index } = setup();
    expect(await readThreadIndex(root)).toEqual([]);

    writeFileSync(index, line(1) + line(2));
    await sameAsFullParse(root, index);
    expect(await readThreadIndex(root)).toHaveLength(2);

    appendFileSync(index, line(3, "含中文和😀"));
    await sameAsFullParse(root, index);

    // 写到一半的行：跳过；补完后读到。
    const half = line(4);
    appendFileSync(index, half.slice(0, 20));
    expect(await readThreadIndex(root)).toHaveLength(3);
    appendFileSync(index, half.slice(20));
    await sameAsFullParse(root, index);
    expect(await readThreadIndex(root)).toHaveLength(4);

    // 最后一行没有换行但完整：照样读到。
    appendFileSync(index, line(5).trimEnd());
    expect(await readThreadIndex(root)).toHaveLength(5);
    appendFileSync(index, "\n");
    await sameAsFullParse(root, index);

    // 整份换掉（变短）：重读。
    writeFileSync(index, line(9));
    await sameAsFullParse(root, index);
    expect((await readThreadIndex(root)).map((r) => r.id)).toEqual(["msg-9"]);

    // 整份换掉（变长、开头不同）：重读。
    writeFileSync(index, line(20) + line(21) + line(22));
    await sameAsFullParse(root, index);
  });
});
