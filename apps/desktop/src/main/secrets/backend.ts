/**
 * 加密后端抽象（W1.5b）：隔离 Electron safeStorage 依赖，使密钥库核心逻辑
 * 可在 Node（vitest）下用可逆假后端测试。
 * 真实后端（safe-storage-backend.ts）只在 Electron 主进程内可用，
 * 其可用性由 pnpm smoke 的 secrets-roundtrip 自测持续回归。
 */

/** 加密后端：明文 ↔ 密文的最小能力面。实现不得向任何日志 / 错误信息输出明文或密文。 */
export interface EncryptionBackend {
  /** 当前环境加密能力是否可用（Windows=DPAPI 几乎总是可用，但每次操作前仍必须显式检查）。 */
  isAvailable(): boolean;
  /** 加密明文。仅应在 isAvailable() 为 true 时调用；失败抛出的异常不含明文。 */
  encrypt(plaintext: string): Buffer;
  /** 解密密文。仅应在 isAvailable() 为 true 时调用；失败抛出的异常不含明文与密文。 */
  decrypt(ciphertext: Buffer): string;
}
