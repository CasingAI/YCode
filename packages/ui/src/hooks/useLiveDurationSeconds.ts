import { useEffect, useMemo, useState } from "react";
import { conversationDurationSeconds } from "@/v4/conversationDurationDisplay.js";

const MS_IN_S = 1000;

/**
 * 对话时间线行耗时的秒表：思考行与工具行共用。
 *
 * 只做两件事：把起点/定格值换算成秒，以及在行仍未闭合时按整秒边界驱动一次重算。
 * 起点始终来自行数据，组件不记录挂载时刻，所以切会话、虚拟列表回收、live tail 搬家
 * 导致的重建不会让数字归零重新爬。
 *
 * 定时器对齐到「起点之后的整秒边界」而不是固定 1000ms：后者会让显示秒数与真实时间
 * 差一个累计偏移，跨整秒的时刻也对不齐。
 *
 * @param running 行是否仍在进行。为假时不再起表，直接用 `durationMs` 定格。
 * @param startedAt 行起点（毫秒）。缺省时视为「从未真正开始」，不显示耗时。
 * @param durationMs 行闭合时写入的定格耗时（毫秒）。
 * @param enabled 附加门控。思考行收起时不显示秒数，用它停表以免每秒重渲染整块内容。
 */
export function useLiveDurationSeconds(input: {
  running: boolean;
  startedAt: number | undefined;
  durationMs: number | undefined;
  enabled?: boolean;
}): number | undefined {
  const { running, startedAt, durationMs, enabled = true } = input;
  const [now, setNow] = useState(() => Date.now());
  // 只有「仍在进行、有起点、且没有定格值」才需要走表：已闭合的行读 durationMs 即可。
  const ticking = running && durationMs === undefined && startedAt !== undefined && enabled;

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

  return useMemo(
    () => conversationDurationSeconds({ startedAt, durationMs, running, now }),
    [durationMs, now, running, startedAt],
  );
}
