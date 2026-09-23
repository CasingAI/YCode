import type { ModelReasoningContentBlock } from "../deps.js";

const DEFAULT_REASONING_STREAM_ID = "__zcode_default_reasoning__";

interface ReasoningTiming {
  startedAt: number;
  endedAt?: number;
}

// 思考块的起止时间承载在块对象为键的 WeakMap 里，而不写进 ModelReasoningContentBlock：
// 这些块会作为 assistant 消息回放给 provider，多出来的字段有泄漏进请求体的风险。
const reasoningTimings = new WeakMap<ModelReasoningContentBlock, ReasoningTiming>();

export function getOrCreateReasoningBlock(input: {
  id?: string;
  providerMetadata?: Record<string, unknown>;
  reasoning: ModelReasoningContentBlock[];
  reasoningById: Map<string, ModelReasoningContentBlock>;
}): ModelReasoningContentBlock {
  const id = input.id ?? DEFAULT_REASONING_STREAM_ID;
  const existing = input.reasoningById.get(id);
  if (existing) {
    return existing;
  }

  // Anthropic-compatible providers can emit thinking deltas without a
  // distinct start event. Preserve the block so later tool_result requests can
  // replay assistant thinking alongside tool_use.
  const block: ModelReasoningContentBlock = {
    type: "reasoning",
    text: "",
    providerOptions: input.providerMetadata,
  };
  input.reasoningById.set(id, block);
  input.reasoning.push(block);
  reasoningTimings.set(block, { startedAt: Date.now() });
  return block;
}

/**
 * 记录该段思考的结束时刻。`reasoning_end` 到达时调用；同一块只认第一次，
 * 因为 provider 可能重复发结束事件。拿不到结束事件的块（流被中断/取消）
 * 保持无 endedAt，落盘端取当下即事实。
 */
export function markReasoningBlockEnded(
  block: ModelReasoningContentBlock | undefined,
  endedAt: number = Date.now(),
): void {
  if (!block) return;
  const timing = reasoningTimings.get(block);
  if (!timing || timing.endedAt !== undefined) return;
  timing.endedAt = endedAt;
}

/** 读取该段思考的真实起止时间；未登记（如从历史回放构造的块）返回 undefined。 */
export function readReasoningTiming(
  block: ModelReasoningContentBlock,
): { startedAt: number; endedAt: number | undefined } | undefined {
  const timing = reasoningTimings.get(block);
  if (!timing) return undefined;
  return { startedAt: timing.startedAt, endedAt: timing.endedAt };
}
