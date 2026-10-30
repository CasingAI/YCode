/**
 * Renderer 性能诊断的浏览器适配层：可注入接口与生产默认实现。
 * 单独成文件，避免 runtime 主类超出单文件行数上限；这里不做任何聚合。
 */
import type { RendererPerformanceSummaryV1 } from "./rendererPerformanceDiagnosticsCore.js";

export interface RendererPerformanceScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type RendererPerformanceVisibilityEvent = "visibilitychange" | "focus" | "blur" | "pagehide";

export interface RendererPerformanceVisibility {
  isVisible(): boolean;
  isFocused(): boolean;
  addEventListener(
    type: RendererPerformanceVisibilityEvent,
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: RendererPerformanceVisibilityEvent,
    listener: (event: Event) => void,
  ): void;
}

export interface RendererPerformanceObserverHandle {
  observe(): void;
  disconnect(): void;
}

export type RendererPerformanceObserverFactory = (
  type: "longtask" | "long-animation-frame",
  callback: (entries: readonly PerformanceEntry[]) => void,
) => RendererPerformanceObserverHandle | null;

export type RendererPerformanceRequestAnimationFrame = (
  callback: (timestamp: number) => void,
) => number | undefined;

export type RendererPerformanceCancelAnimationFrame = (handle: number) => void;

export interface RendererPerformanceRuntimeOptions {
  windowMs: number;
  slowThresholdMs: number;
  profilingEnabled: boolean;
  write: (summary: RendererPerformanceSummaryV1) => void;
  onPagehide: () => void;
  now?: () => number;
  scheduler?: RendererPerformanceScheduler;
  visibility?: RendererPerformanceVisibility;
  observerFactory?: RendererPerformanceObserverFactory;
  requestAnimationFrame?: RendererPerformanceRequestAnimationFrame;
  cancelAnimationFrame?: RendererPerformanceCancelAnimationFrame;
}

export const defaultRendererPerformanceNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export const defaultRendererPerformanceScheduler: RendererPerformanceScheduler = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown,
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export const defaultRendererPerformanceVisibility: RendererPerformanceVisibility = {
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  isFocused: () =>
    typeof document === "undefined" ||
    typeof document.hasFocus !== "function" ||
    document.hasFocus(),
  addEventListener: (type, listener) => {
    if (typeof window !== "undefined") {
      window.addEventListener(type, listener);
    }
  },
  removeEventListener: (type, listener) => {
    if (typeof window !== "undefined") {
      window.removeEventListener(type, listener);
    }
  },
};

export function defaultRendererPerformanceRequestAnimationFrame(
  callback: (timestamp: number) => void,
): number | undefined {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return undefined;
  }
  return window.requestAnimationFrame(callback);
}

export function defaultRendererPerformanceCancelAnimationFrame(handle: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
  }
}

export function defaultRendererPerformanceObserverFactory(
  type: "longtask" | "long-animation-frame",
  callback: (entries: readonly PerformanceEntry[]) => void,
): RendererPerformanceObserverHandle | null {
  if (typeof PerformanceObserver === "undefined") {
    return null;
  }
  try {
    const supported = (
      PerformanceObserver as typeof PerformanceObserver & {
        supportedEntryTypes?: readonly string[];
      }
    ).supportedEntryTypes;
    if (supported && !supported.includes(type)) {
      return null;
    }
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    return {
      observe() {
        observer.observe({ entryTypes: [type] });
      },
      disconnect() {
        observer.disconnect();
      },
    };
  } catch {
    return null;
  }
}
