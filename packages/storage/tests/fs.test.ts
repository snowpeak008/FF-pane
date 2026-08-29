/**
 * W1.2a 单测：目录布局 + 原子写 + 安全读，全部走 mkdtemp 临时目录真实读写。
 * 覆盖开发计划 §12 风险 R5：中文目录名 + 中文文件名 + 中文内容完整往返。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_ROOT_DIR_NAME,
  initGlobalLayout,
  initProjectLayout,
  readJson,
  readText,
  resolveGlobalLayout,
  resolveProjectLayout,
  StorageCorruptJsonError,
  StorageNotFoundError,
  WORKBENCH_DIR_NAME,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-fs-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf];

async function expectNoBom(filePath: string): Promise<void> {
  const bytes = await readFile(filePath);
  expect([bytes[0], bytes[1], bytes[2]]).not.toEqual(UTF8_BOM_BYTES);
}

describe("原子写 writeTextAtomic / writeJsonAtomic", () => {
  it("新建文件并自动补建缺失的父目录，UTF-8 无 BOM", async () => {
    const filePath = join(tempRoot, "a", "b", "note.md");
    await writeTextAtomic(filePath, "hello\n");
    expect(await readFile(filePath, "utf8")).toBe("hello\n");
    await expectNoBom(filePath);
  });

  it("rename 覆盖旧文件（Windows 覆盖语义实测），且不残留临时文件", async () => {
    const filePath = join(tempRoot, "config.json");
    await writeTextAtomic(filePath, "第一版内容");
    await writeTextAtomic(filePath, "第二版内容");
    expect(await readFile(filePath, "utf8")).toBe("第二版内容");
    const entries = await readdir(dirname(filePath));
    expect(entries).toEqual([basename(filePath)]);
  });

  it("writeJsonAtomic 输出 2 空格缩进 + 结尾换行，readJson 完整读回（含中文键值）", async () => {
    const filePath = join(tempRoot, "项目配置.json");
    const value = { 名称: "音智体美劳", nested: { 数值: 42 }, list: ["甲", "乙"] };
    await writeJsonAtomic(filePath, value);
    expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    await expectNoBom(filePath);
    const result = await readJson<typeof value>(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("预期读取成功");
    }
    expect(result.value).toEqual(value);
  });

  it("writeJsonAtomic 覆盖已有 JSON 文件后内容为完整新版本", async () => {
    const filePath = join(tempRoot, "state.json");
    await writeJsonAtomic(filePath, { version: 1, keep: "旧字段" });
    await writeJsonAtomic(filePath, { version: 2 });
    const result = await readJson<{ version: number }>(filePath);
    expect(result.ok && result.value).toEqual({ version: 2 });
  });
});

describe("安全读 readText / readJson", () => {
  it("readText 不存在的文件返回 not-found 结果而非抛异常，错误含路径", async () => {
    const filePath = join(tempRoot, "不存在.md");
    const result = await readText(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("预期 not-found 失败结果");
    }
    expect(result.error).toBeInstanceOf(StorageNotFoundError);
    expect(result.error.code).toBe("not-found");
    expect(result.error.path).toBe(filePath);
    expect(result.error.message).toContain(filePath);
  });

  it("readJson 不存在的文件同样返回 not-found 结果", async () => {
    const result = await readJson(join(tempRoot, "missing.json"));
    expect(!result.ok && result.error.code).toBe("not-found");
  });

  it("readJson 损坏 JSON：隔离为 <原名>.corrupt-<时间戳>，返回携带原始错误的 typed error", async () => {
    const filePath = join(tempRoot, "providers.json");
    const corruptContent = '{ "provider": "deepseek", 坏掉了';
    await writeFile(filePath, corruptContent, "utf8");

    const result = await readJson(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("预期 corrupt-json 失败结果");
    }
    expect(result.error).toBeInstanceOf(StorageCorruptJsonError);
    if (!(result.error instanceof StorageCorruptJsonError)) {
      throw new Error("预期 StorageCorruptJsonError");
    }
    expect(result.error.code).toBe("corrupt-json");
    expect(result.error.path).toBe(filePath);
    expect(result.error.message).toContain(filePath);
    expect(result.error.cause).toBeInstanceOf(SyntaxError);

    // 隔离文件命名符合约定，且完整保留原始损坏内容
    expect(basename(result.error.quarantinePath)).toMatch(
      /^providers\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    );
    expect(await readFile(result.error.quarantinePath, "utf8")).toBe(corruptContent);

    // 原路径已让位：下次读取得到干净的 not-found，可走首次初始化路径重建
    const afterQuarantine = await readJson(filePath);
    expect(!afterQuarantine.ok && afterQuarantine.error.code).toBe("not-found");
  });

  it("readText / readJson 容忍外部编辑器引入的 UTF-8 BOM（§8.4 允许任意编辑器直改）", async () => {
    const filePath = join(tempRoot, "手改.json");
    await writeFile(filePath, '\uFEFF{ "ok": true }', "utf8");
    const result = await readJson<{ ok: boolean }>(filePath);
    expect(result.ok && result.value).toEqual({ ok: true });
  });
});

describe("Windows 中文路径往返（开发计划 §12 风险 R5）", () => {
  it("中文目录名 + 中文文件名 + 中文内容完整往返，覆盖写后仍一致", async () => {
    const filePath = join(tempRoot, "音智体美劳项目", "记忆·决策", "决策-采用中文路径.md");
    const contentV1 =
      "# 决策：全链路 UTF-8\n\n中文正文、标点“引号”《书名》，混排 English 与 🀄。\n";
    await writeTextAtomic(filePath, contentV1);
    const first = await readText(filePath);
    expect(first.ok && first.value).toBe(contentV1);

    const contentV2 = `${contentV1}\n## 追加\n\n覆盖写入的第二版中文内容。\n`;
    await writeTextAtomic(filePath, contentV2);
    const second = await readText(filePath);
    expect(second.ok && second.value).toBe(contentV2);
    await expectNoBom(filePath);
  });

  it("中文项目根目录下 JSON 原子写 + 布局初始化均正常", async () => {
    const projectRoot = join(tempRoot, "我的·中文项目");
    const layout = await initProjectLayout(projectRoot);
    await writeJsonAtomic(layout.projectFile, { 项目名: "中文项目" });
    const result = await readJson<{ 项目名: string }>(layout.projectFile);
    expect(result.ok && result.value).toEqual({ 项目名: "中文项目" });
  });
});

describe("目录布局 resolve / init", () => {
  it("resolveGlobalLayout 与设计文档 §10.1 逐项对应", () => {
    const root = join(tempRoot, GLOBAL_ROOT_DIR_NAME);
    const layout = resolveGlobalLayout(root);
    expect(layout.rootDir).toBe(root);
    expect(layout.configFile).toBe(join(root, "config.json"));
    expect(layout.providersFile).toBe(join(root, "providers.json"));
    expect(layout.profilesFile).toBe(join(root, "profiles.json"));
    expect(layout.habitsDir).toBe(join(root, "habits"));
    expect(layout.habitCategoryDirs).toEqual({
      workflow: join(root, "habits", "workflow"),
      tech: join(root, "habits", "tech"),
      communication: join(root, "habits", "communication"),
      environment: join(root, "habits", "environment"),
    });
    expect(layout.knowledgeDir).toBe(join(root, "knowledge"));
    expect(layout.knowledgeSourcesDir).toBe(join(root, "knowledge", "sources"));
    expect(layout.knowledgeNotesDir).toBe(join(root, "knowledge", "notes"));
    expect(layout.indexDbFile).toBe(join(root, "index.sqlite"));
  });

  it("resolveProjectLayout 与设计文档 §10.2 逐项对应", () => {
    const projectRoot = join(tempRoot, "demo-project");
    const wb = join(projectRoot, WORKBENCH_DIR_NAME);
    const layout = resolveProjectLayout(projectRoot);
    expect(layout.projectRootDir).toBe(projectRoot);
    expect(layout.workbenchDir).toBe(wb);
    expect(layout.projectFile).toBe(join(wb, "project.json"));
    expect(layout.plansDir).toBe(join(wb, "plans"));
    expect(layout.tasksDir).toBe(join(wb, "tasks"));
    expect(layout.runsDir).toBe(join(wb, "runs"));
    expect(layout.memoryDir).toBe(join(wb, "memory"));
    expect(layout.memoryCategoryDirs).toEqual({
      decision: join(wb, "memory", "decisions"),
      rule: join(wb, "memory", "rules"),
      lesson: join(wb, "memory", "lessons"),
    });
    expect(layout.memoryCandidatesDir).toBe(join(wb, "memory", "candidates"));
    expect(layout.memoryStateFile).toBe(join(wb, "memory", "state.md"));
    expect(layout.knowledgeDir).toBe(join(wb, "knowledge"));
    expect(layout.indexDbFile).toBe(join(wb, "index.sqlite"));
  });

  it("initGlobalLayout 幂等：目录齐全、只建目录不建文件", async () => {
    const root = join(tempRoot, GLOBAL_ROOT_DIR_NAME);
    const first = await initGlobalLayout(root);
    const second = await initGlobalLayout(root);
    expect(second).toEqual(first);

    const expectedDirs = [
      first.habitsDir,
      ...Object.values(first.habitCategoryDirs),
      first.knowledgeSourcesDir,
      first.knowledgeNotesDir,
    ];
    for (const dir of expectedDirs) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
    // 文件（config.json / index.sqlite 等）归 W1.5a / W1.3a，init 不创建
    expect((await readdir(root)).sort()).toEqual(["habits", "knowledge"]);
  });

  it("initProjectLayout 幂等且不破坏既有数据", async () => {
    const projectRoot = join(tempRoot, "我的项目");
    const layout = await initProjectLayout(projectRoot);
    const existing = join(layout.memoryCategoryDirs.decision, "决策-001.md");
    await writeTextAtomic(existing, "既有中文内容");

    const again = await initProjectLayout(projectRoot);
    expect(again).toEqual(layout);

    const preserved = await readText(existing);
    expect(preserved.ok && preserved.value).toBe("既有中文内容");

    expect((await readdir(layout.workbenchDir)).sort()).toEqual([
      "knowledge",
      "memory",
      "plans",
      "runs",
      "tasks",
    ]);
    expect((await readdir(layout.memoryDir)).sort()).toEqual([
      "candidates",
      "decisions",
      "lessons",
      "rules",
    ]);
  });
});
