/**
 * ffpane_generate_image：假网络、假进程。不访问中转站，不跑真的 Codex。
 */

import { createHash } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { activePage } from "@ff-pane/shared";
import { createConfigStore, resolveGlobalLayout } from "@ff-pane/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CodexImageLaunch,
  codexGeneratedImagesDir,
  createCodexOutputReader,
  generateProjectImage,
  IMAGE_GEN_CODEX_NO_IMAGE_ERROR,
  IMAGE_GEN_OFF_ERROR,
  IMAGE_GEN_RELAY_INCOMPLETE_ERROR,
} from "../src/main/image-gen/generate";
import type { ImageGenStores } from "../src/main/image-gen/settings";
import { saveImageGenRelay, setImageGenMode } from "../src/main/image-gen/settings";
import type { EncryptionBackend } from "../src/main/secrets/backend";
import { createSecretStore, resolveSecretsFile } from "../src/main/secrets/store";
import {
  loadCanvasBoard,
  placeImageOnBoard,
  updateCanvasAnnotations,
} from "../src/main/workbench/canvas-files";

const SECRET = "sk-test-image-key-should-not-leak";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createFakeBackend(): EncryptionBackend {
  return {
    isAvailable: () => true,
    encrypt: (plaintext) => Buffer.from(`fake:${plaintext}`, "utf8"),
    decrypt: (ciphertext) => {
      const text = ciphertext.toString("utf8");
      if (!text.startsWith("fake:")) {
        throw new Error("假后端：密文前缀不符");
      }
      return text.slice("fake:".length);
    },
  };
}

let tempRoot: string;
let stores: ImageGenStores;
let projectRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ffpane-gen-image-"));
  projectRoot = join(tempRoot, "project");
  await mkdir(projectRoot);
  const layout = resolveGlobalLayout(join(tempRoot, ".aiworkbench"));
  const config = createConfigStore(layout.configFile);
  const secrets = createSecretStore({
    backend: createFakeBackend(),
    secretsFile: resolveSecretsFile(layout.rootDir),
  });
  stores = {
    readConfig: () => config.readConfig(),
    updateConfig: (patch) => config.updateConfig(patch),
    storeSecret: (plaintext) => secrets.storeSecret(plaintext),
    revealSecret: (ref) => secrets.revealSecret(ref),
    deleteSecret: (ref) => secrets.deleteSecret(ref),
    hasSecret: (ref) => secrets.hasSecret(ref),
    maskedTail: (ref) => secrets.maskedTail(ref),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempRoot, { recursive: true, force: true });
});

function sourcePng(): Buffer {
  return Buffer.from(PNG_B64, "base64");
}

function otherPng(): Buffer {
  const copy = Buffer.from(sourcePng());
  const last = copy.length - 1;
  const byte = copy[last] ?? 0;
  copy[last] = byte ^ 0xff;
  return copy;
}

async function useRelay(): Promise<void> {
  await saveImageGenRelay(stores, {
    baseUrl: "https://relay.example",
    model: "gpt-image-2",
    apiKey: SECRET,
  });
  await setImageGenMode(stores, "relay");
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(absolute)));
    } else if (entry.isFile()) {
      out.push(absolute);
    }
  }
  return out;
}

async function outsideDigest(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const file of await filesUnder(tempRoot)) {
    if (file.startsWith(projectRoot + sep)) {
      continue;
    }
    map.set(
      file,
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    );
  }
  return map;
}

function digestMapEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

