/**
 * 生图设置读写：密钥进密钥库，不进 config.json，测试不落盘、不代替保存。
 * fetch 全部 mock，不访问真实中转站，也不探测 Codex。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore, resolveGlobalLayout } from "@ff-pane/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_GEN_TEST_PROMPT,
  ImageGenInputError,
  type ImageGenStores,
  readImageGenView,
  saveImageGenRelay,
  setImageGenMode,
  testImageGenRelay,
} from "../src/main/image-gen/settings";
import type { EncryptionBackend } from "../src/main/secrets/backend";
import { createSecretStore, resolveSecretsFile } from "../src/main/secrets/store";

const SECRET = "sk-test-image-key-should-not-leak";
const OTHER_SECRET = "sk-other-image-key-not-saved";
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
let configFile: string;
let stores: ImageGenStores;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-image-gen-"));
  const layout = resolveGlobalLayout(join(tempRoot, ".aiworkbench"));
  configFile = layout.configFile;
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
  await rm(tempRoot, { recursive: true, force: true });
});

function pngFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("生图设置存储", () => {
  it("缺省是先不生图，视图不含密钥字段", async () => {
    const view = await readImageGenView(stores);
    expect(view).toEqual({
      mode: "off",
      baseUrl: "",
      model: "",
      hasKey: false,
      keyTail: "",
    });
    expect(view).not.toHaveProperty("apiKey");
  });

  it("保存中转站后 config.json 只有引用，明文在密钥库", async () => {
    const view = await saveImageGenRelay(stores, {
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-2",
      apiKey: SECRET,
    });
    expect(view).toMatchObject({
      mode: "off",
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-2",
      hasKey: true,
      keyTail: "leak",
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const raw = await readFile(configFile, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('"apiKey"');
    const config = await stores.readConfig();
    const ref = config.imageGen?.relay?.apiKeyRef;
    expect(ref).toBeDefined();
    if (ref !== undefined) {
      expect(await stores.revealSecret(ref)).toBe(SECRET);
    }
  });

  it("换方案后中转站还在，再保存时空密钥表示不改", async () => {
    await saveImageGenRelay(stores, {
      baseUrl: "https://relay.example/v1",
      model: "gpt-image-2",
      apiKey: SECRET,
    });
    const off = await setImageGenMode(stores, "off");
    expect(off.mode).toBe("off");
    expect(off.hasKey).toBe(true);
    expect(off.keyTail).toBe("leak");
    const rawOff = await readFile(configFile, "utf8");
    expect(rawOff).not.toContain(SECRET);
    const again = await saveImageGenRelay(stores, {
      baseUrl: "https://relay.example/v1/images/generations",
      model: "gpt-image-2",
    });
    expect(again.baseUrl).toBe("https://relay.example/v1/images/generations");
    expect(again.keyTail).toBe("leak");
    const config = await stores.readConfig();
    const ref = config.imageGen?.relay?.apiKeyRef;
    expect(ref).toBeDefined();
    if (ref !== undefined) {
      expect(await stores.revealSecret(ref)).toBe(SECRET);
    }
    expect(config.imageGen?.mode).toBe("off");
  });

  it("拒绝界面之外的方案，缺密钥时不落盘", async () => {
    await expect(setImageGenMode(stores, "local_sd")).rejects.toBeInstanceOf(ImageGenInputError);
    await expect(
      saveImageGenRelay(stores, {
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-2",
      }),
    ).rejects.toBeInstanceOf(ImageGenInputError);
    await expect(readFile(configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("测试出图后丢掉字节，不写 png，也不把未保存的密钥写进设置", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await saveImageGenRelay(stores, {
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-2",
        apiKey: SECRET,
      });
      await setImageGenMode(stores, "relay");
      let seenPrompt = "";
      const fetchImpl: typeof fetch = async (_input, init) => {
        seenPrompt = (JSON.parse(String(init?.body)) as { prompt?: string }).prompt ?? "";
        return pngFetch()(_input, init);
      };
      const ok = await testImageGenRelay(
        stores,
        { baseUrl: "https://relay.example/v1", model: "gpt-image-2" },
        { fetchImpl },
      );
      expect(ok).toEqual({ ok: true, elapsedMs: expect.any(Number) });
      expect(seenPrompt).toBe(IMAGE_GEN_TEST_PROMPT);
      expect(JSON.stringify(ok)).not.toContain(PNG_B64);
      expect(JSON.stringify(ok)).not.toContain(SECRET);

      const unsaved = await testImageGenRelay(
        stores,
        {
          baseUrl: "https://other.example/v1",
          model: "other-model",
          apiKey: OTHER_SECRET,
        },
        { fetchImpl: pngFetch() },
      );
      expect(unsaved.ok).toBe(true);
      const raw = await readFile(configFile, "utf8");
      expect(raw).not.toContain(OTHER_SECRET);
      expect(raw).not.toContain("other.example");
      expect(raw).not.toContain(SECRET);
      const names = await readdir(tempRoot, { recursive: true });
      expect(names.filter((name) => String(name).endsWith(".png"))).toEqual([]);
      const logged = JSON.stringify([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls]);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(OTHER_SECRET);
    } finally {
      log.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
  });

  it("测试失败的原因不含密钥", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: `rejected ${OTHER_SECRET}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const result = await testImageGenRelay(
      stores,
      {
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-2",
        apiKey: OTHER_SECRET,
      },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(OTHER_SECRET);
      expect(result.reason).toContain("已脱敏");
    }
    await expect(readFile(configFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
