/**
 * W1.5b 单测：密钥库核心逻辑，走可逆假后端 + mkdtemp 临时目录真实读写。
 * 真实 safeStorage 后端在 Node 下不可用，由 pnpm smoke 的 secrets-roundtrip 回归。
 * 注意：不 import ../src/main/secrets/index（它再导出依赖 electron 的真实后端），
 * 一律从子模块直接导入。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiKeyRef } from "@ff-pane/shared";
import { StorageCorruptJsonError } from "@ff-pane/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EncryptionBackend } from "../src/main/secrets/backend";
import {
  SecretNotFoundError,
  SecretsBackendUnavailableError,
  SecretsFileInvalidError,
} from "../src/main/secrets/errors";
import {
  createSecretStore,
  resolveSecretsFile,
  SECRETS_FILE_NAME,
  SECRETS_FILE_VERSION,
} from "../src/main/secrets/store";

/** 可逆假后端：前缀 + UTF-8 原文。密钥库只关心「加密可逆」，不关心具体算法。 */
function createFakeBackend(available = true): EncryptionBackend {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => Buffer.from(`fake:${plaintext}`, "utf8"),
    decrypt: (ciphertext) => {
      const text = ciphertext.toString("utf8");
      if (!text.startsWith("fake:")) {
        throw new Error("假后端：密文前缀不符，无法解密");
      }
      return text.slice("fake:".length);
    },
  };
}

let tempRoot: string;
let secretsFile: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-secrets-"));
  secretsFile = resolveSecretsFile(tempRoot);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function createStore(backend: EncryptionBackend = createFakeBackend()) {
  return createSecretStore({ backend, secretsFile });
}

describe("store→reveal 往返", () => {
  it("ASCII 密钥完整往返", async () => {
    const store = createStore();
    const plaintext = "sk-test-1234567890abcdefghij";
    const ref = await store.storeSecret(plaintext);
    expect(await store.revealSecret(ref)).toBe(plaintext);
    expect(await store.hasSecret(ref)).toBe(true);
  });

  it("中文与 emoji 混合密钥完整往返（风险 R5：全链路 UTF-8）", async () => {
    const store = createStore();
    const plaintext = "中文密钥-🔑-abc123-测试值";
    const ref = await store.storeSecret(plaintext);
    expect(await store.revealSecret(ref)).toBe(plaintext);
  });

  it("长密钥（2000 字符）完整往返", async () => {
    const store = createStore();
    const plaintext = `sk-${"x7f9".repeat(499)}末`;
    expect(plaintext.length).toBe(2000);
    const ref = await store.storeSecret(plaintext);
    expect(await store.revealSecret(ref)).toBe(plaintext);
  });

  it("密文文件为「版本 + { ref: base64 密文 } 映射」结构，且不含明文原文", async () => {
    const store = createStore();
    const plaintext = "sk-secret-plain-999";
    const ref = await store.storeSecret(plaintext);
    const rawText = await readFile(secretsFile, "utf8");
    expect(rawText).not.toContain(plaintext);
    const parsed = JSON.parse(rawText) as { version: number; secrets: Record<string, string> };
    expect(parsed.version).toBe(SECRETS_FILE_VERSION);
    expect(Object.keys(parsed.secrets)).toEqual([ref]);
    const cipherBase64 = parsed.secrets[ref];
    expect(typeof cipherBase64).toBe("string");
    // base64 可还原为假后端密文，证明落盘的确是加密产物
    expect(Buffer.from(cipherBase64 ?? "", "base64").toString("utf8")).toBe(`fake:${plaintext}`);
  });
});

describe("ref 生成", () => {
  it("并发 store 产生互不重复的不透明 ref，且条目互不覆盖", async () => {
    const store = createStore();
    const plaintexts = Array.from({ length: 20 }, (_, i) => `密钥-${i}`);
    const refs = await Promise.all(plaintexts.map((p) => store.storeSecret(p)));
    expect(new Set(refs).size).toBe(refs.length);
    for (const [i, ref] of refs.entries()) {
      expect(ref.length).toBeGreaterThan(0);
      expect(await store.revealSecret(ref)).toBe(plaintexts[i]);
    }
  });
});

