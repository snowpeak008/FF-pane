/**
 * providers.json 持久化与 CRUD（W1.5a）：设计文档 §4.1（字段）、§4.3（密钥红线）。
 *
 * 设计决策（W1.5a）：
 * - 整文件读写：providers.json = `{ version, providers[] }`，经 W1.2a 的
 *   writeJsonAtomic 原子写与 readJson 安全读。文件不存在视为空集（首次使用
 *   路径，首个 create 自动落盘建档）；JSON 语法损坏由 W1.2a 隔离为
 *   `<原名>.corrupt-<时间戳>`，本层把 StorageCorruptJsonError 原样抛出向上传递，
 *   下次读取回到干净的空集。
 * - 错误语义：查询（list / get）把 not-found 归一为空集 / undefined——查询
 *   不存在是常态分支；变更（create / update / delete）的业务失败抛
 *   ProviderStoreError 子类，环境事故抛 W1.2a 的 StorageFsError 子类。
 * - id 策略：`provider-` 可读前缀 + 12 位十六进制随机段（crypto.randomBytes
 *   6 字节 = 48 bit），如 `provider-3f2a9c1d8e4b`；生成时对现有 id 查重兜底。
 *   name 允许重复（用户可自由起名），id 由本层生成保证唯一。
 * - updateProvider 是全量替换（id 不变）：exactOptionalPropertyTypes 下
 *   Partial 补丁无法表达「清除可选字段」（如类型切到 cli_login 必须移除
 *   baseUrl / apiKeyRef），且设置页（W3.2a）本就整表单提交。
 * - 密钥红线（§4.3）：本层只经手 ApiKeyRef 不透明引用，密钥本体的加解密
 *   归 W1.5b（apps/desktop 主进程 secrets 模块），两者不互相依赖。
 */

import { randomBytes } from "node:crypto";
import type { Provider, ProviderId } from "@ff-pane/shared";
import { readJson, writeJsonAtomic } from "../fs/index.js";
import { ProviderInUseError, ProviderNotFoundError, ProvidersFileInvalidError } from "./errors.js";
import { type ProviderDraft, validateProviderDraft } from "./validate.js";

/** providers.json 的当前格式版本。未来格式变更时在读入处显式迁移。 */
export const PROVIDERS_FILE_VERSION = 1;

/** providers.json 的整文件结构：版本字段 + 条目数组。 */
export interface ProvidersFile {
  /** 文件格式版本（当前恒为 PROVIDERS_FILE_VERSION）。 */
  readonly version: typeof PROVIDERS_FILE_VERSION;
  /** 全部 Provider 条目。 */
  readonly providers: readonly Provider[];
}

/**
 * 删除保护钩子：返回 true 表示该 Provider 正被引用，deleteProvider 拒删。
 * Profile 引用检查的实现归 W1.6，本层只定义钩子形状；支持同步或异步判定。
 */
export type ProviderInUseCheck = (id: ProviderId) => boolean | Promise<boolean>;

/** Provider CRUD 存取接口（消费方：W1.5c 连接测试、W1.6 Profile、W3.2a 设置页）。 */
export interface ProviderStore {
  /** 列出全部 Provider。文件不存在视为空集（首次使用路径）。 */
  listProviders(): Promise<readonly Provider[]>;
  /** 按 id 查询。不存在返回 undefined（查询是常态分支，不抛错）。 */
  getProvider(id: ProviderId): Promise<Provider | undefined>;
  /** 校验并新增条目，id 由本层生成。返回落盘后的完整 Provider。 */
  createProvider(draft: ProviderDraft): Promise<Provider>;
  /** 校验并全量替换 id 对应的条目（id 不变）。id 不存在抛 ProviderNotFoundError。 */
  updateProvider(id: ProviderId, draft: ProviderDraft): Promise<Provider>;
  /**
   * 删除条目。id 不存在抛 ProviderNotFoundError；
   * 传入 isInUse 且判定被引用时抛 ProviderInUseError（删除保护）。
   */
  deleteProvider(id: ProviderId, isInUse?: ProviderInUseCheck): Promise<void>;
}

