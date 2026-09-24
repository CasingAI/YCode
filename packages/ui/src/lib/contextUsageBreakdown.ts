import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";

export type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

export interface ContextUsageBreakdownSegment {
  chars: number;
  displayTokens: number | null;
  percent: number;
  source: ContextUsageBreakdownSource;
}

export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
  usedTokens: number | null | undefined,
): ContextUsageBreakdownSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of breakdown ?? []) {
    if (!Number.isFinite(item.chars) || item.chars <= 0) {
      continue;
    }
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
  }

  const totalChars = [...charsBySource.values()].reduce((sum, chars) => sum + chars, 0);
  if (totalChars <= 0) {
    return [];
  }

  const shares = [...charsBySource.entries()].map(([source, chars]) => ({
    chars,
    source,
    percent: chars / totalChars,
  }));
  const totalPercent = shares.reduce((sum, share) => sum + share.percent, 0);
  const canAllocateUsedTokens =
    typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens > 0;

  return shares.map(({ chars, source, percent }) => {
    const normalizedPercent = totalPercent > 0 ? percent / totalPercent : 0;
    return {
      chars,
      displayTokens: canAllocateUsedTokens ? usedTokens * normalizedPercent : null,
      percent: normalizedPercent,
      source,
    };
  });
}
