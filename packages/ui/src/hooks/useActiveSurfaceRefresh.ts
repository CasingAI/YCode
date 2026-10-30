import { useCallback, useEffect, useRef } from "react";

/** 自动化列表的周期刷新间隔；与 Host 侧快照写入节奏保持一致。 */
export const ACTIVE_SURFACE_REFRESH_INTERVAL_MS = 10_000;

export interface UseActiveSurfaceRefreshOptions {
  /** 表面在前台且处于可刷新视图时开启；false 时停止定时器与全部监听。 */
  active: boolean;
  /** 既有 store/service 刷新入口；自身负责错误收敛，hook 不重试、不弹提示。 */
  refresh: () => Promise<unknown> | unknown;
  intervalMs?: number;
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 可见表面周期刷新：
 * - 首次挂载不立即刷新（挂载初始化由调用方负责）；挂载时表面不可见则首次激活也立即刷新；
 *   保活表面重新激活时立即刷新一次；
 * - 窗口聚焦或 document 恢复可见时立即刷新并恢复周期，document 隐藏时暂停周期；
 * - 周期、焦点、可见性与激活共用一次在途刷新，重复触发合并为一次尾随刷新，避免请求堆叠。
 *
 * 返回值是手动刷新入口 `refreshNow`：与上述自动触发走同一条单飞队列。已有刷新在途时
 * 并入该次请求而不另发一次，调用方可 await 它维持自己的 loading 状态；隐藏后不补尾随。
 */
export function useActiveSurfaceRefresh({
  active,
  refresh,
  intervalMs = ACTIVE_SURFACE_REFRESH_INTERVAL_MS,
}: UseActiveSurfaceRefreshOptions): () => Promise<void> {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // 记录首次渲染时的可见性：正常挂载交给调用方 initialize；若挂载时表面本就不可见
  // （保活层被设置/文件主视图覆盖），第一次激活同样视为重新激活，必须立即刷新。
  const initiallyActiveRef = useRef(active);
  const activatedBeforeRef = useRef(false);
  const activeRef = useRef(active);
  // 单飞队列跨 active 切换保留：失活时只丢弃尾随标记，已在途请求自然结束；
  // 若请求结束前重新激活，仍按「重新激活立即刷新」补一次。
  const inFlightRef = useRef<Promise<void> | null>(null);
  const trailingRef = useRef(false);

  const run = useCallback((): Promise<void> => {
    const inFlight = inFlightRef.current;
    if (inFlight) return inFlight;
    const request = Promise.resolve()
      .then(async () => {
        await refreshRef.current();
      })
      .catch(() => {
        // store 刷新入口已记录错误；周期刷新不重试，也不把失败升级成 toast。
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
        const queued = trailingRef.current;
        trailingRef.current = false;
        // 隐藏或失活后不补尾随：隐藏期间必须停止周期刷新，恢复可见/激活时另有立即刷新。
        if (queued && activeRef.current && !isDocumentHidden()) void run();
      });
    inFlightRef.current = request;
    return request;
  }, []);

  const scheduled = useCallback((): void => {
    // 所有自动触发（周期、焦点、可见性恢复、首次激活）统一在隐藏时暂停：
    // 保活层可能在 document 已隐藏时完成 active false→true，激活分支不能绕过该规则。
    if (!activeRef.current || isDocumentHidden()) return;
    if (inFlightRef.current) {
      trailingRef.current = true;
      return;
    }
    void run();
  }, [run]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      trailingRef.current = false;
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const startTimer = () => {
      if (timer !== null || document.visibilityState === "hidden") return;
      timer = setInterval(scheduled, intervalMs);
    };

    const handleFocus = () => {
      if (document.visibilityState === "hidden") return;
      scheduled();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopTimer();
        return;
      }
      scheduled();
      startTimer();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (activatedBeforeRef.current || !initiallyActiveRef.current) scheduled();
    activatedBeforeRef.current = true;

    startTimer();

    return () => {
      activeRef.current = false;
      trailingRef.current = false;
      stopTimer();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, intervalMs, scheduled]);

  return run;
}
