/**
 * 密钥库（W1.5b）：密文文件 secrets.json 的读写与不透明引用管理。
 *
 * 密钥红线（设计文档 §4.3 / 技术选型 §6）在本模块的落点：
 * - 明文只在「调用方入参 → 加密」与「解密 → 返回调用方」两个瞬间存在于主进程内存，
 *   永不写入文件、日志与错误信息；
 * - 持久化的 secrets.json 只含 EncryptionBackend 产出的密文（base64），
 *   经 @ff-pane/storage 原子写读（崩溃不产生半文件、损坏自动隔离）；
 * - 对外一切系统（renderer、配置文件、Handoff…）只经手 ApiKeyRef 不透明引用。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApiKeyRef } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "@ff-pane/storage";
import type { EncryptionBackend } from "./backend";
import {
  SecretDecryptError,
  SecretEncryptError,
  SecretNotFoundError,
  SecretsBackendUnavailableError,
  SecretsFileInvalidError,
} from "./errors";

/** 密文文件名。位于全局布局根目录（GlobalLayout.rootDir，设计文档 §10.1）下。 */
export const SECRETS_FILE_NAME = "secrets.json";

/** secrets.json 当前格式版本（顶层 version 字段）。 */
export const SECRETS_FILE_VERSION = 1;

/** maskedTail 展示的明文尾部长度（设计文档 §4.3 规则 3：界面只显示尾 4 位）。 */
const MASKED_TAIL_LENGTH = 4;

/** 不透明引用前缀。仅便于人眼在 providers.json 里辨认字段性质，不承载任何语义。 */
const REF_PREFIX = "key-";

/**
 * 由全局布局根目录解析密文文件路径。
 * GlobalLayout 类型归 @ff-pane/storage（W1.2a），本工单不改其结构，故在此派生。
 */
export function resolveSecretsFile(globalRootDir: string): string {
  return join(globalRootDir, SECRETS_FILE_NAME);
}

/** 密钥库 API。所有方法都可能抛 SecretsError 子类或 @ff-pane/storage 的 StorageFsError 子类。 */
export interface SecretStore {
  /**
   * 加密并持久化明文，返回新生成的不透明引用。
   * 后端不可用时抛 SecretsBackendUnavailableError——绝不明文落盘（宁可不能用）。
   */
  storeSecret(plaintext: string): Promise<ApiKeyRef>;
  /**
   * 解密返回明文。仅限主进程内部调用方（如 W2.7b 的子进程 env 注入）；
   * 明文严禁经 IPC 送往 renderer。引用不存在抛 SecretNotFoundError。
   */
  revealSecret(ref: ApiKeyRef): Promise<string>;
  /** 删除引用对应的密文。幂等：引用不存在视为成功。 */
  deleteSecret(ref: ApiKeyRef): Promise<void>;
  /** 引用是否存在。只查密文文件，不触碰加密后端（后端不可用时也能回答）。 */
  hasSecret(ref: ApiKeyRef): Promise<boolean>;
  /**
   * 明文尾 4 位（按 Unicode 码点计数），供 UI 展示。
   * 明文不足 4 位时返回空串——返回全部内容等于泄露整个密钥，UI 应显示占位符。
   */
  maskedTail(ref: ApiKeyRef): Promise<string>;
}

/** secrets.json 顶层结构（版本 1）：version + { ref: base64 密文 } 映射。 */
interface SecretsFileV1 {
  readonly version: typeof SECRETS_FILE_VERSION;
  readonly secrets: Readonly<Record<string, string>>;
}

function generateRef(): string {
  return `${REF_PREFIX}${randomUUID()}`;
}

/**
 * 校验并解析 secrets.json 内容（用户可能手改坏文件，属系统边界输入）。
 * 红线：错误信息只描述结构性原因，不回显任何条目内容。
 */
