import {
  modelGroupIntentSchema,
  modelSelectionSchema,
  type ModelGroupIntent,
  type ModelSelection,
} from "@zcode/shared";

export function normalizeSubagentModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  const options = selection.options;
  return modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options?.reasoningLevel ? { options: { reasoningLevel: options.reasoningLevel } } : {}),
  });
}

/**
 * 组意图归一化（docs/specs/model-group.md）：只保留组 ID + 名快照，不带档位。
 * 原因：名快照是展示事实，调用方传入当下组名；归一化只做结构校验，不查个人配置。
 */
export function normalizeSubagentModelGroupIntent(
  intent: ModelGroupIntent | undefined,
): ModelGroupIntent | undefined {
  if (!intent) return undefined;
  return modelGroupIntentSchema.parse({
    groupId: intent.groupId,
    groupNameSnapshot: intent.groupNameSnapshot || intent.groupId,
  });
}
