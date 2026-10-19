/**
 * 生图设置的读写。
 * 密钥明文只在保存或测试这一次调用里出现：进系统密钥库，不进 GlobalConfig，不进日志。
 * 测试会要一张 PNG，成功后丢掉字节，不写入任何项目目录。
 */

import { redactSecret } from "@ff-pane/core";
import {
  type ApiKeyRef,
  type GlobalConfig,
  type ImageGenSettings,
  imageGenModeOf,
  isHttpImageGenBaseUrl,
  isImageGenMode,
} from "@ff-pane/shared";
import type { ImageGenView, TestImageGenRelayResponse } from "../../shared-ipc/contracts";
import { generateImagePng } from "./openai-images";

/** 设置里的连通性测试只用这一句，避免误扣一长段额度。 */
export const IMAGE_GEN_TEST_PROMPT = "a red square";

/** 表单不完整。message 不含密钥。 */
export class ImageGenInputError extends Error {
  readonly code = "image-gen-input" as const;
  readonly field: "mode" | "baseUrl" | "model" | "apiKey";

  constructor(field: ImageGenInputError["field"], message: string) {
    super(message);
    this.name = "ImageGenInputError";
    this.field = field;
  }
}

/** 生图设置要碰的存储。测试可以换上临时目录里的实现。 */
export interface ImageGenStores {
  readConfig(): Promise<GlobalConfig>;
  updateConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig>;
  storeSecret(plaintext: string): Promise<ApiKeyRef>;
  revealSecret(ref: ApiKeyRef): Promise<string>;
  deleteSecret(ref: ApiKeyRef): Promise<void>;
  hasSecret(ref: ApiKeyRef): Promise<boolean>;
  maskedTail(ref: ApiKeyRef): Promise<string>;
}

/** 中转站表单。apiKey 留空或不传 = 不更换已保存的密钥。 */
export interface ImageGenRelayInput {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

export interface ImageGenTestOptions {
  readonly fetchImpl?: typeof fetch;
}

async function toView(
  stores: ImageGenStores,
  settings: ImageGenSettings | undefined,
): Promise<ImageGenView> {
  const relay = settings?.relay;
  let hasKey = false;
  let keyTail = "";
  if (relay !== undefined && (await stores.hasSecret(relay.apiKeyRef))) {
    hasKey = true;
    try {
      keyTail = await stores.maskedTail(relay.apiKeyRef);
    } catch {
      keyTail = "";
    }
  }
  return {
    mode: imageGenModeOf(settings),
    baseUrl: relay?.baseUrl ?? "",
    model: relay?.model ?? "",
    hasKey,
    keyTail,
  };
}

/** 当前方案、已存的中转站地址和模型名、密钥是否在、尾号。不返回密钥。 */
export async function readImageGenView(stores: ImageGenStores): Promise<ImageGenView> {
  const config = await stores.readConfig();
  return toView(stores, config.imageGen);
}

/** 立刻改方案。不删除已经写下的中转站。 */
export async function setImageGenMode(
  stores: ImageGenStores,
  mode: unknown,
): Promise<ImageGenView> {
  if (!isImageGenMode(mode)) {
    throw new ImageGenInputError("mode", "生图方案只能是先不生图、Codex 订阅或中转站");
  }
  const updated = await stores.updateConfig({ imageGen: { mode } });
  return toView(stores, updated.imageGen);
}

function checkedRelayFields(input: ImageGenRelayInput): {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
} {
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const apiKey = input.apiKey?.trim() ?? "";
  if (baseUrl === "") {
    throw new ImageGenInputError("baseUrl", "请填写地址");
  }
  if (!isHttpImageGenBaseUrl(baseUrl)) {
    throw new ImageGenInputError("baseUrl", "地址要写成 http 或 https 链接");
  }
  if (model === "") {
    throw new ImageGenInputError("model", "请填写模型名");
  }
  return { baseUrl, model, apiKey };
}

/** 保存中转站。新密钥加密后只把引用写进设置。 */
export async function saveImageGenRelay(
  stores: ImageGenStores,
  input: ImageGenRelayInput,
): Promise<ImageGenView> {
  const fields = checkedRelayFields(input);
  const current = await stores.readConfig();
  const existingRef = current.imageGen?.relay?.apiKeyRef;
  const hasExisting = existingRef !== undefined && (await stores.hasSecret(existingRef));
  if (fields.apiKey === "" && !hasExisting) {
    throw new ImageGenInputError("apiKey", "请填写密钥");
  }

  let nextRef = existingRef;
  let created: ApiKeyRef | undefined;
  if (fields.apiKey !== "") {
    created = await stores.storeSecret(fields.apiKey);
    nextRef = created;
  }
  if (nextRef === undefined) {
    throw new ImageGenInputError("apiKey", "请填写密钥");
  }

  const mode = imageGenModeOf(current.imageGen);
  try {
    const updated = await stores.updateConfig({
      imageGen: {
        mode,
        relay: { baseUrl: fields.baseUrl, model: fields.model, apiKeyRef: nextRef },
      },
    });
    if (created !== undefined && existingRef !== undefined && existingRef !== created) {
      try {
        await stores.deleteSecret(existingRef);
      } catch {
        // 旧密文清不掉不影响已保存的新密钥。异常原文可能夹路径，不往外带。
      }
    }
    return toView(stores, updated.imageGen);
  } catch (error) {
    if (created !== undefined) {
      try {
        await stores.deleteSecret(created);
      } catch {
        // 回滚失败也不能把密钥写进错误信息。
      }
    }
    throw error;
  }
}

/**
 * 用这一次传入的地址、密钥、模型名试一张图。
 * 密钥留空则用已保存的。成功后丢掉图片字节。不写设置，也不写项目目录。
 */
export async function testImageGenRelay(
  stores: ImageGenStores,
  input: ImageGenRelayInput,
  options?: ImageGenTestOptions,
): Promise<TestImageGenRelayResponse> {
  const typedKey = input.apiKey?.trim() ?? "";
  let baseUrl = "";
  let model = "";
  let apiKey = typedKey;
  try {
    const fields = checkedRelayFields(input);
    baseUrl = fields.baseUrl;
    model = fields.model;
    apiKey = fields.apiKey;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "请把地址、密钥和模型名填完整";
    return { ok: false, reason: redactSecret(reason, typedKey) };
  }

  if (apiKey === "") {
    try {
      const current = await stores.readConfig();
      const ref = current.imageGen?.relay?.apiKeyRef;
      if (ref === undefined || !(await stores.hasSecret(ref))) {
        return { ok: false, reason: "请填写密钥" };
      }
      apiKey = await stores.revealSecret(ref);
    } catch {
      return { ok: false, reason: "已保存的密钥读不出来，请重新填写后再试" };
    }
  }

  const started = Date.now();
  try {
    const bytes = await generateImagePng({
      baseUrl,
      apiKey,
      model,
      prompt: IMAGE_GEN_TEST_PROMPT,
      ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    bytes.fill(0);
    return { ok: true, elapsedMs: Math.max(0, Date.now() - started) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "测试没有成功";
    return { ok: false, reason: redactSecret(reason, apiKey) };
  }
}
