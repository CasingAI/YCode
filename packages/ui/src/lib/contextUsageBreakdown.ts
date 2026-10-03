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
      // 来源占比是估算，乘出来的折算值天然带小数；token 计数不存在小数，
      // 不取整会在浮层里渲染成 `305.7` 这种虚假精度。取整后各来源求和不再严格等于
      // used，偏差上界为「来源数 ÷ 2」个 token，相对上下文窗口不可见。
      displayTokens: canAllocateUsedTokens ? Math.round(usedTokens * normalizedPercent) : null,
      percent: normalizedPercent,
      source,
    };
  });
}
