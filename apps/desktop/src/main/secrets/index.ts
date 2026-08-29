/**
 * 密钥模块（W1.5b）：密钥红线（设计文档 §4.3、技术选型 §6）的实现载体。
 * 密钥本体只在主进程内存在，其余一切系统只经手 ApiKeyRef 不透明引用。
 *
 * 消费方索引：
 * - W1.5c 连接测试、W2.7b 子进程 env 注入：主进程内调用 revealSecret 取明文，用完即弃；
 * - W3.2a 设置页 IPC：只暴露 store / delete / has / maskedTail，revealSecret 永不上通道。
 *
 * 注意：本 index 会再导出依赖 electron 的真实后端；Node 环境（vitest）
 * 需直接从 ./store、./errors、./backend 子模块导入。
 */

export type { EncryptionBackend } from "./backend";
export * from "./errors";
export { createSafeStorageBackend } from "./safe-storage-backend";
export { runSecretsCheck } from "./smoke-check";
export type { SecretStore } from "./store";
export {
  createSecretStore,
  resolveSecretsFile,
  SECRETS_FILE_NAME,
  SECRETS_FILE_VERSION,
} from "./store";
