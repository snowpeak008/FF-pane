/**
 * 向量索引后端（T6.4，风险 R2 的落地）。
 *
 * **R2 实测结论（本机 win32-x64 / better-sqlite3 13.x / sqlite-vec 0.1.9）：
 * 扩展可正常加载，KNN、cosine 距离、`rowid IN (...)` 精确预过滤、维度校验全部可用。**
 * 故 vec0 是首选后端；但**退路照样实现**，理由不是「怕它不能用」，而是：
 * 打包后的 .dll 可能没被解包出 asar、可能被杀毒软件隔离、可能在别的机器上缺
 * VC 运行时——这些都发生在用户机器上、发生在我们看不见的地方。
 * 向量检索是增强不是前提（§8.3.3），扩展加载失败必须降级，绝不能让知识库打不开。
 *
 * 两个后端同一接口：
 * - vec0     虚表 KNN，十万块量级毫秒级；
 * - fallback 普通表存 Float32 BLOB + JS 余弦全扫（开发计划 §12 R2 认可的退路，
 *            十万块量级可接受）。
 *
 * **后端与向量表绑定，不可互换**：库里已有 vec0 向量时换到 fallback 读不出来，
 * 反之亦然。此时不做「静默半可用」——`openVectorIndex` 直接报告不可用，
 * 调用方走纯 FTS 并提示重建。向量是派生数据，重建总是对的兜底。
 */

import type Database from "better-sqlite3";
import {
  KNOWLEDGE_CHUNK_TABLE,
  KNOWLEDGE_VEC0_TABLE,
  KNOWLEDGE_VECTOR_FALLBACK_TABLE,
  KNOWLEDGE_VECTOR_STATE_TABLE,
} from "./knowledge-schema.js";

/** 向量后端标识（写进 knowledge_vector_state.backend）。 */
export const VECTOR_BACKENDS = ["vec0", "fallback"] as const;

/** 向量后端标识。 */
export type VectorBackend = (typeof VECTOR_BACKENDS)[number];

/** sqlite-vec 扩展加载结果。永不抛——加载不了是降级信号，不是崩溃理由。 */
export type VectorExtensionLoad =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 尝试把 sqlite-vec 装进连接。
 *
 * 动态 import 而非静态：sqlite-vec 是可选能力，静态导入会让「包没装 / 平台无预编译」
 * 从一个可降级的运行时状况升级成模块解析期的硬失败，连带整个 storage 包都加载不了。
 */
export async function loadVectorExtension(db: Database.Database): Promise<VectorExtensionLoad> {
  try {
    const sqliteVec = (await import("sqlite-vec")) as { load(db: Database.Database): void };
    sqliteVec.load(db);
    const row = db.prepare("SELECT vec_version() AS version").get() as
      | { readonly version: string }
      | undefined;
    return { ok: true, version: row?.version ?? "unknown" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把向量编码成 SQLite BLOB（小端 Float32，vec0 与退路表同一编码）。
 * 显式复制到新 ArrayBuffer：Float32Array 可能是某个更大缓冲的视图，
 * 直接取 .buffer 会把整段缓冲当成向量写进去。
 */
export function encodeVector(vector: readonly number[]): Buffer {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/** BLOB → 向量。字节数不是 4 的倍数说明数据损坏，当场报错而不是给出半截向量。 */
export function decodeVector(blob: Buffer): number[] {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`向量 BLOB 长度 ${blob.byteLength} 不是 4 的倍数，数据已损坏`);
  }
  const count = blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const out = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    out[index] = blob.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return out;
}

/** 一条向量召回结果。 */
export interface VectorNeighbor {
  /** 命中块的 rowid。 */
  readonly chunkRowid: number;
  /**
   * 距离，越小越近（cosine 距离，值域 [0, 2]）。
   * 融合排序只用名次不用绝对值（RRF），此字段供调试与界面展示。
   */
  readonly distance: number;
}

/** 向量检索参数。 */
export interface VectorSearchParams {
  /** 查询向量。维度必须与索引一致。 */
  readonly vector: readonly number[];
  /** 取前几名。 */
  readonly limit: number;
  /**
   * 候选 rowid 白名单（过滤条件已算出的精确集合）。
   * 省略表示全库检索。空数组表示「过滤后没有任何候选」，直接返回空。
   */
  readonly candidates?: readonly number[];
}

/** 向量索引：两种后端的公共接口。 */
export interface VectorIndex {
  /** 实际后端。 */
  readonly backend: VectorBackend;
  /** 向量维度。 */
  readonly dimensions: number;
  /** 建索引所用的嵌入模型。 */
  readonly model: string;
  /** 写入或覆盖一个块的向量。 */
  put(chunkRowid: number, vector: readonly number[]): void;
  /** 删除若干块的向量。不存在的静默跳过。 */
  deleteMany(chunkRowids: readonly number[]): void;
  /** 清空全部向量（重建索引的第一步）。 */
  clear(): void;
  /** 已存向量条数。 */
  count(): number;
  /** KNN 检索。 */
  search(params: VectorSearchParams): VectorNeighbor[];
}

/**
 * vec0 的 rowid 必须绑成 SQLite INTEGER，而 better-sqlite3 把 JS number
 * 一律绑成 REAL —— 于是 vec0 会以「Only integers are allowed for primary key
 * values」拒收。**这是 T6.4 实测踩到的坑，所有进 vec0 的 rowid 都必须过这里。**
 */
function toSqliteInteger(value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`rowid 必须是安全整数，实际 ${value}`);
  }
  return BigInt(value);
}

