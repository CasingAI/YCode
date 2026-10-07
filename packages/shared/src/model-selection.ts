import { z } from "zod";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * 配置面的组意图（docs/specs/model-group.md）：身份只有组 ID + 选中当下的组名快照。
 * 与 ModelSelection 互斥（命令 payload superRefine 校验）；不带思考档位——
 * 档位跟会话钉死成员走，不跟组意图走。
 */
export const modelGroupIntentSchema = z
  .object({
    groupId: z.string().trim().min(1),
    groupNameSnapshot: z.string(),
  })
  .strict();

export type ModelGroupIntent = z.infer<typeof modelGroupIntentSchema>;

/** 组意图等值比较：组 ID 即身份；名快照是展示事实，不参与意图相等判定。 */
export function sameModelGroupIntent(
  left: ModelGroupIntent | undefined,
  right: ModelGroupIntent | undefined,
): boolean {
  return left?.groupId === right?.groupId;
}

/** 组成员二元组；结构类型供 provider/core 双侧使用，不引入包依赖。 */
export interface ModelGroupMemberRef {
  readonly providerId: string;
  readonly modelId: string;
}

/** FNV-1a 32 位：零依赖、跨进程一致，成员抽选的均匀度足够。 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 哈希抽选（docs/specs/model-group.md）：输入 = 抽选种子 + 组 ID，对**当时仍可用**的
 * 成员按组配置顺序取下标。调用方负责先过滤可用成员；空名单返回 undefined（失败语义
 * 由 admission 裁决，这里不抛）。同一颗种子 + 同一份可用名单必然抽回同一成员——
 * A→B→A 抽回原成员、父子会话接到同一新成员都靠这条纯函数保证。
 */
export function pickModelGroupMember(input: {
  readonly pickSeed: string;
  readonly groupId: string;
  readonly availableMembers: readonly ModelGroupMemberRef[];
}): ModelGroupMemberRef | undefined {
  const { pickSeed, groupId, availableMembers } = input;
  if (availableMembers.length === 0) return undefined;
  const index = fnv1a32(`${pickSeed}\u0000${groupId}`) % availableMembers.length;
  return availableMembers[index];
}

/**
 * 显式选择的三字段等值比较：providerId / modelId / reasoningLevel。
 * 必须按「稀疏的显式 Selection」比较，不能用补全默认值后的完整选项比——
 * 否则一边带默认档位、一边不带时永不相等。
 */
export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId &&
    left?.options?.reasoningLevel === right?.options?.reasoningLevel
  );
}

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
