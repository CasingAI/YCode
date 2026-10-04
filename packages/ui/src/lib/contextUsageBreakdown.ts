import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";

export type ContextUsageBreakdownSource = ZCodeContextUsageBreakdownItem["source"];

export interface ContextUsageBreakdownSegment {
  chars: number;
  tokens: number;
  displayTokens: number | null;
  percent: number;
  source: ContextUsageBreakdownSource;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function buildContextUsageBreakdownSegments(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
  usedTokens: number | null | undefined,
): ContextUsageBreakdownSegment[] {
  const items = (breakdown ?? []).filter((item) => isPositiveFinite(item.chars));
  // 占比基准优先取中英文加权 token 估算量：纯字符数会把英文为主的工具定义高估、
  // 把中文为主的消息低估。仅当全部条目都缺合法 tokens 时才整组回退按字符量，
  // 因为半数条目按 token、半数按字符得到的是两个不同量纲的占比，比统一按字符更错。
  const useTokenBasis = items.length > 0 && items.every((item) => isPositiveFinite(item.tokens));

  const basisBySource = new Map<ContextUsageBreakdownSource, number>();
  const charsBySource = new Map<ContextUsageBreakdownSource, number>();
  for (const item of items) {
    const basis = useTokenBasis ? (item.tokens as number) : item.chars;
    basisBySource.set(item.source, (basisBySource.get(item.source) ?? 0) + basis);
    charsBySource.set(item.source, (charsBySource.get(item.source) ?? 0) + item.chars);
  }

  const totalBasis = [...basisBySource.values()].reduce((sum, basis) => sum + basis, 0);
  if (totalBasis <= 0) {
    return [];
  }

  const shares = [...basisBySource.entries()].map(([source, basis]) => ({
    basis,
    chars: charsBySource.get(source) ?? 0,
    source,
    percent: basis / totalBasis,
  }));
  const totalPercent = shares.reduce((sum, share) => sum + share.percent, 0);
  const canAllocateUsedTokens =
    typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens > 0;

  return shares.map(({ basis, chars, source, percent }) => {
    const normalizedPercent = totalPercent > 0 ? percent / totalPercent : 0;
    return {
      chars,
      tokens: Math.round(basis),
      // 来源占比是估算，乘出来的折算值天然带小数；token 计数不存在小数，
      // 不取整会在浮层里渲染成 `305.7` 这种虚假精度。取整后各来源求和不再严格等于
      // used，偏差上界为「来源数 ÷ 2」个 token，相对上下文窗口不可见。
      displayTokens: canAllocateUsedTokens ? Math.round(usedTokens * normalizedPercent) : null,
      percent: normalizedPercent,
      source,
    };
  });
}
