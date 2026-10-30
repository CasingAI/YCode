import {
  buildRendererPerformanceSummary,
  createRendererPerformanceWindowState,
  hasRendererPerformanceWindowActivity,
  recordRendererPerformanceLongTask,
  recordRendererPerformanceRafInterval,
  recordRendererPerformanceStage,
  recordRendererPerformanceTimerDelay,
  resetRendererPerformanceWindowState,
  RENDERER_PERFORMANCE_SAMPLE_TIMER_MS,
  sanitizeRendererPerformanceNumber,
  type RendererPerformanceCapabilities,
  type RendererPerformanceStage,
  type RendererPerformanceWindowState,
} from "./rendererPerformanceDiagnosticsCore.js";
import {
  recordRendererPerformanceLoafEntry,
  type RendererPerformanceLoafEntry,
} from "./rendererPerformanceDiagnosticsLoaf.js";
import {
  defaultRendererPerformanceCancelAnimationFrame,
  defaultRendererPerformanceNow,
  defaultRendererPerformanceObserverFactory,
  defaultRendererPerformanceRequestAnimationFrame,
  defaultRendererPerformanceScheduler,
  defaultRendererPerformanceVisibility,
  type RendererPerformanceCancelAnimationFrame,
  type RendererPerformanceObserverFactory,
  type RendererPerformanceObserverHandle,
  type RendererPerformanceRequestAnimationFrame,
  type RendererPerformanceRuntimeOptions,
  type RendererPerformanceScheduler,
  type RendererPerformanceVisibility,
  type RendererPerformanceVisibilityEvent,
} from "./rendererPerformanceDiagnosticsBrowser.js";

/**
 * Renderer 性能诊断 runtime：只负责浏览器采样、窗口定时和 observer 生命周期。
 * 观测失败只丢当前样本/窗口，不能影响业务或抛出到调用方。
 */
export class RendererPerformanceDiagnosticsRuntime {
  private readonly state: RendererPerformanceWindowState = createRendererPerformanceWindowState();
  private readonly capabilities: RendererPerformanceCapabilities;
  private readonly observers: RendererPerformanceObserverHandle[] = [];
  private readonly listeners: Array<{
    type: RendererPerformanceVisibilityEvent;
    listener: (event: Event) => void;
  }> = [];
  private readonly nowFn: () => number;
  private readonly scheduler: RendererPerformanceScheduler;
  private readonly visibility: RendererPerformanceVisibility;
  private readonly observerFactory: RendererPerformanceObserverFactory;
  private readonly raf: RendererPerformanceRequestAnimationFrame | undefined;
  private readonly rafAvailable: boolean;
  private readonly cancelRaf: RendererPerformanceCancelAnimationFrame;
  private windowTimer: unknown;
  private sampleTimer: unknown;
  private rafHandle: number | undefined;
  private lastFrameAt: number | undefined;
  private lastTimerExpectedAt: number | undefined;
  private stopped = false;

