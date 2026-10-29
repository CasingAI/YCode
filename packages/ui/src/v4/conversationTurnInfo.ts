import type { ExecutionModelIdentity } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkSegmentUsage } from "@/v4/conversationWorkSegmentUsage.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

export interface ConversationTurnInfoFacts {
  /** 当前工作段实际发起过模型步骤的供应商/模型，按首次顺序。 */
  executionModels: readonly ExecutionModelIdentity[];
  workState?: ConversationTurnWorkStatus["state"];
  durationMs?: number;
  toolCallCount?: number;
  reasoningDurationMs?: number;
  turnId: string;
}

/**
 * 只整理投影已经给出的工作段事实，不从当前选型、admission 或 marker 推断模型。
 * usage 的缺席保持 undefined（未知），0 保持 0；旧快照仍走既有 direct fallback。
 */
export function buildConversationTurnInfoFacts(input: {
  segment: ConversationTurnWorkSegment;
  turnId: string;
}): ConversationTurnInfoFacts {
  // 旧快照没有 usage 时，只有确实存在工作行才走 direct fallback；空行集不能
  // 由 fallback 造出 0，否则会把「没有任何事实」误报成明确的 0（spec 规则 9）。
  const hasUsageSource =
    input.segment.usage !== undefined || input.segment.assistantWorkRows.length > 0;
  const usage = hasUsageSource
    ? resolveWorkSegmentUsage({
        usage: input.segment.usage,
        rows: input.segment.assistantWorkRows,
      })
    : undefined;

  return {
    executionModels: uniqueExecutionModels(input.segment.executionModels),
    workState: input.segment.workStatus?.state,
    durationMs: input.segment.workStatus?.durationMs,
    toolCallCount: usage?.toolCallCount,
    reasoningDurationMs: usage?.reasoningDurationMs,
    turnId: input.turnId,
  };
}

/**
 * 去重只用于展示防御：投影仍是有序去重的所有者，这里不改变首次出现顺序。
 * 供应商和模型都非空才构成一个可展示身份，否则视为未知，绝不回填当前选择。
 */
function uniqueExecutionModels(
  models: readonly ExecutionModelIdentity[] | undefined,
): ExecutionModelIdentity[] {
  if (!models?.length) return [];

  const seen = new Set<string>();
  const result: ExecutionModelIdentity[] = [];
  for (const model of models) {
    const providerId = model.providerId;
    const modelId = model.modelId;
    if (!providerId.trim() || !modelId.trim()) continue;

    const key = `${providerId}\u0000${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerId, modelId });
  }
  return result;
}
