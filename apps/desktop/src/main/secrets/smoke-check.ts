import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeStorageBackend } from "./safe-storage-backend";
import { createSecretStore, resolveSecretsFile } from "./store";

/**
 * 冒烟自测（smoke.ts 的 secrets-roundtrip 项）：在真实 safeStorage 后端上完成
 * store→reveal 往返 + maskedTail + delete，作为 DPAPI 在 Electron 内可用的持续回归证据。
 * 密文文件放系统临时目录、用完整体删除，不触碰用户真实的 ~/.aiworkbench；
 * 明文为随机冒烟值，失败信息一律不回显内容（红线纪律不因测试数据松动）。
 * 全部通过返回描述文字，任一步失败抛错（由调用方打印 FAIL 行）。
 */
export async function runSecretsCheck(): Promise<string> {
  const backend = createSafeStorageBackend();
  if (!backend.isAvailable()) {
    throw new Error("safeStorage.isEncryptionAvailable() 返回 false，真实加密后端不可用");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "ff-pane-smoke-secrets-"));
  try {
    const store = createSecretStore({ backend, secretsFile: resolveSecretsFile(tempRoot) });
    const plaintext = `冒烟密钥-${randomUUID()}`;
    const ref = await store.storeSecret(plaintext);
    if ((await store.revealSecret(ref)) !== plaintext) {
      throw new Error("store→reveal 往返结果与存入明文不一致（内容不回显）");
    }
    const expectedTail = Array.from(plaintext).slice(-4).join("");
    if ((await store.maskedTail(ref)) !== expectedTail) {
      throw new Error("maskedTail 未返回明文尾 4 位（内容不回显）");
    }
    await store.deleteSecret(ref);
    if (await store.hasSecret(ref)) {
      throw new Error("deleteSecret 后 hasSecret 仍为 true");
    }
    let revealAfterDeleteFailed = false;
    try {
      await store.revealSecret(ref);
    } catch {
      revealAfterDeleteFailed = true;
    }
    if (!revealAfterDeleteFailed) {
      throw new Error("deleteSecret 后 revealSecret 未按预期报错");
    }
    return "safeStorage 加密 store→reveal 往返、maskedTail 尾 4 位、delete 后拒读全部通过";
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