describe("deleteSecret", () => {
  it("delete 后 reveal 报 SecretNotFoundError，hasSecret 为 false", async () => {
    const store = createStore();
    const ref = await store.storeSecret("sk-to-delete");
    await store.deleteSecret(ref);
    expect(await store.hasSecret(ref)).toBe(false);
    await expect(store.revealSecret(ref)).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("delete 不存在的 ref 幂等成功", async () => {
    const store = createStore();
    await expect(store.deleteSecret("key-不存在" as ApiKeyRef)).resolves.toBeUndefined();
  });

  it("delete 只移除目标 ref，其余密钥不受影响", async () => {
    const store = createStore();
    const refA = await store.storeSecret("密钥甲");
    const refB = await store.storeSecret("密钥乙");
    await store.deleteSecret(refA);
    expect(await store.hasSecret(refA)).toBe(false);
    expect(await store.revealSecret(refB)).toBe("密钥乙");
  });
});

describe("maskedTail", () => {
  it("明文 ≥4 位时返回尾 4 位", async () => {
    const store = createStore();
    const ref = await store.storeSecret("sk-abcdef-1234");
    expect(await store.maskedTail(ref)).toBe("1234");
  });

  it("按 Unicode 码点切尾，中文与 emoji 不被截断", async () => {
    const store = createStore();
    const ref = await store.storeSecret("prefix-密钥🔑尾");
    expect(await store.maskedTail(ref)).toBe("密钥🔑尾");
  });

  it("明文恰好 4 位时返回完整 4 位", async () => {
    const store = createStore();
    const ref = await store.storeSecret("abcd");
    expect(await store.maskedTail(ref)).toBe("abcd");
  });

  it("明文不足 4 位时返回空串，不泄露短明文", async () => {
    const store = createStore();
    const ref = await store.storeSecret("abc");
    expect(await store.maskedTail(ref)).toBe("");
  });
});

describe("加密后端不可用（isAvailable=false）", () => {
  it("storeSecret 明确拒绝且不产生任何落盘文件（不做明文降级存储）", async () => {
    const store = createStore(createFakeBackend(false));
    await expect(store.storeSecret("sk-must-not-persist")).rejects.toBeInstanceOf(
      SecretsBackendUnavailableError,
    );
    expect(await readdir(tempRoot)).not.toContain(SECRETS_FILE_NAME);
  });

  it("拒绝信息可理解且不含明文", async () => {
    const store = createStore(createFakeBackend(false));
    const thrown = await store.storeSecret("sk-must-not-leak").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SecretsBackendUnavailableError);
    const message = (thrown as Error).message;
    expect(message).toContain("不做明文降级存储");
    expect(message).not.toContain("sk-must-not-leak");
  });

  it("revealSecret / maskedTail 同样拒绝，但 hasSecret 不依赖后端仍可用", async () => {
    const ref = await createStore().storeSecret("sk-stored-earlier");
    const offlineStore = createStore(createFakeBackend(false));
    await expect(offlineStore.revealSecret(ref)).rejects.toBeInstanceOf(
      SecretsBackendUnavailableError,
    );
    await expect(offlineStore.maskedTail(ref)).rejects.toBeInstanceOf(
      SecretsBackendUnavailableError,
    );
    expect(await offlineStore.hasSecret(ref)).toBe(true);
  });
});

describe("密文文件损坏与结构异常", () => {
  it("JSON 损坏：报 StorageCorruptJsonError、原文件隔离、随后按空库重建", async () => {
    await writeFile(secretsFile, "{损坏的 json", "utf8");
    const store = createStore();
    await expect(store.hasSecret("key-any" as ApiKeyRef)).rejects.toBeInstanceOf(
      StorageCorruptJsonError,
    );
    // 复用 storage 隔离语义：原文件已重命名为 secrets.json.corrupt-<时间戳>
    const entries = await readdir(tempRoot);
    expect(entries.some((name) => name.startsWith(`${SECRETS_FILE_NAME}.corrupt-`))).toBe(true);
    expect(entries).not.toContain(SECRETS_FILE_NAME);
    // 隔离后按「首次初始化」路径重建，密钥库恢复可用
    const ref = await store.storeSecret("重建后的密钥");
    expect(await store.revealSecret(ref)).toBe("重建后的密钥");
  });

  it("结构不符（version 错误）：报 SecretsFileInvalidError，信息含路径与结构原因", async () => {
    await writeFile(secretsFile, JSON.stringify({ version: 99, secrets: {} }), "utf8");
    const store = createStore();
    const thrown = await store.hasSecret("key-any" as ApiKeyRef).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SecretsFileInvalidError);
    expect((thrown as SecretsFileInvalidError).path).toBe(secretsFile);
    expect((thrown as Error).message).toContain("version");
  });

  it("结构不符（secrets 含非字符串条目）：报错且不回显条目内容", async () => {
    await writeFile(
      secretsFile,
      JSON.stringify({ version: 1, secrets: { "key-x": 12345 } }),
      "utf8",
    );
    const store = createStore();
    const thrown = await store.revealSecret("key-x" as ApiKeyRef).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SecretsFileInvalidError);
    expect((thrown as Error).message).not.toContain("12345");
  });
});
