import { z } from "zod";

// 模型组：一层可编辑的模型别名，不是新的供应商（docs/specs/model-group.md）。
// 组身份走独立命名空间，绝不进入 Provider Registry 的 providers 名单；
// 成员是具体模型二元组，禁止组套组（成员只能是 provider/model，不含组 ID）。

/** 组 ID 前缀即命名空间边界：天然不占用 `account:` / `builtin:` 等保留供应商前缀。 */
export const MODEL_GROUP_ID_PREFIX = "model-group:";

export const modelGroupMemberDataSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  })
  .strict();
export type ModelGroupMemberRef = z.infer<typeof modelGroupMemberDataSchema>;

export const modelGroupDataSchema = z
  .object({
    groupId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    // 成员顺序只参与「尚未钉死」与「重钉」两种哈希下标；钉死仍可用时重排不改选。
    memberOrder: z.array(modelGroupMemberDataSchema),
    // 启用开关：缺省启用；关闭后组离开选择器但保留配置与标记（对标 provider Primary spec 同层语义）。
    enabled: z.boolean().optional(),
    // 遗留逐组 Primary：旧盘可能带有该字段，解析时兼容保留，但投影与 UI 不再使用；
    // 一二级改由顶层 modelGroupsPrimary 整体决定（docs/specs/model-group.md）。
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type ModelGroupConfig = z.infer<typeof modelGroupDataSchema>;

/** 组启用：旧盘缺字段视为启用（与 Provider Rule `enabled ?? true` 同口径）。 */
export function isModelGroupEnabled(group: Pick<ModelGroupConfig, "enabled">): boolean {
  return group.enabled ?? true;
}

/** 组 Primary：旧盘缺字段视为非 Primary（与 Provider `isPrimary ?? false` 同口径）。 */
export function isModelGroupPrimary(group: Pick<ModelGroupConfig, "isPrimary">): boolean {
  return group.isPrimary ?? false;
}

/**
 * 模型组整体 Primary：挂个人配置顶层（与 providerOrder 同层），只决定「模型组」分节
 * 在选择器中一级展开还是收进二级菜单；缺省非 Primary，关闭保留标记。
 */
export function isModelGroupsPrimary(value: unknown): boolean {
  return value === true;
}

/** 组 ID 只能由 Host 按本函数形态生成；同时挡住保留供应商前缀与 `/` 选择器编码。 */
export function isModelGroupId(value: string): value is `${typeof MODEL_GROUP_ID_PREFIX}${string}` {
  return (
    value.startsWith(MODEL_GROUP_ID_PREFIX) &&
    value.length > MODEL_GROUP_ID_PREFIX.length &&
    !value.includes("/")
  );
}

export function assertModelGroupId(groupId: string): string {
  if (!isModelGroupId(groupId)) {
    throw new Error(`模型组 ID 必须以 ${MODEL_GROUP_ID_PREFIX} 开头且不含 /: ${groupId}`);
  }
  return groupId;
}

/** 由显示名派生组 ID 种子；与 Provider ID 种子同一归一化口径。 */
export function modelGroupIdSeedFromName(name: string): string {
  return (
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group"
  );
}

/** 在已占用集合内分配不冲突的组 ID；同只读边界使用，不触发 IO。 */
export function nextModelGroupId(
  occupied: ReadonlySet<string>,
  seed: string,
  randomSuffix: string,
): string {
  const base = `${MODEL_GROUP_ID_PREFIX}${seed}`;
  if (!occupied.has(base)) return base;
  return `${MODEL_GROUP_ID_PREFIX}${seed}-${randomSuffix}`;
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
 * 哈希抽选（spec「抽选与会话」）：输入 = 抽选种子 + 组 ID，对**当时仍可用**的成员
 * 按组配置顺序取下标。调用方负责先过滤可用成员；空名单返回 undefined（失败语义由
 * admission 裁决，这里不抛）。同一颗种子 + 同一份可用名单必然抽回同一成员——
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

export function sameModelGroupMemberRef(
  left: ModelGroupMemberRef | undefined,
  right: ModelGroupMemberRef | undefined,
): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

/** 按组配置顺序去重成员；添加/保存成员的统一规范化入口。 */
export function normalizeModelGroupMembers(
  members: readonly ModelGroupMemberRef[],
): ModelGroupMemberRef[] {
  const result: ModelGroupMemberRef[] = [];
  for (const member of members) {
    const exists = result.some(
      (item) => item.providerId === member.providerId && item.modelId === member.modelId,
    );
    if (!exists) result.push({ providerId: member.providerId, modelId: member.modelId });
  }
  return result;
}
