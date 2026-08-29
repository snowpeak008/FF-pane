import { safeStorage } from "electron";
import type { EncryptionBackend } from "./backend";

/**
 * 真实加密后端：薄封装 Electron safeStorage（技术选型 §6）。
 * Windows 底层为 DPAPI（绑定当前用户账户），macOS Keychain / Linux libsecret。
 * 只能在 Electron 主进程调用（app ready 之后）；Node 单测环境拿不到 safeStorage，
 * 本实现的可用性由 pnpm smoke 的 secrets-roundtrip 自测持续回归。
 */
export function createSafeStorageBackend(): EncryptionBackend {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
}
