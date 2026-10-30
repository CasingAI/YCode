import { logger } from "@/logger.js";
import {
  RENDERER_PERFORMANCE_SLOW_MS,
  RENDERER_PERFORMANCE_WINDOW_MS,
  sanitizeRendererPerformanceNumber,
  type RendererPerformanceStage,
  type RendererPerformanceSummaryV1,
} from "./rendererPerformanceDiagnosticsCore.js";
import { RendererPerformanceDiagnosticsRuntime } from "./rendererPerformanceDiagnosticsRuntime.js";
import type {
  RendererPerformanceCancelAnimationFrame,
  RendererPerformanceObserverFactory,
  RendererPerformanceRequestAnimationFrame,
  RendererPerformanceScheduler,
  RendererPerformanceVisibility,
} from "./rendererPerformanceDiagnosticsBrowser.js";

export type {
  RendererPerformanceCapabilities,
  RendererPerformanceLoafMetrics,
  RendererPerformanceObserved,
  RendererPerformanceObserverMetrics,
  RendererPerformanceRafMetrics,
  RendererPerformanceRuntimeMetrics,
  RendererPerformanceStage,
  RendererPerformanceStageMetrics,
  RendererPerformanceSummaryV1,
  RendererPerformanceTimerMetrics,
} from "./rendererPerformanceDiagnosticsCore.js";
export type {
  RendererPerformanceCancelAnimationFrame,
  RendererPerformanceObserverFactory,
  RendererPerformanceObserverHandle,
  RendererPerformanceRequestAnimationFrame,
  RendererPerformanceScheduler,
  RendererPerformanceVisibility,
  RendererPerformanceVisibilityEvent,
} from "./rendererPerformanceDiagnosticsBrowser.js";

export interface RendererPerformanceDiagnosticsHandle {
  stop(): void;
  flush(): void;
}

export interface RendererPerformanceDiagnosticsOptions {
  enabled?: boolean;
  windowMs?: number;
  slowThresholdMs?: number;
  now?: () => number;
  scheduler?: RendererPerformanceScheduler;
  visibility?: RendererPerformanceVisibility;
  observerFactory?: RendererPerformanceObserverFactory;
  requestAnimationFrame?: RendererPerformanceRequestAnimationFrame;
  cancelAnimationFrame?: RendererPerformanceCancelAnimationFrame;
  /** 仅测试或显式开关使用；默认与 Profiler 接线共用 import.meta.env.DEV。 */
  profilingEnabled?: boolean;
  write?: (summary: RendererPerformanceSummaryV1) => void;
}

const NOOP_HANDLE: RendererPerformanceDiagnosticsHandle = {
  stop() {},
  flush() {},
};

let activeRuntime: RendererPerformanceDiagnosticsRuntime | undefined;
let refCount = 0;

function isRendererPerformanceDevBuild(): boolean {
  try {
    return (import.meta as ImportMeta & { env?: { readonly DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}

function normalizePositive(value: unknown, fallback: number): number {
  const normalized = sanitizeRendererPerformanceNumber(value);
  return normalized !== undefined && normalized > 0 ? normalized : fallback;
}

function normalizeNonNegative(value: unknown, fallback: number): number {
  return sanitizeRendererPerformanceNumber(value) ?? fallback;
}

function defaultWrite(summary: RendererPerformanceSummaryV1): void {
  logger.lifecycle.info("[ui-perf]", summary);
}

function createHandle(
  runtime: RendererPerformanceDiagnosticsRuntime,
): RendererPerformanceDiagnosticsHandle {
  let stopped = false;
  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (activeRuntime !== runtime) {
        return;
      }
      refCount -= 1;
      if (refCount > 0) {
        return;
      }
      activeRuntime = undefined;
      refCount = 0;
      runtime.dispose();
    },
    flush() {
      if (activeRuntime === runtime) {
        runtime.flush();
      }
    },
  };
}

/**
 * 启动 renderer 性能诊断。Desktop bootstrap 每窗口调用一次；Web 不调用。
 * 重复启动使用引用计数；旧 handle 不会停止后来重启的实例。
 */
export function startRendererPerformanceDiagnostics(
  options: RendererPerformanceDiagnosticsOptions = {},
): RendererPerformanceDiagnosticsHandle {
  if (options.enabled === false) {
    return NOOP_HANDLE;
  }
  if (activeRuntime) {
    refCount += 1;
    return createHandle(activeRuntime);
  }

  let runtime: RendererPerformanceDiagnosticsRuntime | undefined;
  try {
    runtime = new RendererPerformanceDiagnosticsRuntime({
      windowMs: normalizePositive(options.windowMs, RENDERER_PERFORMANCE_WINDOW_MS),
      slowThresholdMs: normalizeNonNegative(options.slowThresholdMs, RENDERER_PERFORMANCE_SLOW_MS),
      profilingEnabled: options.profilingEnabled ?? isRendererPerformanceDevBuild(),
      write: options.write ?? defaultWrite,
      onPagehide: () => {
        if (activeRuntime === runtime) {
          activeRuntime = undefined;
          refCount = 0;
        }
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(options.observerFactory ? { observerFactory: options.observerFactory } : {}),
      ...(options.requestAnimationFrame
        ? { requestAnimationFrame: options.requestAnimationFrame }
        : {}),
      ...(options.cancelAnimationFrame
        ? { cancelAnimationFrame: options.cancelAnimationFrame }
        : {}),
    });
  } catch {
    return NOOP_HANDLE;
  }

  activeRuntime = runtime;
  refCount = 1;
  return createHandle(runtime);
}

/**
 * 测量一次同步 stage。未启动时直接执行，不读取 clock。
 * 诊断自身失败被隔离；run 的原返回 identity 与原异常 identity 保持不变。
 */
export function measureRendererPerformance<T>(
  stage: RendererPerformanceStage,
  run: () => T,
  workUnits?: number,
): T {
  const runtime = activeRuntime;
  if (!runtime) {
    return run();
  }
  const startedAt = runtime.now();
  if (startedAt === undefined) {
    return run();
  }
  try {
    return run();
  } finally {
    const endedAt = runtime.now();
    if (endedAt !== undefined && endedAt >= startedAt) {
      try {
        runtime.recordStage(stage, endedAt - startedAt, workUnits);
      } catch {
        // 诊断失败不能替换业务返回或异常。
      }
    }
  }
}

/** 给 React Profiler 或其他无法用 measure 包装的同步回调记录耗时。 */
export function recordRendererPerformanceDuration(
  stage: RendererPerformanceStage,
  durationMs: number,
  workUnits?: number,
): void {
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }
  try {
    runtime.recordStage(stage, durationMs, workUnits);
  } catch {
    // 诊断失败不能影响调用方。
  }
}
