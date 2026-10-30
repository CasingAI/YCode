/** 网络搜索候选的纯投影：按给定 provider id 顺序输出，未知 id 跳过；不拥有顺序、不写盘。 */
export interface WebSearchOrderCandidate {
  readonly providerId: string;
}

export function projectCandidatesToOrder<T extends WebSearchOrderCandidate>(
  candidates: readonly T[],
  orderedProviderIds: readonly string[],
): T[] {
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate] as const),
  );
  return orderedProviderIds.flatMap((providerId) => {
    const candidate = candidateById.get(providerId);
    return candidate ? [candidate] : [];
  });
}