/** 维度校验：写进去之前就拦，别让维度不齐的向量污染索引。 */
function assertDimensions(vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new RangeError(`向量维度不符：索引为 ${dimensions} 维，实际 ${vector.length} 维`);
  }
}

/**
 * SQLite 单条语句的绑定参数上限（默认 SQLITE_MAX_VARIABLE_NUMBER）。
 * 候选集比这还大时不走 IN 预过滤，改为超额召回后再过滤（见 knowledge-search）。
 */
export const VECTOR_PREFILTER_MAX_CANDIDATES = 20_000;

/** vec0 后端：虚表 KNN。 */
function createVec0Index(db: Database.Database, dimensions: number, model: string): VectorIndex {
  // vec0 是虚表，不支持 UPSERT（实测 "UPSERT not implemented for virtual table"），
  // 故覆盖写只能「先删再插」。两条语句包在事务里，中途失败不会留下空洞。
  const insert = db.prepare(`INSERT INTO ${KNOWLEDGE_VEC0_TABLE}(rowid, embedding) VALUES (?, ?)`);
  const remove = db.prepare(`DELETE FROM ${KNOWLEDGE_VEC0_TABLE} WHERE rowid = ?`);
  const upsert = db.transaction((rowid: bigint, blob: Buffer) => {
    remove.run(rowid);
    insert.run(rowid, blob);
  });

  return {
    backend: "vec0",
    dimensions,
    model,
    put(chunkRowid, vector) {
      assertDimensions(vector, dimensions);
      upsert(toSqliteInteger(chunkRowid), encodeVector(vector));
    },
    deleteMany(chunkRowids) {
      const run = db.transaction((rowids: readonly number[]) => {
        for (const rowid of rowids) {
          remove.run(toSqliteInteger(rowid));
        }
      });
      run(chunkRowids);
    },
    clear() {
      db.prepare(`DELETE FROM ${KNOWLEDGE_VEC0_TABLE}`).run();
    },
    count() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${KNOWLEDGE_VEC0_TABLE}`).get() as {
        readonly n: number;
      };
      return row.n;
    },
    search(params) {
      assertDimensions(params.vector, dimensions);
      if (params.candidates?.length === 0) {
        return [];
      }
      const conditions = ["embedding MATCH ?", "k = ?"];
      const bindings: (Buffer | bigint)[] = [
        encodeVector(params.vector),
        toSqliteInteger(Math.max(1, params.limit)),
      ];
      if (params.candidates !== undefined) {
        // vec0 0.1.9 实测支持 rowid IN 精确预过滤：过滤后的 top-k 是真 top-k，
        // 不是「全局 top-k 再筛掉一部分」那种会少给结果的近似。
        //
        // 但**候选恰好只有一个时不成立**：SQLite 会把单元素的 `IN (x)` 改写成
        // `rowid = x`，那条路径在 vec0 里退化成「先取全局 top-k 再按 rowid 过滤」，
        // 于是只要该块不在全局前 k 名就返回空——静默漏掉本该命中的唯一候选。
        // （实测：10 条向量、单候选 rowid=7，任何 k 都返回空。）
        // 把候选补到两个（重复同一个 rowid）即可走回真正的预过滤路径，
        // 且实测不会产生重复行。
        const candidates =
          params.candidates.length === 1
            ? [...params.candidates, ...params.candidates]
            : params.candidates;
        conditions.push(`rowid IN (${candidates.map(() => "?").join(", ")})`);
        bindings.push(...candidates.map(toSqliteInteger));
      }
      const rows = db
        .prepare(
          `SELECT rowid AS chunkRowid, distance
           FROM ${KNOWLEDGE_VEC0_TABLE}
           WHERE ${conditions.join(" AND ")}
           ORDER BY distance`,
        )
        .all(...bindings) as VectorNeighbor[];
      return rows;
    },
  };
}

/** 余弦距离 = 1 − 余弦相似度，与 vec0 的 distance_metric=cosine 同口径。 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  // 零向量与任何向量都谈不上夹角：判为最远，而不是造一个 NaN 出来污染排序
  if (normA === 0 || normB === 0) {
    return 1;
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 退路后端：普通表 + JS 余弦全扫（开发计划 §12 R2）。
 * 逐行迭代而不是 all()：十万条 × 千维一次性读进 JS 就是几百 MB，
 * 迭代 + 只留 top-k 的话内存占用与 k 同阶。
 */
function createFallbackIndex(
  db: Database.Database,
  dimensions: number,
  model: string,
): VectorIndex {
  const table = KNOWLEDGE_VECTOR_FALLBACK_TABLE;
  const insert = db.prepare(
    `INSERT INTO ${table}(chunk_rowid, embedding) VALUES (?, ?)
     ON CONFLICT(chunk_rowid) DO UPDATE SET embedding = excluded.embedding`,
  );

  return {
    backend: "fallback",
    dimensions,
    model,
    put(chunkRowid, vector) {
      assertDimensions(vector, dimensions);
      insert.run(chunkRowid, encodeVector(vector));
    },
    deleteMany(chunkRowids) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE chunk_rowid = ?`);
      const run = db.transaction((rowids: readonly number[]) => {
        for (const rowid of rowids) {
          remove.run(rowid);
        }
      });
      run(chunkRowids);
    },
    clear() {
      db.prepare(`DELETE FROM ${table}`).run();
    },
    count() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n: number };
      return row.n;
    },
    search(params) {
      assertDimensions(params.vector, dimensions);
      if (params.candidates?.length === 0) {
        return [];
      }
      const limit = Math.max(1, params.limit);
      let sql = `SELECT chunk_rowid AS chunkRowid, embedding FROM ${table}`;
      const bindings: number[] = [];
      if (params.candidates !== undefined) {
        sql += ` WHERE chunk_rowid IN (${params.candidates.map(() => "?").join(", ")})`;
        bindings.push(...params.candidates);
      }

      // 插入式维护一个长度 ≤ limit 的有序数组。k 是几十的量级，
      // 线性插入比引一个堆实现更简单，常数也更小。
      const best: VectorNeighbor[] = [];
      const statement = db.prepare(sql);
      for (const raw of statement.iterate(...bindings)) {
        const row = raw as { readonly chunkRowid: number; readonly embedding: Buffer };
        const distance = cosineDistance(params.vector, decodeVector(row.embedding));
        if (best.length === limit && distance >= (best[best.length - 1]?.distance ?? 0)) {
          continue;
        }
        const neighbor: VectorNeighbor = { chunkRowid: row.chunkRowid, distance };
        let position = best.length;
        while (position > 0 && (best[position - 1]?.distance ?? 0) > distance) {
          position -= 1;
        }
        best.splice(position, 0, neighbor);
        if (best.length > limit) {
          best.pop();
        }
      }
      return best;
    },
  };
}

