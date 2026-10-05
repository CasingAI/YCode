import { useEffect, useMemo, useState } from "react";

const MS_IN_S = 1000;

/**
 * 等待预算的倒计时：返回「还可等待的毫秒数」。
 *
 * 不复用 `useLiveDurationSeconds`：那条推导最终走 `conversationDurationSeconds`，
 * 对秒数做「最小 1 秒」钳位（耗时要显示「已持续 1 秒」而不是「0 秒」）。倒计时语义相反，
 * 15 秒预算在起点必须显示 15，复用会从 14 起跳，等于把整个预算系统性少报一秒。
 *
 * 起点始终来自行数据（`ToolCallStarted` 的 startedAt），组件不记录挂载时刻，所以切会话、
 * 虚拟列表回收导致的重建不会让数字跳回满预算。定时器对齐到起点之后的整秒边界而不是固定
 * 1000ms：后者会让显示秒数与真实时间差一个累计偏移。
 *
 * @param running 等待是否仍在进行。为假时直接返回 undefined，调用方不渲染倒计时。
 * @param startedAt 行起点（毫秒）。缺省时视为「预算尚未开始」，不显示倒计时。
 * @param budgetMs 本次调用的等待预算（毫秒）。缺省时调用方没有可展示的预算。
 */
export function useRemainingWaitMs(input: {
  running: boolean;
  startedAt: number | undefined;
  budgetMs: number | undefined;
}): number | undefined {
  const { running, startedAt, budgetMs } = input;
  const [now, setNow] = useState(() => Date.now());
  const ticking = running && startedAt !== undefined && budgetMs !== undefined;

  useEffect(() => {
    if (!ticking || startedAt === undefined) {
      return;
    }
    let timer: number | undefined;
    const scheduleNextTick = () => {
      setNow(Date.now());
      timer = window.setTimeout(scheduleNextTick, MS_IN_S - ((Date.now() - startedAt) % MS_IN_S));
    };
    scheduleNextTick();
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [startedAt, ticking]);

  return useMemo(() => {
    if (!ticking || startedAt === undefined || budgetMs === undefined) return undefined;
    // 预算用尽后停在 0，不允许显示负数。
    return Math.max(0, budgetMs - (now - startedAt));
  }, [budgetMs, now, startedAt, ticking]);
}