describe("ffpane_generate_image", () => {
  it("先不生图时拒绝", async () => {
    const result = await generateProjectImage({ projectRoot, prompt: "一只猫" }, { stores });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(IMAGE_GEN_OFF_ERROR);
      expect(result.error).not.toContain(SECRET);
    }
  });

  it("中转站新图写入画板，项目外字节不变", async () => {
    await useRelay();
    const outside = join(tempRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "stay");
    const before = await outsideDigest();
    const response = otherPng();
    let called = 0;
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        fetchImpl: async (url, init) => {
          called += 1;
          expect(String(url)).toContain("/images/generations");
          expect(String(url)).not.toContain(SECRET);
          const body = JSON.parse(String(init?.body)) as { prompt?: string };
          expect(body.prompt).toBe("一只红猫");
          const header = new Headers(init?.headers).get("authorization") ?? "";
          expect(header).toContain(SECRET);
          return new Response(
            JSON.stringify({ data: [{ b64_json: response.toString("base64") }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );
    expect(called).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.relativePath.startsWith(".ffpane/canvas/")).toBe(true);
    expect(result.relativePath).not.toContain("revisions");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const written = await readFile(join(projectRoot, result.relativePath));
    expect(Buffer.compare(written, response)).toBe(0);
    const board = await loadCanvasBoard(projectRoot);
    const rows = activePage(board).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versions.map((item) => item.path)).toEqual([result.relativePath]);
    expect(digestMapEqual(before, await outsideDigest())).toBe(true);
  });

  it("中转站改图不改原图字节，新文件挂到同一行", async () => {
    await useRelay();
    const original = sourcePng();
    const response = otherPng();
    const sourceRel = ".ffpane/canvas/source.png";
    await mkdir(join(projectRoot, ".ffpane", "canvas"), { recursive: true });
    await writeFile(join(projectRoot, sourceRel), original);
    await placeImageOnBoard(projectRoot, sourceRel, { rowId: "row-1" });
    await updateCanvasAnnotations(projectRoot, sourceRel, [
      {
        id: "m1",
        kind: "label",
        x: 12,
        y: 34,
        w: 1,
        h: 1,
        color: "#ef4444",
        text: "太阳再大",
      },
    ]);
    let promptSent = "";
    let imageLength = 0;
    const result = await generateProjectImage(
      {
        projectRoot,
        prompt: "把天空换成黄昏",
        sourceImagePath: sourceRel,
        rowId: "row-1",
        asNewVersion: true,
      },
      {
        stores,
        fetchImpl: async (url, init) => {
          expect(String(url)).toContain("/images/edits");
          const body = init?.body;
          expect(body).toBeInstanceOf(FormData);
          if (body instanceof FormData) {
            promptSent = String(body.get("prompt") ?? "");
            const image = body.get("image");
            expect(image).toBeInstanceOf(Blob);
            if (image instanceof Blob) {
              imageLength = (await image.arrayBuffer()).byteLength;
            }
          }
          return new Response(
            JSON.stringify({ data: [{ b64_json: response.toString("base64") }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.relativePath).not.toBe(sourceRel);
    expect(promptSent).toContain("把天空换成黄昏");
    expect(promptSent).toContain("太阳再大");
    expect(promptSent).toContain("12");
    expect(promptSent).toContain("34");
    expect(promptSent).toContain("不要把气泡画进新图");
    expect(promptSent).not.toContain("revisions");
    expect(imageLength).toBe(original.byteLength);
    const still = await readFile(join(projectRoot, sourceRel));
    expect(Buffer.compare(still, original)).toBe(0);
    const created = await readFile(join(projectRoot, result.relativePath));
    expect(Buffer.compare(created, response)).toBe(0);
    const rows = activePage(await loadCanvasBoard(projectRoot)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-1");
    expect(rows[0]?.versions.map((item) => item.path)).toEqual([sourceRel, result.relativePath]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("没传行号时改图新开一行", async () => {
    await useRelay();
    const original = sourcePng();
    const sourceRel = ".ffpane/canvas/source.png";
    await mkdir(join(projectRoot, ".ffpane", "canvas"), { recursive: true });
    await writeFile(join(projectRoot, sourceRel), original);
    await placeImageOnBoard(projectRoot, sourceRel, { rowId: "row-1" });
    const result = await generateProjectImage(
      { projectRoot, prompt: "加一棵树", sourceImagePath: sourceRel },
      {
        stores,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ b64_json: otherPng().toString("base64") }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(result.ok).toBe(true);
    const rows = activePage(await loadCanvasBoard(projectRoot)).rows;
    expect(rows).toHaveLength(2);
  });

  it("路径跑出画板或指向预览时拒绝", async () => {
    await setImageGenMode(stores, "relay");
    let called = 0;
    const deps = {
      stores,
      fetchImpl: async () => {
        called += 1;
        throw new Error("不应发出请求");
      },
    };
    const escaped = await generateProjectImage(
      { projectRoot, prompt: "猫", sourceImagePath: "../outside.png" },
      deps,
    );
    const briefs = await generateProjectImage(
      { projectRoot, prompt: "猫", sourceImagePath: ".ffpane/briefs/secret.png" },
      deps,
    );
    const preview = await generateProjectImage(
      {
        projectRoot,
        prompt: "猫",
        sourceImagePath: ".ffpane/canvas/revisions/source.png.marked.png",
      },
      deps,
    );
    expect(escaped.ok).toBe(false);
    expect(briefs.ok).toBe(false);
    expect(preview.ok).toBe(false);
    if (!escaped.ok) {
      expect(escaped.error).toContain("..");
      expect(escaped.error).not.toContain(SECRET);
    }
    if (!briefs.ok) {
      expect(briefs.error).toContain(".ffpane/canvas/");
    }
    if (!preview.ok) {
      expect(preview.error).toContain("预览");
    }
    expect(called).toBe(0);
  });

  it("返回值和错误里没有密钥", async () => {
    await useRelay();
    const logs: string[] = [];
    const record = (...args: unknown[]): void => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "info").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    const failed = await generateProjectImage(
      { projectRoot, prompt: "一只猫" },
      {
        stores,
        fetchImpl: async () => {
          throw new Error(`上游失败 ${SECRET}`);
        },
      },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).not.toContain(SECRET);
      expect(failed.error.length).toBeGreaterThan(0);
    }
    const ok = await generateProjectImage(
      { projectRoot, prompt: "一只猫" },
      {
        stores,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    const missing = await generateProjectImage(
      { projectRoot, prompt: "一只猫" },
      {
        stores: {
          ...stores,
          readConfig: async () => ({
            ...(await stores.readConfig()),
            imageGen: { mode: "relay" as const },
          }),
        },
      },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBe(IMAGE_GEN_RELAY_INCOMPLETE_ERROR);
      expect(missing.error).not.toContain(SECRET);
    }
  });

  it("Codex 假进程把新 PNG 从临时目录搬进画板，旧文件还在", async () => {
    await setImageGenMode(stores, "codex_subscription");
    const codexHome = join(tempRoot, "codex-home");
    const imagesDir = join(codexHome, "generated_images");
    const fallbackHome = join(tempRoot, "fallback-home");
    await mkdir(imagesDir, { recursive: true });
    const authPath = join(codexHome, "auth.json");
    const configPath = join(codexHome, "config.toml");
    await writeFile(authPath, '{"token":"do-not-touch"}\n');
    await writeFile(configPath, 'model = "do-not-touch"\n');
    const oldPng = sourcePng();
    const earlyPng = otherPng();
    const newerPng = sourcePng();
    await writeFile(join(imagesDir, "old.png"), oldPng);
    await writeFile(join(imagesDir, "note.txt"), "keep");
    const launches: CodexImageLaunch[] = [];
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        homeDir: fallbackHome,
        baseEnv: {
          ...process.env,
          OPENAI_API_KEY: SECRET,
          CODEX_HOME: codexHome,
        },
        launchCodex: async (launch) => {
          launches.push(launch);
          expect(launch.shell).toBe(false);
          expect(basename(launch.file).toLowerCase()).not.toMatch(
            /^(cmd|powershell|pwsh)(\.exe)?$/,
          );
          expect(launch.file.toLowerCase().endsWith(".cmd")).toBe(false);
          expect(launch.file.toLowerCase().endsWith(".bat")).toBe(false);
          expect(launch.args).toContain("exec");
          expect(launch.args).toContain("--ephemeral");
          expect(launch.args).toContain("--skip-git-repo-check");
          expect(launch.args).toContain("--json");
          expect(launch.args.some((arg) => arg.endsWith("codex.js"))).toBe(true);
          expect(launch.args.some((arg) => basename(arg).toLowerCase() === "cmd.exe")).toBe(false);
          expect(launch.env["OPENAI_API_KEY"]).toBeUndefined();
          expect(Object.keys(launch.env).some((key) => /^OPENAI_/i.test(key))).toBe(false);
          expect(launch.env["CODEX_HOME"]).toBe(codexHome);
          expect(launch.cwd).not.toBe(projectRoot);
          expect(launch.cwd.startsWith(projectRoot + sep)).toBe(false);
          expect(launch.args.some((arg) => arg.includes("一只红猫"))).toBe(true);
          expect(launch.args.some((arg) => arg.includes("不要改代码"))).toBe(true);
          const early = join(imagesDir, "early.png");
          const newer = join(imagesDir, "newer.png");
          const fake = join(imagesDir, "fake.png");
          await writeFile(early, earlyPng);
          await writeFile(newer, newerPng);
          await writeFile(fake, "not-a-png");
          const past = new Date(Date.now() - 60_000);
          await utimes(early, past, past);
          await utimes(newer, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
          await utimes(fake, new Date(), new Date());
          return {};
        },
      },
    );
    expect(launches).toHaveLength(1);
    expect(existsSync(launches[0]?.cwd ?? "")).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(existsSync(join(imagesDir, "newer.png"))).toBe(false);
    expect(Buffer.compare(await readFile(join(imagesDir, "old.png")), oldPng)).toBe(0);
    expect(Buffer.compare(await readFile(join(imagesDir, "early.png")), earlyPng)).toBe(0);
    expect(await readFile(join(imagesDir, "note.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(imagesDir, "fake.png"), "utf8")).toBe("not-a-png");
    expect(Buffer.compare(await readFile(join(projectRoot, result.relativePath)), newerPng)).toBe(
      0,
    );
    expect(await readFile(authPath, "utf8")).toBe('{"token":"do-not-touch"}\n');
    expect(await readFile(configPath, "utf8")).toBe('model = "do-not-touch"\n');
    expect(existsSync(join(fallbackHome, ".codex"))).toBe(false);
    expect(codexGeneratedImagesDir({ CODEX_HOME: codexHome }, fallbackHome)).toBe(imagesDir);
    const rows = activePage(await loadCanvasBoard(projectRoot)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versions.map((item) => item.path)).toEqual([result.relativePath]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("Codex 这一次没有新 PNG 就失败，不拿走旧图", async () => {
    await setImageGenMode(stores, "codex_subscription");
    const codexHome = join(tempRoot, "codex-home");
    const imagesDir = join(codexHome, "generated_images");
    await mkdir(imagesDir, { recursive: true });
    const oldPng = sourcePng();
    await writeFile(join(imagesDir, "old.png"), oldPng);
    const launches: CodexImageLaunch[] = [];
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        homeDir: join(tempRoot, "fallback-home"),
        baseEnv: {
          ...process.env,
          OPENAI_API_KEY: SECRET,
          CODEX_HOME: codexHome,
        },
        launchCodex: async (launch) => {
          launches.push(launch);
          expect(launch.shell).toBe(false);
          expect(launch.env["OPENAI_API_KEY"]).toBeUndefined();
          expect(Object.keys(launch.env).some((key) => /^OPENAI_/i.test(key))).toBe(false);
          expect(basename(launch.file).toLowerCase()).not.toMatch(
            /^(cmd|powershell|pwsh)(\.exe)?$/,
          );
          return {};
        },
      },
    );
    expect(launches).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(IMAGE_GEN_CODEX_NO_IMAGE_ERROR);
      expect(result.error).not.toContain(SECRET);
    }
    expect(Buffer.compare(await readFile(join(imagesDir, "old.png")), oldPng)).toBe(0);
    const canvasFiles = (await filesUnder(join(projectRoot, ".ffpane", "canvas"))).filter((file) =>
      file.toLowerCase().endsWith(".png"),
    );
    expect(canvasFiles).toEqual([]);
  });

  it("Codex 把图放在会话 id 子文件夹里时，只拿这次会话的图", async () => {
    await setImageGenMode(stores, "codex_subscription");
    const codexHome = join(tempRoot, "codex-home");
    const imagesDir = join(codexHome, "generated_images");
    const threadId = "01a16bf5-2452-7f52-b054-19d1cf152248";
    const otherThreadDir = join(imagesDir, "01a16926-1492-73d2-b51d-e51a463d008f");
    const ownPng = sourcePng();
    const otherPngBytes = otherPng();
    await mkdir(imagesDir, { recursive: true });
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        homeDir: join(tempRoot, "fallback-home"),
        baseEnv: { ...process.env, CODEX_HOME: codexHome },
        launchCodex: async () => {
          await mkdir(join(imagesDir, threadId), { recursive: true });
          await writeFile(join(imagesDir, threadId, "exec-own.png"), ownPng);
          // 用户别的 Codex 会话同时出的图，更新，但不是这一次的。
          await mkdir(otherThreadDir, { recursive: true });
          const otherFile = join(otherThreadDir, "exec-other.png");
          await writeFile(otherFile, otherPngBytes);
          await utimes(otherFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
          return { threadId };
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Buffer.compare(await readFile(join(projectRoot, result.relativePath)), ownPng)).toBe(0);
    expect(existsSync(join(imagesDir, threadId))).toBe(false);
    expect(
      Buffer.compare(await readFile(join(otherThreadDir, "exec-other.png")), otherPngBytes),
    ).toBe(0);
  });

  it("会话 id 带路径分隔符时不拿来拼路径", async () => {
    await setImageGenMode(stores, "codex_subscription");
    const codexHome = join(tempRoot, "codex-home");
    const imagesDir = join(codexHome, "generated_images");
    const outside = join(codexHome, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "x.png"), sourcePng());
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        homeDir: join(tempRoot, "fallback-home"),
        baseEnv: { ...process.env, CODEX_HOME: codexHome },
        launchCodex: async () => ({ threadId: "../outside" }),
      },
    );
    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, "x.png"))).toBe(true);
    expect(existsSync(imagesDir)).toBe(false);
  });

  it("Codex 没出图时把它说的原因带上", async () => {
    await setImageGenMode(stores, "codex_subscription");
    const codexHome = join(tempRoot, "codex-home");
    const result = await generateProjectImage(
      { projectRoot, prompt: "一只红猫" },
      {
        stores,
        homeDir: join(tempRoot, "fallback-home"),
        baseEnv: { ...process.env, CODEX_HOME: codexHome },
        launchCodex: async () => ({
          reason: "Not inside a trusted directory and --skip-git-repo-check was not specified.",
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith(IMAGE_GEN_CODEX_NO_IMAGE_ERROR)).toBe(true);
      expect(result.error).toContain("--skip-git-repo-check");
    }
  });
});

describe("createCodexOutputReader", () => {
  it("从 --json 输出里读出会话 id，原因优先取报错事件", () => {
    const reader = createCodexOutputReader();
    reader.pushStdout('{"type":"thread.started","thread_id":"01a16bf5-2452"}\n{"type":"turn.st');
    reader.pushStdout(
      'arted"}\n{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"好的"}}\n',
    );
    reader.pushStdout('{"type":"turn.failed","error":{"message":"usage limit reached"}}');
    reader.pushStderr("Reading additional input from stdin...\n");
    expect(reader.result()).toEqual({ threadId: "01a16bf5-2452", reason: "usage limit reached" });
  });

  it("没有报错事件时取 stderr，滤掉读 stdin 的提示", () => {
    const reader = createCodexOutputReader();
    reader.pushStderr(
      "Reading additional input from stdin...\nNot inside a trusted directory and --skip-git-repo-check was not specified.\n",
    );
    expect(reader.result()).toEqual({
      reason: "Not inside a trusted directory and --skip-git-repo-check was not specified.",
    });
  });

  it("什么都没有时不给原因", () => {
    const reader = createCodexOutputReader();
    reader.pushStderr("Reading additional input from stdin...\n");
    expect(reader.result()).toEqual({});
  });
});
