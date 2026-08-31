/**
 * 知识库嵌入能力解析（T6.5）：从 Provider 列表里挑出一个能发 /embeddings 的，
 * 取出密钥，构造 T6.3 的 Embedder；挑不出来就如实说明为什么。
 *
 * **「挑不出来」是一等公民，不是错误**（§8.3.3「向量检索是增强，不是前提」）：
 * 返回值是判别联合，逼着调用方写出「没有嵌入器就只建 FTS」那条分支，
 * 而不是让它拿一个空对象继续往下走。
 *
 * 选谁：**Provider 列表里第一个满足条件的**（已启用 · openai_compatible ·
 * 配了 embeddingModel · 有 baseUrl）。不做「默认嵌入 Provider」设置项——
 * §4.1 的 Provider 本来就带 embedding_model 字段，多一个全局指针就多一处
 * 会与它不一致的状态。用户想换，把不想用的那个的 embeddingModel 清掉即可。
 */

import type { Embedder } from "@ff-pane/rag";
import { resolveProviderEmbedder } from "@ff-pane/rag";
import type { ApiKeyRef, Provider } from "@ff-pane/shared";
import type { KnowledgeEmbeddingStatus } from "../../shared-ipc/contracts";

/** 已建向量索引的规格（来自向量状态行）；未建过索引时缺席。 */
export interface VectorSpec {
  readonly backend: string;
  readonly dimensions: number;
  readonly model: string;
}

/** 解析所需的注入项。 */
export interface ResolveEmbedderDeps {
  /** 全部 Provider（顺序即优先级）。 */
  readonly providers: readonly Provider[];
  /** 取明文密钥（主进程 safeStorage 解密，用完即弃，§4.3）。 */
  readonly revealSecret: (ref: ApiKeyRef) => Promise<string | undefined>;
  /** 已建向量索引的规格；用于换模型 / 换维度时当场拦下。 */
  readonly vectorSpec?: VectorSpec;
  /** 当前进程实际可用的向量后端（sqlite-vec 装上了就是 vec0）。 */
  readonly desiredBackend: string;
}

/** 解析结果：可用则带上嵌入器本体，不可用只有状态。 */
export interface EmbedderResolution {
  /** 嵌入器；不可用时缺席。 */
  readonly embedder?: Embedder;
  /** 面向界面的状态（可直接进 knowledge:list 响应）。 */
  readonly status: KnowledgeEmbeddingStatus;
}

/**
 * 该 Provider 是否有可能提供嵌入能力（不需要密钥即可判定的那部分条件）。
 * 判据与 rag 的 embedderConfigFromProvider 一致；真正的构造仍以那边为准，
 * 这里只是「要不要为它解密」的前置筛子。
 */
function canEmbed(provider: Provider): boolean {
  return (
    provider.enabled &&
    provider.type === "openai_compatible" &&
    (provider.embeddingModel?.trim() ?? "") !== "" &&
    (provider.baseUrl?.trim() ?? "") !== ""
  );
}

/**
 * 解析当前可用的嵌入能力。
 *
 * 规格守卫（与 T6.4 的 ensureVectorIndex 同一道理）：已建索引的模型 / 后端与
 * 当前嵌入器不一致时判 spec-mismatch 并**不返回嵌入器**——继续往下写会把两个
 * 模型的向量混进同一张表，检索结果静默失真且几乎无法定位。维度不一致由
 * expectedDimensions 交给 T6.3 在首批响应时当场抛 EmbedDimensionError。
 */
export async function resolveKnowledgeEmbedder(
  deps: ResolveEmbedderDeps,
): Promise<EmbedderResolution> {
  const spec = deps.vectorSpec;

  for (const provider of deps.providers) {
    // 先按不需要密钥的条件筛一遍再解密。解密是有代价的动作（系统密钥库调用），
    // 更重要的是 §4.3 的纪律：明文只在真要用它发请求时才取出来，
    // 不为一个注定被跳过的 Provider 把密钥摊到内存里。
    if (!canEmbed(provider)) {
      continue;
    }
    const apiKey =
      provider.apiKeyRef === undefined ? undefined : await deps.revealSecret(provider.apiKeyRef);
    const embedder = resolveProviderEmbedder(provider, {
      ...(apiKey === undefined ? {} : { apiKey }),
      // 已建索引则钉住维度：换了同名不同维的模型也能在首批响应时被拦下
      ...(spec !== undefined && spec.model === provider.embeddingModel
        ? { expectedDimensions: spec.dimensions }
        : {}),
    });
    if (embedder === undefined) {
      continue;
    }
    if (spec !== undefined && spec.model !== embedder.model) {
      return {
        status: {
          available: false,
          blocker: "spec-mismatch",
          detail: `${spec.model} → ${embedder.model}`,
        },
      };
    }
    if (spec !== undefined && spec.backend !== deps.desiredBackend) {
      return {
        status: {
          available: false,
          blocker: "spec-mismatch",
          detail: `${spec.backend} → ${deps.desiredBackend}`,
        },
      };
    }
    return {
      embedder,
      status: { available: true, providerName: provider.name, model: embedder.model },
    };
  }

  return { status: { available: false, blocker: "no-provider" } };
}