/** openVectorIndex 的结果：可用则给索引，不可用给出人能读懂的原因。 */
export type VectorIndexResult =
  | { readonly ok: true; readonly index: VectorIndex }
  | { readonly ok: false; readonly reason: string };

/** 读向量状态行（未建过索引则 undefined）。 */
export function readVectorState(
  db: Database.Database,
): { readonly backend: string; readonly dimensions: number; readonly model: string } | undefined {
  return db
    .prepare(
      `SELECT backend, dimensions, model FROM ${KNOWLEDGE_VECTOR_STATE_TABLE} WHERE singleton = 1`,
    )
    .get() as
    | { readonly backend: string; readonly dimensions: number; readonly model: string }
    | undefined;
}

/** 建向量表并登记状态。已存在同规格索引则直接复用。 */
function createVectorTable(
  db: Database.Database,
  backend: VectorBackend,
  dimensions: number,
  model: string,
): void {
  db.transaction(() => {
    if (backend === "vec0") {
      // 维度写死在 DDL 里（vec0 的硬性要求），故本表只能在维度已知时建——
      // 这正是它不在迁移 v2 里的原因
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${KNOWLEDGE_VEC0_TABLE} USING vec0(
           embedding float[${dimensions}] distance_metric=cosine
         )`,
      );
    } else {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${KNOWLEDGE_VECTOR_FALLBACK_TABLE} (
           chunk_rowid INTEGER PRIMARY KEY
             REFERENCES ${KNOWLEDGE_CHUNK_TABLE}(chunk_rowid) ON DELETE CASCADE,
           embedding   BLOB NOT NULL
         )`,
      );
    }
    db.prepare(
      `INSERT INTO ${KNOWLEDGE_VECTOR_STATE_TABLE}(singleton, backend, dimensions, model)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         backend = excluded.backend,
         dimensions = excluded.dimensions,
         model = excluded.model`,
    ).run(backend, dimensions, model);
  })();
}