const PROVIDER_ID_PREFIX = "provider";
const PROVIDER_ID_RANDOM_BYTES = 6;

/** 生成新的 Provider ID：可读前缀 + 随机段，对现有 id 查重（见模块注释）。 */
function generateProviderId(existingIds: ReadonlySet<string>): ProviderId {
  let id: string;
  do {
    id = `${PROVIDER_ID_PREFIX}-${randomBytes(PROVIDER_ID_RANDOM_BYTES).toString("hex")}`;
  } while (existingIds.has(id));
  return id as ProviderId;
}

/** 读入整文件并做结构检查。not-found 归一为空集，其余失败抛 typed error。 */
async function loadProviders(providersFile: string): Promise<readonly Provider[]> {
  const result = await readJson<unknown>(providersFile);
  if (!result.ok) {
    if (result.error.code === "not-found") {
      return [];
    }
    throw result.error;
  }
  const raw = result.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProvidersFileInvalidError(providersFile, "顶层必须是对象");
  }
  const file = raw as { readonly version?: unknown; readonly providers?: unknown };
  if (file.version !== PROVIDERS_FILE_VERSION) {
    throw new ProvidersFileInvalidError(
      providersFile,
      `不支持的 version：${String(file.version)}（当前支持 ${PROVIDERS_FILE_VERSION}）`,
    );
  }
  if (!Array.isArray(file.providers)) {
    throw new ProvidersFileInvalidError(providersFile, "providers 必须是数组");
  }
  // JSON 边界：条目写入时已经过校验，按 W1.1 约定 as 断言收窄品牌类型
  return file.providers as readonly Provider[];
}

/** 整文件原子写回（版本字段 + 条目数组）。 */
async function saveProviders(providersFile: string, providers: readonly Provider[]): Promise<void> {
  const file: ProvidersFile = { version: PROVIDERS_FILE_VERSION, providers };
  await writeJsonAtomic(providersFile, file);
}

/**
 * 创建绑定到指定 providers.json 路径的 ProviderStore。
 * 路径由宿主注入（接线示例：`createProviderStore(resolveGlobalLayout(root).providersFile)`），
 * 与 W1.2a 布局层「根目录一律参数注入」的约定一致。
 */
export function createProviderStore(providersFile: string): ProviderStore {
  return {
    async listProviders(): Promise<readonly Provider[]> {
      return loadProviders(providersFile);
    },

    async getProvider(id: ProviderId): Promise<Provider | undefined> {
      const providers = await loadProviders(providersFile);
      return providers.find((provider) => provider.id === id);
    },

    async createProvider(draft: ProviderDraft): Promise<Provider> {
      validateProviderDraft(draft);
      const providers = await loadProviders(providersFile);
      const id = generateProviderId(new Set(providers.map((provider) => provider.id)));
      const created: Provider = { ...draft, id };
      await saveProviders(providersFile, [...providers, created]);
      return created;
    },

    async updateProvider(id: ProviderId, draft: ProviderDraft): Promise<Provider> {
      validateProviderDraft(draft);
      const providers = await loadProviders(providersFile);
      const index = providers.findIndex((provider) => provider.id === id);
      if (index === -1) {
        throw new ProviderNotFoundError(id);
      }
      const updated: Provider = { ...draft, id };
      await saveProviders(providersFile, providers.with(index, updated));
      return updated;
    },

    async deleteProvider(id: ProviderId, isInUse?: ProviderInUseCheck): Promise<void> {
      const providers = await loadProviders(providersFile);
      if (!providers.some((provider) => provider.id === id)) {
        throw new ProviderNotFoundError(id);
      }
      if (isInUse !== undefined && (await isInUse(id))) {
        throw new ProviderInUseError(id);
      }
      await saveProviders(
        providersFile,
        providers.filter((provider) => provider.id !== id),
      );
    },
  };
}
