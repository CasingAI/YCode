import { useEffect, useRef, useState } from "react";
import { STARTUP_BRAND_SETTLE_MS } from "@/root/startupBrandTiming.js";
import {
  advanceStartupBrandExitHold,
  createStartupBrandExitHoldState,
  settleStartupBrandExitHold,
} from "@/root/startupBrandExitHold.js";

/**
 * 启动屏的退出保持期。
 *
 * 启动门控清除只代表可以进入主界面，而阶段 2 的图标定格有 420ms；
 * 门控一翻转就卸载启动屏会让这段收尾动画整段看不见（等于白做）。
 * 这里在门控 true → false 的那一帧开启保持期，播完才真正卸载。
 */
export function useStartupBrandExitHold(isStartupRenderBlocked: boolean): boolean {
  const [isExitHold, setIsExitHold] = useState(false);
  const stateRef = useRef(createStartupBrandExitHoldState(isStartupRenderBlocked));
  useEffect(() => {
    const step = advanceStartupBrandExitHold(stateRef.current, isStartupRenderBlocked);
    stateRef.current = step.state;
    setIsExitHold(step.state.isExitHold);
    if (!step.startSettleTimer) {
      return;
    }
    const timer = window.setTimeout(() => {
      stateRef.current = settleStartupBrandExitHold(stateRef.current);
      setIsExitHold(false);
    }, STARTUP_BRAND_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isStartupRenderBlocked]);
  return isExitHold;
}