  constructor(private readonly options: RendererPerformanceRuntimeOptions) {
    this.nowFn = options.now ?? defaultRendererPerformanceNow;
    this.scheduler = options.scheduler ?? defaultRendererPerformanceScheduler;
    this.visibility = options.visibility ?? defaultRendererPerformanceVisibility;
    this.observerFactory = options.observerFactory ?? defaultRendererPerformanceObserverFactory;
    this.raf = options.requestAnimationFrame ?? defaultRendererPerformanceRequestAnimationFrame;
    this.rafAvailable =
      typeof options.requestAnimationFrame === "function" ||
      (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function");
    this.cancelRaf = options.cancelAnimationFrame ?? defaultRendererPerformanceCancelAnimationFrame;
    this.capabilities = {
      performanceObserver:
        options.observerFactory !== undefined || typeof PerformanceObserver !== "undefined",
      longTask: false,
      longAnimationFrame: false,
      requestAnimationFrame: this.rafAvailable,
      reactProfiler: options.profilingEnabled ? "dev-only" : "unavailable",
    };
    this.installListeners();
    this.startObservers();
    this.startWindowTimer();
    this.syncSampling();
  }

  now(): number | undefined {
    try {
      const value = this.nowFn();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  recordStage(stage: RendererPerformanceStage, durationMs: unknown, workUnits: unknown): void {
    if (this.stopped) {
      return;
    }
    if (stage === "react.session-pane") {
      if (sanitizeRendererPerformanceNumber(durationMs) !== undefined) {
        this.state.observed.reactProfilerCallbacks += 1;
      }
    }
    recordRendererPerformanceStage(
      this.state,
      stage,
      durationMs,
      workUnits,
      this.options.slowThresholdMs,
    );
  }

  flush(): void {
    if (this.stopped) {
      return;
    }
    const hasActivity = hasRendererPerformanceWindowActivity(this.state);
    const summary = buildRendererPerformanceSummary(
      this.state,
      this.options.windowMs,
      this.capabilities,
    );
    resetRendererPerformanceWindowState(this.state);
    if (!hasActivity || !summary) {
      return;
    }
    try {
      this.options.write(summary);
    } catch {
      // writer 失败只丢本窗，不重试、不影响下一窗口。
    }
  }

  dispose(): void {
    if (this.stopped) {
      return;
    }
    this.flush();
    this.stopped = true;
    this.clearTimer(this.windowTimer);
    this.windowTimer = undefined;
    this.clearTimer(this.sampleTimer);
    this.sampleTimer = undefined;
    this.cancelRafHandle();
    for (const observer of this.observers) {
      try {
        observer.disconnect();
      } catch {
        // observer 清理失败不能阻止其他清理。
      }
    }
    this.observers.length = 0;
    this.removeListeners();
    resetRendererPerformanceWindowState(this.state);
  }

  private installListeners(): void {
    const add = (type: RendererPerformanceVisibilityEvent, listener: (event: Event) => void) => {
      try {
        this.visibility.addEventListener(type, listener);
        this.listeners.push({ type, listener });
      } catch {
        // 单个监听失败不能阻止其他采样启动。
      }
    };
    add("visibilitychange", () => this.syncSampling());
    add("focus", () => this.syncSampling());
    add("blur", () => this.pauseSampling());
    add("pagehide", () => this.handlePagehide());
  }

  private removeListeners(): void {
    for (const { type, listener } of this.listeners) {
      try {
        this.visibility.removeEventListener(type, listener);
      } catch {
        // 清理失败不能阻止其他清理。
      }
    }
    this.listeners.length = 0;
  }

  private handlePagehide(): void {
    if (this.stopped) {
      return;
    }
    this.flush();
    this.dispose();
    try {
      this.options.onPagehide();
    } catch {
      // 页面卸载路径不能因模块清理失败而阻塞。
    }
  }

  private startObservers(): void {
    const types: Array<{
      type: "longtask" | "long-animation-frame";
      capability: "longTask" | "longAnimationFrame";
    }> = [
      { type: "longtask", capability: "longTask" },
      { type: "long-animation-frame", capability: "longAnimationFrame" },
    ];
    for (const { type, capability } of types) {
      try {
        const handle = this.observerFactory(type, (entries) => {
          if (this.stopped) {
            return;
          }
          this.safe(() => this.handleObserverEntries(type, entries));
        });
        if (!handle) {
          continue;
        }
        try {
          handle.observe();
        } catch {
          try {
            handle.disconnect();
          } catch {
            // 启动失败的 observer 也要尽量断开。
          }
          continue;
        }
        this.observers.push(handle);
        this.capabilities[capability] = true;
      } catch {
        // 单个 observer 启动失败只影响该能力，不影响其他采样。
      }
    }
  }

  private handleObserverEntries(
    type: "longtask" | "long-animation-frame",
    entries: readonly PerformanceEntry[],
  ): void {
    for (const entry of entries) {
      if (type === "longtask") {
        recordRendererPerformanceLongTask(this.state, entry as { duration?: unknown });
      } else {
        recordRendererPerformanceLoafEntry(this.state, entry as RendererPerformanceLoafEntry);
      }
    }
  }

  private startWindowTimer(): void {
    try {
      this.windowTimer = this.scheduler.setInterval(() => {
        this.safe(() => this.flush());
      }, this.options.windowMs);
    } catch {
      this.windowTimer = undefined;
    }
  }

  private syncSampling(): void {
    if (this.stopped) {
      return;
    }
    if (!this.isSamplingAllowed()) {
      this.pauseSampling();
      return;
    }
    this.startRafLoop();
    this.startSampleTimer();
  }

  private isSamplingAllowed(): boolean {
    try {
      return this.visibility.isVisible() && this.visibility.isFocused();
    } catch {
      return false;
    }
  }

  private pauseSampling(): void {
    this.cancelRafHandle();
    this.clearTimer(this.sampleTimer);
    this.sampleTimer = undefined;
    this.lastFrameAt = undefined;
    this.lastTimerExpectedAt = undefined;
  }

  private startSampleTimer(): void {
    if (this.sampleTimer !== undefined) {
      return;
    }
    try {
      this.sampleTimer = this.scheduler.setInterval(() => {
        this.safe(() => this.sampleTimerDelay());
      }, RENDERER_PERFORMANCE_SAMPLE_TIMER_MS);
    } catch {
      this.sampleTimer = undefined;
    }
  }

  private sampleTimerDelay(): void {
    if (this.stopped || !this.isSamplingAllowed()) {
      return;
    }
    const now = this.now();
    if (now === undefined) {
      return;
    }
    if (this.lastTimerExpectedAt !== undefined) {
      const delay = now - this.lastTimerExpectedAt;
      if (delay >= 0) {
        this.state.observed.timerSamples += 1;
        recordRendererPerformanceTimerDelay(this.state, delay);
      }
    }
    this.lastTimerExpectedAt = now + RENDERER_PERFORMANCE_SAMPLE_TIMER_MS;
  }

  private startRafLoop(): void {
    if (
      this.stopped ||
      this.rafHandle !== undefined ||
      !this.rafAvailable ||
      typeof this.raf !== "function" ||
      !this.isSamplingAllowed()
    ) {
      return;
    }
    const tick = (timestamp: number): void => {
      this.rafHandle = undefined;
      if (this.stopped || !this.isSamplingAllowed()) {
        return;
      }
      try {
        const at = Number.isFinite(timestamp) ? timestamp : this.now();
        if (at === undefined) {
          return;
        }
        if (this.lastFrameAt !== undefined) {
          const interval = at - this.lastFrameAt;
          if (interval >= 0) {
            this.state.observed.rafSamples += 1;
            recordRendererPerformanceRafInterval(this.state, interval);
          }
        }
        this.lastFrameAt = at;
      } catch {
        // 单帧采样失败只丢当前样本。
      }
      if (!this.stopped && this.isSamplingAllowed()) {
        this.scheduleRaf(tick);
      }
    };
    this.scheduleRaf(tick);
  }

  private scheduleRaf(tick: (timestamp: number) => void): void {
    if (!this.rafAvailable || typeof this.raf !== "function") {
      return;
    }
    try {
      this.rafHandle = this.raf(tick) ?? undefined;
    } catch {
      this.rafHandle = undefined;
    }
  }

  private cancelRafHandle(): void {
    if (this.rafHandle === undefined) {
      return;
    }
    try {
      this.cancelRaf(this.rafHandle);
    } catch {
      // 取消失败只影响当前 rAF 句柄。
    }
    this.rafHandle = undefined;
  }

  private clearTimer(handle: unknown): void {
    if (handle === undefined) {
      return;
    }
    try {
      this.scheduler.clearInterval(handle);
    } catch {
      // 定时器清理失败不能阻止其他清理。
    }
  }

  private safe(callback: () => void): void {
    try {
      callback();
    } catch {
      // 诊断回调永远不能影响业务。
    }
  }
}
