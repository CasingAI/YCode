/**
 * 网络搜索设置页的激活徽章应与 CLI 执行器一致：按用户排序跳过未配置 Key 的候选。
 * 返回 undefined 时不显示激活徽章，避免误导用户以为无 Key 的搜索源已启用。
 */
export function resolveActiveWebSearchCandidateId(
  candidates: readonly { providerId: string; hasApiKey: boolean }[],
): string | undefined {
  return candidates.find((candidate) => candidate.hasApiKey)?.providerId;
}
