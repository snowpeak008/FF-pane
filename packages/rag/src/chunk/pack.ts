/**
 * 打包（T6.2）：把分段产物合并成落在 [minTokens, maxTokens] 的块，并按需重叠。
 * 与格式无关——新增格式只需写分段器（见 types.ts 头注释）。
 *
 * 三条规则，按优先级：
 * 1. **不超上限**。maxTokens 是硬约束，含重叠在内。为此把上限拆成
 *    「内容预算 contentMax = maxTokens − overlapTokens」+「重叠预算」，
 *    内容按 contentMax 打包，重叠再补上去，合起来天然不越界。
 * 2. **优先在结构边界收口**。遇到 structure 段且当前块已达下限就先收口，
 *    于是块与标题/页/函数对齐，出处（headingPath / page）也就干净。
 *    当前块还没到下限时则跨边界继续合并——宁可出处粗一格，也不要制造
 *    一堆几十 token 的碎块把检索结果冲散。
 * 3. **重叠只补在被大小切开的地方**。重叠是为了救「切在半句话上」丢失的上下文；
 *    标题与换页本身就是语义边界，把上一节的尾巴拖进来只会污染出处、稀释相关度。
 *    故因结构边界而收口的块之间不重叠。
 */

import type { ChunkProvenance } from "@ff-pane/shared";
import { splitByTokens, takeHead, takeTail } from "./split.js";
import { estimateTokens } from "./tokens.js";
import { trimBlankEdges } from "./trim.js";
import type { ChunkDraft, ChunkingParams, Segment } from "./types.js";

/** 段与段拼接时的分隔（空行 = 段落边界，与解析层的约定一致）。 */
const SEGMENT_JOINER = "\n\n";

/** 重叠文本与正文之间的分隔。 */
const OVERLAP_JOINER = "\n";

/** 打包中间态：已确定内容、尚未补重叠的块。 */
interface PackedChunk {
  readonly text: string;
  readonly provenance: ChunkProvenance;
  /** 是否因「装不下」而与上一块切开（true 才补重叠，见规则 3）。 */
  readonly overlapsPrevious: boolean;
}

/** 由段的出处线索生成块出处。 */
function provenanceOf(segment: Segment, filePath: string): ChunkProvenance {
  const headingPath = segment.headingPath;
  return {
    filePath,
    // exactOptionalPropertyTypes 全开：可选字段用条件展开，不写 undefined
    ...(headingPath !== undefined && headingPath.length > 0 ? { headingPath } : {}),
    ...(segment.page !== undefined ? { page: segment.page } : {}),
  };
}

/** 把超过内容预算的段预先切小，保证进入打包循环的每段都装得下一个空块。 */
function fitSegments(segments: readonly Segment[], contentMax: number): readonly Segment[] {
  const fitted: Segment[] = [];
  for (const segment of segments) {
    if (segment.tokens <= contentMax) {
      fitted.push(segment);
      continue;
    }
    const pieces = splitByTokens(segment.text, contentMax);
    pieces.forEach((piece, index) => {
      fitted.push({
        ...segment,
        text: piece,
        tokens: estimateTokens(piece),
        // 只有首片继承原边界：后续片是硬切出来的，不该再触发结构收口
        boundary: index === 0 ? segment.boundary : "paragraph",
      });
    });
  }
  return fitted;
}

/**
 * 把段打包成块草稿。
 * 输入段序即文档序，输出块的 seq 从 0 连续递增（上下文扩展靠它取相邻块）。
 */
export function packSegments(
  segments: readonly Segment[],
  filePath: string,
  params: ChunkingParams,
): readonly ChunkDraft[] {
  const overlapTokens = Math.round(params.maxTokens * params.overlapRatio);
  const contentMax = params.maxTokens - overlapTokens;

  const packed: PackedChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferHead: Segment | undefined;
  let bufferOverlaps = false;
  /** 下一个开出来的块是否因大小切分而生。 */
  let nextOverlaps = false;

  const append = (segment: Segment): void => {
    if (bufferHead === undefined) {
      bufferHead = segment;
      bufferOverlaps = nextOverlaps;
      nextOverlaps = false;
    }
    buffer.push(segment.text);
    bufferTokens += segment.tokens;
  };

  const flush = (bySize: boolean): void => {
    const head = bufferHead;
    const text = trimBlankEdges(buffer.join(SEGMENT_JOINER));
    buffer = [];
    bufferTokens = 0;
    bufferHead = undefined;
    if (head === undefined || text === "") {
      return;
    }
    packed.push({
      text,
      provenance: provenanceOf(head, filePath),
      overlapsPrevious: bufferOverlaps && packed.length > 0,
    });
    nextOverlaps = bySize;
  };

  for (const original of fitSegments(segments, contentMax)) {
    let segment: Segment | undefined = original;

    // 规则 2：结构边界优先收口（当前块已够大才收，否则跨边界续合）
    if (bufferHead !== undefined && segment.boundary === "structure") {
      if (bufferTokens >= params.minTokens) {
        flush(false);
      }
    }

    // 规则 1：容量
    if (bufferHead !== undefined && bufferTokens + segment.tokens > contentMax) {
      if (bufferTokens >= params.minTokens) {
        flush(true);
      } else {
        // 当前块独立成块会低于下限 → 把来段切开，先把当前块填到预算上限
        const [head, tail] = takeHead(segment.text, contentMax - bufferTokens);
        if (head !== undefined) {
          append({ ...segment, text: head, tokens: estimateTokens(head) });
        }
        flush(true);
        segment =
          tail === undefined ? undefined : { ...segment, text: tail, tokens: estimateTokens(tail) };
      }
    }

    if (segment !== undefined) {
      append(segment);
    }
  }
  flush(false);

  // 规则 3：补重叠
  return packed.map((chunk, index) => {
    let text = chunk.text;
    if (chunk.overlapsPrevious && overlapTokens > 0) {
      const previous = packed[index - 1];
      if (previous !== undefined) {
        // 上一块很短时按其一半封顶，避免重叠把整块原样复制一遍
        const budget = Math.min(overlapTokens, Math.floor(estimateTokens(previous.text) / 2));
        const tail = takeTail(previous.text, budget);
        if (tail !== "") {
          text = `${tail}${OVERLAP_JOINER}${text}`;
        }
      }
    }
    return {
      seq: index,
      text,
      tokens: estimateTokens(text),
      provenance: chunk.provenance,
    };
  });
}