/** ensureVectorIndex 的参数。 */
export interface EnsureVectorIndexOptions {
  /** 向量维度（由嵌入器首批返回值确定，见 rag 的 Embedder.dimensions）。 */
  readonly dimensions: number;
  /** 嵌入模型 ID。 */
  readonly model: string;
  /** sqlite-vec 是否已装进本连接（loadVectorExtension 的结果）。 */
  readonly extensionLoaded: boolean;
}

/**
 * 建立（或复用）向量索引。
 *
 * 规格不符一律**拒绝复用**而不是硬凑：维度不同的向量混在一张表里，检索结果会
 * 静默地毫无意义；模型不同则向量根本不在同一空间（与 rag 的块指纹含模型 ID 同一道理）。
 * 返回 ok:false，调用方据此提示「重建向量索引」——向量是派生数据，重建总是对的。
 */
export function ensureVectorIndex(
  db: Database.Database,
  options: EnsureVectorIndexOptions,
): VectorIndexResult {
  const { dimensions, model, extensionLoaded } = options;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return { ok: false, reason: `向量维度必须是正整数，实际 ${dimensions}` };
  }
  if (model.trim() === "") {
    return { ok: false, reason: "嵌入模型 ID 为空" };
  }

  const desired: VectorBackend = extensionLoaded ? "vec0" : "fallback";
  const state = readVectorState(db);

  if (state !== undefined) {
    if (state.backend !== desired) {
      return {
        ok: false,
        reason:
          `向量索引由 ${state.backend} 后端建立，当前可用后端是 ${desired}，两者存储格式不通用。` +
          "请重建向量索引。",
      };
    }
    if (state.dimensions !== dimensions) {
      return {
        ok: false,
        reason: `向量索引为 ${state.dimensions} 维，当前嵌入模型输出 ${dimensions} 维。请重建向量索引。`,
      };
    }
    if (state.model !== model) {
      return {
        ok: false,
        reason: `向量索引由模型 ${state.model} 建立，当前模型为 ${model}，向量不在同一空间。请重建向量索引。`,
      };
    }
  }

  try {
    createVectorTable(db, desired, dimensions, model);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return {
    ok: true,
    index:
      desired === "vec0"
        ? createVec0Index(db, dimensions, model)
        : createFallbackIndex(db, dimensions, model),
  };
}

/**
 * 打开已有的向量索引（不改规格，只按状态行还原）。
 * 没建过索引、或后端与当前可用能力不符，都返回 ok:false —— 调用方走纯 FTS。
 */
export function openVectorIndex(
  db: Database.Database,
  extensionLoaded: boolean,
): VectorIndexResult {
  const state = readVectorState(db);
  if (state === undefined) {
    return { ok: false, reason: "尚未建立向量索引" };
  }
  const available: VectorBackend = extensionLoaded ? "vec0" : "fallback";
  if (state.backend !== available) {
    return {
      ok: false,
      reason: `向量索引由 ${state.backend} 后端建立，当前可用后端是 ${available}。请重建向量索引。`,
    };
  }
  return {
    ok: true,
    index:
      state.backend === "vec0"
        ? createVec0Index(db, state.dimensions, state.model)
        : createFallbackIndex(db, state.dimensions, state.model),
  };
}

/** 丢弃向量索引（换嵌入模型 / 换后端时的重建第一步）。表与状态行一并清掉。 */
export function dropVectorIndex(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${KNOWLEDGE_VEC0_TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${KNOWLEDGE_VECTOR_FALLBACK_TABLE}`);
    db.prepare(`DELETE FROM ${KNOWLEDGE_VECTOR_STATE_TABLE}`).run();
  })();
}
