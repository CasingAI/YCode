import type { ModelReasoningContentBlock } from "../deps.js";
import { readReasoningTiming } from "./reasoning-stream.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";

/** 归并后一条 reasoning part 的落盘形态；字段与 `ReasoningPart` 的对话事实一一对应。 */
export interface ReasoningPartForPersistence {
  text: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
}

// 上游把一次思考切成多段（Responses 的一个 reasoning item 可含多个 summary part，
// 一次响应也可含多个 item）时，段与段是连续叙述，按空行拼接保持可读。
const REASONING_SEGMENT_SEPARATOR = "\n\n";

/**
 * 把一次模型请求里的思考块归并成要落盘的 reasoning part。
 *
 * 归并单位是「一次模型请求」而不是上游的段：直播按 chunk id 分块，一次响应常得到
 * 十几条块，逐块落盘会让同一轮思考在库里、恢复后和 UI 上裂成十几行。
 *
 * 例外是携带签名/密文的块：这类块的回放校验绑定块自身（Anthropic thinking 签名），
 * 合并会改变块数量与内容而被 provider 拒绝，因此单独成条、原样保留。
 *
 * @param fallbackStart 块没有登记起始时刻时（历史回放构造、非流式结果）的兜底起点
 * @param resolveEnd 该块结束时刻的取值策略；正常收尾用记录到的 reasoning_end，取消收尾用取消当下
 */
export function mergeReasoningForPersistence(input: {
  blocks: readonly ModelReasoningContentBlock[];
  fallbackStart: number;
  resolveEnd: (block: ModelReasoningContentBlock) => number;
}): ReasoningPartForPersistence[] {
  const parts: ReasoningPartForPersistence[] = [];
  let group: ModelReasoningContentBlock[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    parts.push(buildPart(group, input));
    group = [];
  };

  for (const block of input.blocks) {
    if (!hasAssistantReasoningContent(block)) continue;
    if (carriesBlockBoundProviderMetadata(block)) {
      flush();
      parts.push(buildPart([block], input));
      continue;
    }
    group.push(block);
  }
  flush();
  return parts;
}

function buildPart(
  blocks: readonly ModelReasoningContentBlock[],
  input: {
    fallbackStart: number;
    resolveEnd: (block: ModelReasoningContentBlock) => number;
  },
): ReasoningPartForPersistence {
  const text = blocks
    .map((block) => block.text)
    .filter((segment) => segment.length > 0)
    .join(REASONING_SEGMENT_SEPARATOR);

  // 合并段的窗口覆盖整段思考：起点取各段最早（未登记起点的段按模型步起点计），终点取各段最晚。
  const starts = blocks.map(
    (block) => readReasoningTiming(block)?.startedAt ?? input.fallbackStart,
  );
  const ends = blocks.map((block) => input.resolveEnd(block));
  const first = blocks[0]!;
  return {
    text,
    metadata: first.providerOptions,
    time: { start: Math.min(...starts), end: Math.max(...ends) },
  };
}

/**
 * 判据与 adapter 侧 `reasoning-history-normalization` 的 `isSignedOrRedactedReasoning` 同一语义：
 * 带签名的 thinking 块和 redacted thinking 块都由 provider 逐块校验，不能合并。
 */
function carriesBlockBoundProviderMetadata(block: ModelReasoningContentBlock): boolean {
  const anthropic = asRecord(asRecord(block.providerOptions).anthropic);
  return (
    (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
