import type { ModelGroupMemberRef } from "@zcode/provider";

// 模型组成员可重复（docs/specs/model-group.md）：同一 provider+model+档位能加入多次，
// 拖拽库要求每个条目有唯一 id。基础键取 providerId + modelId + reasoningLevel，
// 相同基础键再追加出现序号（第 1 条 #0、第 2 条 #1……），保证每行独立可拖动。
export interface ModelGroupMemberOrderEntry {
  readonly id: string;
  readonly member: ModelGroupMemberRef;
}

function buildMemberBaseKey(member: ModelGroupMemberRef): string {
  // 用 JSON 编码避免分隔符与成员字段内容冲突；未绑定档位统一按空串入键。
  return JSON.stringify([member.providerId, member.modelId, member.reasoningLevel ?? ""]);
}

export function buildModelGroupMemberOrderEntries(
  members: readonly ModelGroupMemberRef[],
): ModelGroupMemberOrderEntry[] {
  const occurrenceByBaseKey = new Map<string, number>();
  return members.map((member) => {
    const baseKey = buildMemberBaseKey(member);
    const occurrence = occurrenceByBaseKey.get(baseKey) ?? 0;
    occurrenceByBaseKey.set(baseKey, occurrence + 1);
    return { id: `${baseKey}#${occurrence}`, member };
  });
}

/**
 * 按 id 顺序还原成员名单。任何 id 找不到（拖拽期间权威数据已换代）或数量对不上时
 * 返回 null，调用方必须放弃本次写入，避免把残缺名单提交到持久层。
 */
export function resolveModelGroupMemberOrder(
  entries: readonly ModelGroupMemberOrderEntry[],
  nextIds: readonly string[],
): ModelGroupMemberRef[] | null {
  if (nextIds.length !== entries.length) return null;
  const memberById = new Map(entries.map((entry) => [entry.id, entry.member] as const));
  if (memberById.size !== entries.length) return null;
  const seen = new Set<string>();
  const members: ModelGroupMemberRef[] = [];
  for (const id of nextIds) {
    const member = memberById.get(id);
    if (!member || seen.has(id)) return null;
    seen.add(id);
    members.push(member);
  }
  return members;
}