function parseSecretsFile(path: string, raw: unknown): Map<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SecretsFileInvalidError(path, "顶层不是 JSON 对象");
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== SECRETS_FILE_VERSION) {
    throw new SecretsFileInvalidError(path, `version 字段不是 ${SECRETS_FILE_VERSION}`);
  }
  const rawSecrets = record["secrets"];
  if (typeof rawSecrets !== "object" || rawSecrets === null || Array.isArray(rawSecrets)) {
    throw new SecretsFileInvalidError(path, "secrets 字段不是对象");
  }
  const secrets = new Map<string, string>();
  for (const [ref, cipherBase64] of Object.entries(rawSecrets)) {
    if (typeof cipherBase64 !== "string") {
      throw new SecretsFileInvalidError(path, `引用 ${ref} 对应的密文不是字符串`);
    }
    secrets.set(ref, cipherBase64);
  }
  return secrets;
}

/** 创建密钥库。宿主接线示例：`createSecretStore({ backend, secretsFile: resolveSecretsFile(layout.rootDir) })`。 */
export function createSecretStore(options: {
  readonly backend: EncryptionBackend;
  readonly secretsFile: string;
}): SecretStore {
  const { backend, secretsFile } = options;

  // 变更操作串行化：storeSecret / deleteSecret 是「读全文 → 改 → 原子写回」，
  // 并发交错会相互覆盖丢失条目；主进程单实例内用 promise 链充当互斥即可。
  let mutationChain: Promise<unknown> = Promise.resolve();
  function serializeMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(task, task);
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function load(): Promise<Map<string, string>> {
    const result = await readJson(secretsFile);
    if (!result.ok) {
      if (result.error.code === "not-found") {
        // 首次使用（或损坏隔离后的重建起点）：空库
        return new Map();
      }
      // corrupt-json（原文件已被 readJson 重命名隔离，下次读取即 not-found 重建）
      // 与 io-error 原样上抛：复用 storage 层错误语义，信息只含路径、不含密文
      throw result.error;
    }
    return parseSecretsFile(secretsFile, result.value);
  }

  async function save(secrets: Map<string, string>): Promise<void> {
    const data: SecretsFileV1 = {
      version: SECRETS_FILE_VERSION,
      secrets: Object.fromEntries(secrets),
    };
    await writeJsonAtomic(secretsFile, data);
  }

  function ensureBackendAvailable(): void {
    if (!backend.isAvailable()) {
      throw new SecretsBackendUnavailableError();
    }
  }

  async function reveal(ref: string): Promise<string> {
    const secrets = await load();
    const cipherBase64 = secrets.get(ref);
    if (cipherBase64 === undefined) {
      throw new SecretNotFoundError(ref);
    }
    ensureBackendAvailable();
    try {
      return backend.decrypt(Buffer.from(cipherBase64, "base64"));
    } catch (cause) {
      throw new SecretDecryptError(ref, { cause });
    }
  }

  return {
    storeSecret: (plaintext) =>
      serializeMutation(async () => {
        // 先验后端可用性、先完成加密，全部成功后才碰文件：任何失败路径都无明文落盘可能
        ensureBackendAvailable();
        let cipherBase64: string;
        try {
          cipherBase64 = backend.encrypt(plaintext).toString("base64");
        } catch (cause) {
          throw new SecretEncryptError({ cause });
        }
        const secrets = await load();
        let ref = generateRef();
        while (secrets.has(ref)) {
          // UUID v4 碰撞概率可忽略，此循环只是零成本的确定性保证
          ref = generateRef();
        }
        secrets.set(ref, cipherBase64);
        await save(secrets);
        return ref as ApiKeyRef;
      }),

    revealSecret: (ref) => reveal(ref),

    deleteSecret: (ref) =>
      serializeMutation(async () => {
        const secrets = await load();
        if (!secrets.delete(ref)) {
          return; // 幂等：不存在视为已删除
        }
        await save(secrets);
      }),

    hasSecret: async (ref) => {
      const secrets = await load();
      return secrets.has(ref);
    },

    maskedTail: async (ref) => {
      const plaintext = await reveal(ref);
      // 按 Unicode 码点切尾，避免把中文 / emoji 从代理对中间截断
      const codePoints = Array.from(plaintext);
      if (codePoints.length < MASKED_TAIL_LENGTH) {
        return "";
      }
      return codePoints.slice(-MASKED_TAIL_LENGTH).join("");
    },
  };
}
