/**
 * 页面可见性生命周期的前台监听器。
 *
 * 移动端浏览器切后台会冻结页面：定时器不再触发，socket 可能被系统静默掐掉，
 * 而 Web 端没有存活性检测（不接入 PersistentProtocol 的心跳/ACK），于是状态会
 * 卡在过期的 `connected`。此时必须由本监听器按隐藏时长决定是否强制重建连接，
 * 否则回前台的 `retryNow()` 会被 connected 早退整个吞掉。
 *
 * 同时监听 `pageshow`：iOS 从 BFCache 恢复只发 `pageshow`，不保证发
 * `visibilitychange`，只依赖后者会漏掉这条路径。
 */

/** 隐藏超过该时长后回前台，强制销毁当前代际并重建连接。 */
export const DEFAULT_FOREGROUND_RECONNECT_THRESHOLD_MS = 8_000;

interface ForegroundEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface ForegroundDocumentLike {
  readonly visibilityState?: string;
}

interface ForegroundGlobalLike {
  readonly window?: ForegroundEventTarget;
  readonly document?: ForegroundDocumentLike;
}

export interface ForegroundWatchOptions {
  /** 强制重建的阈值，默认 {@link DEFAULT_FOREGROUND_RECONNECT_THRESHOLD_MS}。 */
  readonly thresholdMs?: number;
  readonly now?: () => number;
  /**
   * 回前台回调。入参表示隐藏时长是否超过阈值。
   * 未隐藏过直接收到事件的场景（如首次 pageshow）以 false 调用。
   */
  readonly onForegroundReturn: (shouldForce: boolean) => void;
}

export interface ForegroundWatch {
  attach(): void;
  detach(): void;
}

function foregroundWindow(): ForegroundEventTarget | undefined {
  return (globalThis as unknown as ForegroundGlobalLike).window;
}

function foregroundDocument(): ForegroundDocumentLike | undefined {
  return (globalThis as unknown as ForegroundGlobalLike).document;
}

/**
 * 是否应当无条件重建连接。隐藏时长未知（没有隐藏过）时不强制。
 */
export function shouldForceReconnect(
  hiddenDurationMs: number | null,
  thresholdMs: number,
): boolean {
  return hiddenDurationMs !== null && hiddenDurationMs > thresholdMs;
}

export function createForegroundWatch(options: ForegroundWatchOptions): ForegroundWatch {
  const thresholdMs = options.thresholdMs ?? DEFAULT_FOREGROUND_RECONNECT_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  let attached = false;
  let hiddenAt: number | null = null;

  const markHidden = (): void => {
    hiddenAt = now();
  };

  const handleForeground = (): void => {
    const duration = hiddenAt === null ? null : now() - hiddenAt;
    // 同一次回前台可能先后触发 visibilitychange 与 pageshow，
    // 取一次即清空，避免同一次返回被判成两次。
    hiddenAt = null;
    options.onForegroundReturn(shouldForceReconnect(duration, thresholdMs));
  };

  const handleVisibilityChange = (): void => {
    const state = foregroundDocument()?.visibilityState;
    if (state === "hidden") {
      markHidden();
      return;
    }
    // prerender / unloaded 不是「回到前台」，不参与判定。
    if (state === "visible") {
      handleForeground();
    }
  };

  return {
    attach(): void {
      if (attached) return;
      const target = foregroundWindow();
      if (!target) return;
      target.addEventListener("visibilitychange", handleVisibilityChange);
      target.addEventListener("pagehide", markHidden);
      target.addEventListener("pageshow", handleForeground);
      attached = true;
    },
    detach(): void {
      if (!attached) return;
      const target = foregroundWindow();
      target?.removeEventListener("visibilitychange", handleVisibilityChange);
      target?.removeEventListener("pagehide", markHidden);
      target?.removeEventListener("pageshow", handleForeground);
      attached = false;
    },
  };
}
