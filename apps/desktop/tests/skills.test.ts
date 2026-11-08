/**
 * T11.9 技能：SKILL.md 头部、名字规则、猜作者、要什么程序、按 CLI 决定挂哪些、
 * 技能库导入（复制、保留配置文件、替换、拒绝坏目录）、改名、删除、挂载目录（链接不顺着删）。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importSkill,
  listSkills,
  readSkillIndex,
  removeSkill,
  resolveImportSource,
  resolveSkillsLayout,
  SkillImportError,
  type SkillsLayout,
  setSkillAppliesTo,
  setSkillDisplayName,
  toMountCandidates,
} from "../src/main/skills/skill-library";
import {
  composeSkillInstructions,
  detectSkillNeeds,
  guessSkillAuthor,
  isValidSkillName,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  parseSkillFrontmatter,
  planSkillMounts,
  type SkillMountCandidate,
} from "../src/main/skills/skill-manifest";
import { removeMountDir, SkillMountRegistry } from "../src/main/skills/skill-mounts";
import { buildInteractiveClaudeArgs } from "../src/main/workbench/cli-args";

const SKILL_MD = (name: string, description = "Generate images through an API.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function writeSkill(dir: string, name: string, extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_MD(name));
  for (const [rel, text] of Object.entries(extra)) {
    const file = join(dir, ...rel.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe("SKILL.md 头部与名字", () => {
  it("读出 name、description 和顶层键；带 BOM、引号、折行也认", () => {
    const parsed = parseSkillFrontmatter(
      '\uFEFF---\r\nname: "codex-image-studio"\r\ndescription: >\r\n  Image generation\r\n  workflow.\r\nallowed-tools: Bash\r\n---\r\nbody',
    );
    expect(parsed).toEqual({
      ok: true,
      name: "codex-image-studio",
      description: "Image generation workflow.",
      keys: ["name", "description", "allowed-tools"],
    });
  });

  it("缺头部、缺 name、缺 description 分别报出来", () => {
    expect(parseSkillFrontmatter("# no header")).toEqual({ ok: false, reason: "no-frontmatter" });
    expect(parseSkillFrontmatter("---\ndescription: x\n---\n")).toEqual({
      ok: false,
      reason: "no-name",
    });
    expect(parseSkillFrontmatter("---\nname: a\n---\n")).toEqual({
      ok: false,
      reason: "no-description",
    });
  });

  it("名字只能小写字母、数字、连字符，最长 64", () => {
    expect(isValidSkillName("codex-image-studio")).toBe(true);
    expect(isValidSkillName("Codex")).toBe(false);
    expect(isValidSkillName("a--b")).toBe(false);
    expect(isValidSkillName("a_b")).toBe(false);
    expect(isValidSkillName("x".repeat(65))).toBe(false);
  });
});

describe("猜作者、要什么程序", () => {
  it("agents/openai.yaml 判 Codex；.claude-plugin 或 Claude 专有字段判 Claude；都没有判不知道", () => {
    expect(guessSkillAuthor(["SKILL.md", "agents/openai.yaml"], [])).toBe("codex");
    expect(guessSkillAuthor(["SKILL.md", ".claude-plugin/plugin.json"], [])).toBe("claude");
    expect(guessSkillAuthor(["SKILL.md"], ["name", "allowed-tools"])).toBe("claude");
    expect(guessSkillAuthor(["SKILL.md"], ["name", "description"])).toBe("unknown");
  });

  it("按脚本后缀判断要 python / node；curl 或 PowerShell 访问 https 记一笔", () => {
    expect(detectSkillNeeds([{ rel: "scripts/a.py" }, { rel: "SKILL.md" }])).toEqual({
      python: true,
      node: false,
      windowsHttps: false,
    });
    expect(
      detectSkillNeeds([{ rel: "run.ps1", text: "Invoke-WebRequest https://x.example/a" }]),
    ).toEqual({ python: false, node: false, windowsHttps: true });
    expect(detectSkillNeeds([{ rel: "a.mjs", text: "fetch('https://x')" }]).node).toBe(true);
    expect(detectSkillNeeds([{ rel: "a.mjs", text: "fetch('https://x')" }]).windowsHttps).toBe(
      false,
    );
  });
});

const candidate = (
  name: string,
  appliesTo: SkillMountCandidate["appliesTo"] = "any",
  unavailable?: SkillMountCandidate["unavailable"],
): SkillMountCandidate => ({
  name,
  description: `${name} description`,
  appliesTo,
  dir: `D:\\lib\\${name}`,
  skillFile: `D:\\lib\\${name}\\SKILL.md`,
  ...(unavailable !== undefined ? { unavailable } : {}),
});

describe("按 CLI 决定挂哪些", () => {
  const library = [
    candidate("both"),
    candidate("claude-only", "claude"),
    candidate("codex-only", "codex"),
    candidate("broken", "any", "python-missing"),
  ];
  const enabled = ["both", "claude-only", "codex-only", "broken", "gone", "both"];

  it("Claude 窗口不挂只适用于 Codex 的，Codex 窗口反过来；Grok 只挂通用的", () => {
    expect(planSkillMounts(enabled, library, "claude-code")).toEqual({
      mount: [library[0], library[1]],
      skipped: [
        { name: "codex-only", reason: "codex-only" },
        { name: "broken", reason: "python-missing" },
        { name: "gone", reason: "not-in-library" },
      ],
    });
    expect(planSkillMounts(enabled, library, "codex").mount.map((s) => s.name)).toEqual([
      "both",
      "codex-only",
    ]);
    expect(planSkillMounts(enabled, library, "grok").mount.map((s) => s.name)).toEqual(["both"]);
  });

  it("没勾就什么都不挂", () => {
    expect(planSkillMounts([], library, "codex")).toEqual({ mount: [], skipped: [] });
  });

  it("Codex / Grok 的技能清单写名字、说明和 SKILL.md 路径，有总长上限", () => {
    expect(composeSkillInstructions([])).toBeUndefined();
    const text = composeSkillInstructions([candidate("both")]) ?? "";
    expect(text).toContain("## 本项目启用的技能");
    expect(text).toContain("- both：both description（SKILL.md：D:\\lib\\both\\SKILL.md）");
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(600),
      skillFile: `D:\\lib\\skill-${i}\\SKILL.md`,
    }));
    expect((composeSkillInstructions(many) ?? "").length).toBeLessThanOrEqual(
      MAX_SKILL_INSTRUCTIONS_CHARS,
    );
  });
});

describe("Claude 启动参数挂插件目录", () => {
  it("每个目录一对 --plugin-dir，放在开场白前面", () => {
    const args = buildInteractiveClaudeArgs({
      pluginDirs: ["D:\\mounts\\w1"],
      initialPrompt: "hello",
    });
    expect(args.slice(-3)).toEqual(["--plugin-dir", "D:\\mounts\\w1", "hello"]);
  });
});

describe("技能库", () => {
  let root: string;
  let layout: SkillsLayout;
  const probe = { python: true, node: true };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ffpane-skills-"));
    layout = resolveSkillsLayout(join(root, "data"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("从仓库根目录导入时找到下一层唯一那个技能；复制进库，不链接原目录", async () => {
    const repo = join(root, "repo");
    writeSkill(join(repo, "codex-image-studio"), "codex-image-studio", {
      "scripts/generate_image.py": "print('hi')",
      "agents/openai.yaml": "interface: {}",
      "__pycache__/x.pyc": "junk",
    });
    writeFileSync(join(repo, "README.md"), "readme");
    expect(await resolveImportSource(repo)).toBe(join(repo, "codex-image-studio"));

    const outcome = await importSkill(layout, repo, { now: 123 });
    expect(outcome).toEqual({ status: "imported", name: "codex-image-studio" });
    const copied = join(layout.libraryDir, "codex-image-studio");
    expect(existsSync(join(copied, "scripts", "generate_image.py"))).toBe(true);
    expect(existsSync(join(copied, "__pycache__"))).toBe(false);

    const [view] = await listSkills(layout, probe, () => ["Sea"]);
    expect(view).toMatchObject({
      name: "codex-image-studio",
      displayName: "",
      appliesTo: "any",
      author: "codex",
      status: "ok",
      needsPython: true,
      importedAt: 123,
      usedBy: ["Sea"],
    });
  });

  it("同名已存在且没说替换时什么都不动；替换时保留用户填的配置文件，不被新模板盖掉", async () => {
    const v1 = writeSkill(join(root, "v1"), "img", {
      "image_api.env": "OPENAI_API_KEY=\n",
      "scripts/a.py": "v1",
    });
    await importSkill(layout, v1);
    const configFile = join(layout.libraryDir, "img", "image_api.env");
    writeFileSync(configFile, "OPENAI_API_KEY=secret-filled-by-user\n");
    await setSkillDisplayName(layout, "img", "生图");
    await setSkillAppliesTo(layout, "img", "claude");

    const v2 = writeSkill(join(root, "v2"), "img", {
      "image_api.env": "OPENAI_API_KEY=\n",
      "scripts/a.py": "v2",
    });
    expect(await importSkill(layout, v2)).toEqual({ status: "exists", name: "img" });
    expect(readFileSync(join(layout.libraryDir, "img", "scripts", "a.py"), "utf8")).toBe("v1");

    const replaced = await importSkill(layout, v2, { replace: true });
    expect(replaced).toEqual({ status: "replaced", name: "img", sameAsBefore: false });
    expect(readFileSync(join(layout.libraryDir, "img", "scripts", "a.py"), "utf8")).toBe("v2");
    expect(readFileSync(configFile, "utf8")).toBe("OPENAI_API_KEY=secret-filled-by-user\n");
    const [entry] = await readSkillIndex(layout);
    expect(entry).toMatchObject({ displayName: "生图", appliesTo: "claude" });

    // 只改了配置文件不算内容变了
    expect(await importSkill(layout, v2, { replace: true })).toMatchObject({ sameAsBefore: true });
    expect(readdirNames(layout.libraryDir)).toEqual(["img"]);
  });

  it("没有 SKILL.md、头部坏了、名字不合规、目录里有好几个技能都拒绝并说清原因", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    await expect(importSkill(layout, empty)).rejects.toMatchObject({ code: "no-skill-md" });

    const bad = join(root, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "SKILL.md"), "# no header");
    await expect(importSkill(layout, bad)).rejects.toMatchObject({ code: "bad-frontmatter" });

    const upper = writeSkill(join(root, "upper"), "Upper");
    await expect(importSkill(layout, upper)).rejects.toMatchObject({ code: "bad-name" });

    const multi = join(root, "multi");
    writeSkill(join(multi, "a"), "a");
    writeSkill(join(multi, "b"), "b");
    await expect(importSkill(layout, multi)).rejects.toBeInstanceOf(SkillImportError);
    await expect(importSkill(layout, multi)).rejects.toMatchObject({ code: "multiple-skills" });
    expect(existsSync(layout.indexFile)).toBe(false);
  });

  it("显示名空串恢复用原名；缺 python 时状态是当前无法激活；删掉后目录和信息都没了", async () => {
    await importSkill(layout, writeSkill(join(root, "s"), "s", { "x.py": "" }));
    await setSkillDisplayName(layout, "s", "好名字");
    await setSkillDisplayName(layout, "s", "  ");
    expect((await readSkillIndex(layout))[0]?.displayName).toBeUndefined();

    const [view] = await listSkills(layout, { python: false, node: true });
    expect(view?.status).toBe("python-missing");
    expect(toMountCandidates(view === undefined ? [] : [view])[0]?.unavailable).toBe(
      "python-missing",
    );

    await removeSkill(layout, "s");
    expect(existsSync(join(layout.libraryDir, "s"))).toBe(false);
    expect(await readSkillIndex(layout)).toEqual([]);
  });

  it("库里的目录被删了，状态是无法激活，不报错", async () => {
    await importSkill(layout, writeSkill(join(root, "s"), "s"));
    rmSync(join(layout.libraryDir, "s"), { recursive: true, force: true });
    const [view] = await listSkills(layout, probe);
    expect(view?.status).toBe("invalid");
  });
});

describe("挂载目录", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ffpane-mounts-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Claude：插件目录里是指向技能库的链接；关窗只删挂载，技能库里的文件和配置都还在", async () => {
    const lib = writeSkill(join(root, "lib", "img"), "img", { "image_api.env": "KEY=1\n" });
    const registry = new SkillMountRegistry(join(root, "mounts"));
    const prepared = await registry.prepare(
      "win:1",
      "claude-code",
      planSkillMounts(["img", "gone"], [{ ...candidate("img"), dir: lib }], "claude-code"),
    );
    expect(prepared.report).toEqual({
      mounted: ["img"],
      skipped: [{ name: "gone", reason: "not-in-library" }],
    });
    const pluginDir = prepared.claudePluginDir ?? "";
    expect(
      JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")),
    ).toMatchObject({ name: "ffpane-skills" });
    expect(readFileSync(join(pluginDir, "skills", "img", "SKILL.md"), "utf8")).toContain(
      "name: img",
    );

    await registry.release("win:1");
    expect(existsSync(pluginDir)).toBe(false);
    expect(readFileSync(join(lib, "image_api.env"), "utf8")).toBe("KEY=1\n");
  });

  it("Codex / Grok 不建目录，只给技能清单；什么都不挂时什么都不给", async () => {
    const registry = new SkillMountRegistry(join(root, "mounts"));
    const codex = await registry.prepare(
      "w2",
      "codex",
      planSkillMounts(["img"], [candidate("img")], "codex"),
    );
    expect(codex.claudePluginDir).toBeUndefined();
    expect(codex.instructions).toContain("img");
    expect(existsSync(join(root, "mounts"))).toBe(false);

    const none = await registry.prepare("w3", "claude-code", { mount: [], skipped: [] });
    expect(none).toEqual({ report: { mounted: [], skipped: [] } });
  });

  it("启动清理和直接删挂载目录都不顺着链接删到技能库", async () => {
    const lib = writeSkill(join(root, "lib", "img"), "img", { "image_api.env": "KEY=1\n" });
    const registry = new SkillMountRegistry(join(root, "mounts"));
    await registry.prepare(
      "w4",
      "claude-code",
      planSkillMounts(["img"], [{ ...candidate("img"), dir: lib }], "claude-code"),
    );
    const fresh = new SkillMountRegistry(join(root, "mounts"));
    await fresh.cleanStale();
    expect(readdirNames(join(root, "mounts"))).toEqual([]);
    expect(existsSync(join(lib, "image_api.env"))).toBe(true);

    await removeMountDir(join(root, "does-not-exist"));
  });

  it("退出时同步删掉所有挂载目录，技能库不动", async () => {
    const lib = writeSkill(join(root, "lib", "img"), "img", { "image_api.env": "KEY=1\n" });
    const registry = new SkillMountRegistry(join(root, "mounts"));
    const prepared = await registry.prepare(
      "w5",
      "claude-code",
      planSkillMounts(["img"], [{ ...candidate("img"), dir: lib }], "claude-code"),
    );
    registry.releaseAllSync();
    expect(existsSync(prepared.claudePluginDir ?? "")).toBe(false);
    expect(readFileSync(join(lib, "image_api.env"), "utf8")).toBe("KEY=1\n");
  });
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
