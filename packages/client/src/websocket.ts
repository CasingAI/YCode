/* eslint-disable max-lines -- WebSocket 生命周期状态机与浏览器/测试适配保持在单一传输边界。 */
import {
  ChannelClient,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type ChannelRequestLatencySample,
  type IDisposable,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { WebConnectionInfo, WebConnectionLatency } from "@zcode/shared";
import { createForegroundWatch, type ForegroundWatch } from "./foreground-watch.js";
import { RemoteServiceAccess, type RemoteServiceAccessOptions } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type WebSocketConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface WebSocketConnectionSnapshot {
  readonly status: WebSocketConnectionStatus;
  readonly generation: number;
  /**
   * 同一逻辑连接（同一 Host 的一次 attachment 生命周期）内稳定的连续性 token。
   *
   * 与 `generation` 的区别：`generation` 是物理发布代际，通道升级/回退时递增；
   * `continuityGeneration` 只在逻辑连接真正结束（断线、重连、owner 重建）时更换。
   * 消费者用它判断在途结果是否仍然属于当前逻辑连接。
   *
   * 可选字段兼容既有快照构造者；生产 managed WebSocket 与 WebRTC 选择器始终发布。
   */
  readonly continuityGeneration?: number;
  /**
   * 退避阶梯的内部计数，不是给用户看的进度。手机切后台通常远短于稳定期，
   * 该值会在页面生命周期内单调累加，渲染出来等于「切 App 的次数」。
   * UI 只能把它当日志，禁止呈现给用户。
   */
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  /** 进入退避等待的时刻；连接 ready 时清空。UI 用它判断该不该升级形态。 */
  readonly disconnectedAt: number | null;
  readonly services: IServiceAccessor | null;
  readonly lastClose: WebSocketConnectionCloseEvent | null;
  /**
   * 连接 owner 发布的只读连接信息。
   *
   * 可选字段兼容既有快照构造者；生产 managed WebSocket 与 WebRTC 选择器始终发布。
   */
  readonly connectionInfo?: WebConnectionInfo;
  /** RPC Regular payload 的页面生命周期累计字节数。 */
  readonly traffic?: { readonly sentBytes: number; readonly receivedBytes: number };
  /** 当前活动通道最近一次合法 RPC 样本；切换、断线或过期后缺失。 */
  readonly latency?: WebConnectionLatency;
}

export interface WebSocketConnection {
  getSnapshot(): WebSocketConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  onStateChange(listener: () => void): () => void;
  retryNow(): void;
  dispose(): void;
}

export type WebSocketFactory = (url: string) => WebSocket;

export interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  webSocketFactory?: WebSocketFactory;
  initializeTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  /**
   * 页面隐藏超过该时长后回前台，无条件销毁当前代际并重建连接。
   * 默认 8 秒；测试应传小值，不依赖真实等待。
   */
  foregroundReconnectThresholdMs?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /** 服务端通过已鉴权 server-info 声明该 WebSocket 可调用只读额度通道。 */
  cliProxyQuota?: boolean;
  /**
   * 仅流量变化的快照发布合并间隔。
   *
   * RPC 流可能在每秒产生数十条载荷；逐条通知会让整个 WebApp 随流式输出重渲染。
   * 连接状态变化仍立即发布，这里只合并纯流量更新。
   */
  trafficPublishIntervalMs?: number;
  /**
   * 最近一次合法延迟样本的本地过期时长，默认 60 秒。
   *
   * 过期只清空本地快照，不发包、不测速；WebRTC 选择器继承同一值。
   */
  latencyStaleMs?: number;
}

interface ActiveConnection {
  readonly raw: WebSocket;
  readonly generation: number;
  readonly continuityGeneration: number;
  readonly protocol: SocketProtocol;
  readonly client: ChannelClient;
  readonly services: RemoteServiceAccess;
  settled: boolean;
  readySettled: boolean;
  readyReject: ((error: Error) => void) | null;
  readyDisposable: IDisposable | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  connectedAt: number | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 30_000;
/**
 * 心跳间隔。
 *
 * 公网隧道（localtunnel 等）会掐掉空闲约 120 秒的连接，20 秒一次的心跳让连接保持活跃，
 * 代价是每 20 秒 13 字节的零负载帧，可以忽略。
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_TRAFFIC_PUBLISH_INTERVAL_MS = 250;
export const DEFAULT_LATENCY_STALE_MS = 60_000;

interface BrowserEventTarget {
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface BrowserGlobal {
  window?: BrowserEventTarget;
  document?: { visibilityState?: string };
}

function browserWindow(): BrowserEventTarget | undefined {
  return (globalThis as unknown as BrowserGlobal).window;
}

function createConnectionClosedError(reason?: string): Error {
  const error = new Error(reason ?? "WebSocket connection closed");
  error.name = "ConnectionClosed";
  return error;
}

let nextContinuityGeneration = 1;

/**
 * 模块级单调分配器。
 *
 * continuity token 只在同一连接 owner 内比较，但必须保证不同实例、不同 Host 的
 * token 不会碰撞：否则把某个实例的旧 token 传给另一个连接时会被误认为同一逻辑连接。
 * 进程内单调递增即可满足，不需要持久化。
 */
function allocateContinuityGeneration(): number {
  return nextContinuityGeneration++;
}

function closeEventFromWebSocket(event: CloseEvent): WebSocketConnectionCloseEvent {
  return {
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  };
}

function errorCloseEvent(): WebSocketConnectionCloseEvent {
  return {
    code: 1006,
    reason: "WebSocket transport error",
    wasClean: false,
  };
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(event.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

class ManagedWebSocketConnection implements WebSocketConnection {
  private readonly listeners = new Set<() => void>();
  private readonly retryDelaysMs: readonly number[];
  private readonly initializeTimeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly factory: WebSocketFactory;
  private browserListenersAttached = false;
  private readonly foregroundWatch: ForegroundWatch;
  private snapshot: WebSocketConnectionSnapshot = {
    status: "connecting",
    generation: 0,
    attempt: 0,
    nextRetryAt: null,
    disconnectedAt: null,
    services: null,
    lastClose: null,
  };
  private active: ActiveConnection | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAttempts = 0;
  private hasConnected = false;
  private disposed = false;
  private readonly traffic = { sentBytes: 0, receivedBytes: 0 };
  private trafficPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly trafficPublishIntervalMs: number;
  /** 只保留最近一次合法样本的原始值；不平均、不按耗时筛选。 */
  private latency: WebConnectionLatency | undefined;
  private latencyExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly latencyStaleMs: number;
  private initialSettled = false;
  private initialResolve: (() => void) | null = null;
  private initialReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly options: WebSocketConnectionOptions,
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.setTimeout ??
      ((handler, timeoutMs) => setTimeout(handler, timeoutMs) as ReturnType<typeof setTimeout>);
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.trafficPublishIntervalMs =
      options.trafficPublishIntervalMs ?? DEFAULT_TRAFFIC_PUBLISH_INTERVAL_MS;
    this.latencyStaleMs = options.latencyStaleMs ?? DEFAULT_LATENCY_STALE_MS;
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    // 初始快照也发布连接信息；WSS 没有 WebRTC 直连能力。
    this.snapshot = {
      ...this.snapshot,
      connectionInfo: this.connectionInfoFor(this.snapshot.status),
      traffic: this.trafficSnapshot(),
    };
    this.browserListenersAttached = false;
    this.foregroundWatch = createForegroundWatch({
      thresholdMs: options.foregroundReconnectThresholdMs,
      now: this.now,
      onForegroundReturn: this.handleForegroundReturn,
    });
  }

  start(): Promise<WebSocketConnection> {
    const initial = new Promise<WebSocketConnection>((resolve, reject) => {
      this.initialResolve = () => {
        if (this.initialSettled) return;
        this.initialSettled = true;
        resolve(this);
      };
      this.initialReject = (error) => {
        if (this.initialSettled) return;
        this.initialSettled = true;
        reject(error);
      };
    });
    this.attachBrowserListeners();
    this.foregroundWatch.attach();
    this.attemptConnection(true);
    return initial;
  }

  getSnapshot(): WebSocketConnectionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: () => void): () => void {
    return this.subscribe(listener);
  }

  retryNow(): void {
    if (
      this.disposed ||
      this.snapshot.status === "connected" ||
      this.snapshot.status === "closed"
    ) {
      return;
    }
    this.clearRetryTimer();
    this.attemptConnection(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetryTimer();
    this.clearTrafficPublishTimer();
    this.clearLatency();
    this.detachBrowserListeners();
    this.foregroundWatch.detach();
    const active = this.active;
    this.active = null;
    if (active) {
      this.teardownActive(
        active,
        createConnectionClosedError("WebSocket connection disposed"),
        true,
      );
    }
    this.publish({
      ...this.snapshot,
      status: "closed",
      nextRetryAt: null,
      services: null,
    });
    this.initialReject?.(createConnectionClosedError("WebSocket connection disposed"));
    this.initialResolve = null;
    this.initialReject = null;
  }

  private attachBrowserListeners(): void {
    if (this.browserListenersAttached) return;
    const target = browserWindow();
    if (!target) return;
    // visibilitychange / pagehide / pageshow 由 foregroundWatch 单独持有，
    // 它需要先记录隐藏时刻才能判断是否强制重建。
    target.addEventListener("online", this.handleBrowserRetry);
    target.addEventListener("focus", this.handleBrowserRetry);
    this.browserListenersAttached = true;
  }

  private detachBrowserListeners(): void {
    if (!this.browserListenersAttached) return;
    const target = browserWindow();
    target?.removeEventListener("online", this.handleBrowserRetry);
    target?.removeEventListener("focus", this.handleBrowserRetry);
    this.browserListenersAttached = false;
  }

  private readonly handleBrowserRetry = (): void => {
    this.retryNow();
  };

  private readonly handleForegroundReturn = (shouldForce: boolean): void => {
    if (shouldForce) {
      this.forceReconnectOnForeground();
      return;
    }
    this.retryNow();
  };

  /**
   * 前台恢复时无条件重建连接。
   *
   * 手机切后台期间浏览器冻结页面，socket 可能已被系统掐掉而 JS 完全没有感知，
   * 状态会一直卡在过期的 `connected`；此时 `retryNow()` 的 connected 早退会把
   * 回前台事件整个吞掉，页面看着是活的、实际已经不可用。
   */
  private forceReconnectOnForeground(): void {
    if (this.disposed || this.snapshot.status === "closed") return;
    this.clearRetryTimer();
    const active = this.active;
    if (active) {
      if (active.settled) return;
      // 走与失败路径相同的 settled 去重，否则紧随其后的真实 close
      // 会被当成又一次断线，重复计一次失败。
      active.settled = true;
      if (this.active === active) this.active = null;
      this.teardownActive(
        active,
        createConnectionClosedError("Reconnecting after returning to foreground"),
        true,
      );
    }
    // 这是一次明确的「重新开始」，把退避阶梯归零让用户回到 0/1/2/5/10/30 的起点。
    // 不会形成 0 秒热循环：本路径必须由 visibilitychange / pageshow 触发，
    // 依赖用户切走再回来，不存在自动连续触发的可能。
    this.failedAttempts = 0;
    this.attemptConnection(false);
  }

  private attemptConnection(initial: boolean): void {
    if (this.disposed || this.active) return;
    this.clearRetryTimer();
    // 新代际从零开始：旧通道的样本不能跨代继承或回填。
    this.clearLatency();
    const generation = this.snapshot.generation + 1;
    // 每次物理尝试都属于新的逻辑连接起点：旧代在途结果不得穿越到这里。
    const continuityGeneration = allocateContinuityGeneration();
    this.publish({
      ...this.snapshot,
      status: initial ? "connecting" : "reconnecting",
      generation,
      continuityGeneration,
      nextRetryAt: null,
      services: null,
    });

    let raw: WebSocket;
    try {
      raw = this.factory(this.url);
    } catch (error) {
      this.handleFailure(initial, null, {
        code: 1006,
        reason: error instanceof Error ? error.message : String(error),
        wasClean: false,
      });
      return;
    }

    const protocol = new SocketProtocol(wrapBrowserWebSocket(raw), {
      onSent: (bytes) => {
        this.traffic.sentBytes += bytes;
        this.scheduleTrafficPublish();
      },
      onReceived: (bytes) => {
        this.traffic.receivedBytes += bytes;
        this.scheduleTrafficPublish();
      },
    });
    const client = new ChannelClient(protocol, {
      onRequestLatencySample: (sample) => {
        const active = this.active;
        // 回调随 client 销毁失效；再用当前代际 guard 防止迟到样本写回。
        if (this.disposed || !active || active.generation !== generation || active.settled) {
          return;
        }
        this.acceptLatencySample(sample);
      },
    });
    const services = new RemoteServiceAccess(client, {
      cliProxyQuota: this.options.cliProxyQuota === true,
    });
    const active: ActiveConnection = {
      raw,
      generation,
      continuityGeneration,
      protocol,
      client,
      services,
      settled: false,
      readySettled: false,
      readyReject: null,
      readyDisposable: null,
      readyTimer: null,
      openTimer: null,
      connectedAt: null,
      heartbeatTimer: null,
    };
    this.active = active;
    active.openTimer = this.schedule(() => {
      if (this.disposed || this.active !== active || active.settled) return;
      this.handleFailure(!this.hasConnected, active, {
        code: 1006,
        reason: "WebSocket open timed out",
        wasClean: false,
      });
    }, this.initializeTimeoutMs);

    const onOpen = (): void => {
      if (active.openTimer !== null) {
        this.cancel(active.openTimer);
        active.openTimer = null;
      }
      if (this.disposed || this.active !== active || active.settled) {
        closeWebSocket(raw);
        return;
      }
      this.options.onOpenSocket?.(raw);
      void this.waitForInitialize(active);
    };
    const onError = (): void => {
      this.handleFailure(!this.hasConnected, active, errorCloseEvent());
    };
    const onClose = (event: CloseEvent): void => {
      this.handleFailure(!this.hasConnected, active, closeEventFromWebSocket(event));
    };
    raw.addEventListener("open", onOpen, { once: true });
    raw.addEventListener("error", onError, { once: true });
    raw.addEventListener("close", onClose, { once: true });
  }

  private async waitForInitialize(active: ActiveConnection): Promise<void> {
    if (active.settled || active.readySettled) return;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          active.readySettled = true;
          if (active.readyTimer !== null) {
            this.cancel(active.readyTimer);
            active.readyTimer = null;
          }
          active.readyDisposable?.dispose();
          active.readyDisposable = null;
          active.readyReject = null;
          if (error) reject(error);
          else resolve();
        };
        active.readyReject = finish;
        active.readyDisposable = active.client.onDidInitialize(() => finish());
        active.readyTimer = this.schedule(
          () => finish(new Error("WebSocket ChannelClient initialization timed out")),
          this.initializeTimeoutMs,
        );
      });
    } catch (error) {
      if (!active.settled) {
        this.handleFailure(!this.hasConnected, active, {
          code: 1006,
          reason: error instanceof Error ? error.message : String(error),
          wasClean: false,
        });
      }
      return;
    }

    if (this.disposed || this.active !== active || active.settled) return;
    // 不在握手完成瞬间清零失败计数；只有连接稳定一段时间后才允许下一次断线从
    // 初始退避开始，避免“Initialize 成功后立即断开”形成 0 秒热循环。
    active.connectedAt = this.now();
    this.hasConnected = true;
    this.startHeartbeat(active);
    this.publish({
      status: "connected",
      generation: active.generation,
      continuityGeneration: active.continuityGeneration,
      attempt: 0,
      nextRetryAt: null,
      disconnectedAt: null,
      services: active.services,
      lastClose: this.snapshot.lastClose,
    });
    this.initialResolve?.();
  }

  private handleFailure(
    initial: boolean,
    active: ActiveConnection | null,
    close: WebSocketConnectionCloseEvent,
  ): void {
    if (this.disposed) return;
    // 断线即失效：旧通道可能仍有在途响应，但其样本不能进入下一次发布。
    this.clearLatency();
    if (active) {
      if (active.settled) return;
      active.settled = true;
      if (this.active === active) this.active = null;
      this.teardownActive(active, createConnectionClosedError(close.reason), true);
    } else if (this.active) {
      return;
    }

    this.options.onClose?.(close);
    if (initial) {
      this.publish({
        ...this.snapshot,
        status: "connecting",
        continuityGeneration: allocateContinuityGeneration(),
        attempt: this.failedAttempts,
        nextRetryAt: null,
        services: null,
        lastClose: close,
      });
      this.initialReject?.(new Error(`WebSocket connection failed: ${this.url}`));
      this.dispose();
      return;
    }

    const connectedAt = active?.connectedAt ?? null;
    const now = this.now();
    if (connectedAt !== null && now - connectedAt >= STABLE_CONNECTION_RESET_MS) {
      this.failedAttempts = 0;
    }

    this.failedAttempts += 1;
    const delayIndex = Math.min(this.failedAttempts - 1, this.retryDelaysMs.length - 1);
    const delay = Math.max(0, this.retryDelaysMs[delayIndex] ?? 0);
    const nextRetryAt = now + delay;
    this.publish({
      ...this.snapshot,
      status: "reconnecting",
      // 断线即结束当前逻辑连接：即使物理 generation 未变，也必须立即换 token，
      // 否则旧通道的迟到成功结果会被误认为仍属于当前连接。
      continuityGeneration: allocateContinuityGeneration(),
      attempt: this.failedAttempts,
      nextRetryAt,
      // 同一次断线期间连续失败时保留最初那一刻，
      // 这样 UI 算的是「已经断了多久」而不是「上次失败多久之前」。
      disconnectedAt: this.snapshot.disconnectedAt ?? now,
      services: null,
      lastClose: close,
    });
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.attemptConnection(false);
    }, delay);
  }

  private teardownActive(active: ActiveConnection, error: Error, rejectReady: boolean): void {
    if (rejectReady) {
      active.readyReject?.(error);
    }
    active.readyDisposable?.dispose();
    active.readyDisposable = null;
    if (active.openTimer !== null) {
      this.cancel(active.openTimer);
      active.openTimer = null;
    }
    if (active.readyTimer !== null) {
      this.cancel(active.readyTimer);
      active.readyTimer = null;
    }
    if (active.heartbeatTimer !== null) {
      this.cancel(active.heartbeatTimer);
      active.heartbeatTimer = null;
    }
    active.client.dispose(error);
    active.protocol.dispose();
    closeWebSocket(active.raw);
  }

  /**
   * 定期发心跳帧，保持穿过公网隧道的连接不被按空闲掐断。
   *
   * 只在握手完成后启动：连接没建好时发心跳没有意义，还会把失败统计搅浑。
   */
  private startHeartbeat(active: ActiveConnection): void {
    if (active.heartbeatTimer !== null) return;
    const tick = (): void => {
      if (this.disposed || this.active !== active || active.settled) return;
      try {
        active.protocol.sendKeepAlive();
      } catch {
        // 写失败说明连接已经不可用，交给既有的失败/重连路径处理。
        return;
      }
      active.heartbeatTimer = this.schedule(tick, HEARTBEAT_INTERVAL_MS);
    };
    active.heartbeatTimer = this.schedule(tick, HEARTBEAT_INTERVAL_MS);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.cancel(this.retryTimer);
    this.retryTimer = null;
  }

  private clearTrafficPublishTimer(): void {
    if (this.trafficPublishTimer === null) return;
    this.cancel(this.trafficPublishTimer);
    this.trafficPublishTimer = null;
  }

  /** 合并高频流量与延迟通知；连接状态发布包含实时值，会顺带取消这次合并。 */
  private scheduleTrafficPublish(): void {
    if (this.disposed || this.trafficPublishTimer !== null) return;
    this.trafficPublishTimer = this.schedule(() => {
      this.trafficPublishTimer = null;
      if (this.disposed) return;
      this.snapshot = {
        ...this.snapshot,
        traffic: this.trafficSnapshot(),
        latency: this.latency,
      };
      for (const listener of this.listeners) listener();
    }, this.trafficPublishIntervalMs);
  }

  private trafficSnapshot(): { sentBytes: number; receivedBytes: number } {
    return { sentBytes: this.traffic.sentBytes, receivedBytes: this.traffic.receivedBytes };
  }

  private acceptLatencySample(sample: ChannelRequestLatencySample): void {
    // 只保存原始样本；合法性由 RPC 层保证，不在 UI 侧重复校验或 clamp。
    this.latency = {
      networkRoundTripMs: sample.networkRoundTripMs,
      serverProcessingMs: sample.serverProcessingMs,
    };
    // 快照同步更新但不通知：RTC 选择器在切换点会直接读取 fallback 快照建立基线，
    // 若等 250ms 合并发布，切换前完成的样本会被误当成切换后新样本。
    this.snapshot = { ...this.snapshot, latency: this.latency };
    this.scheduleLatencyExpiry();
    this.scheduleTrafficPublish();
  }

  private scheduleLatencyExpiry(): void {
    this.clearLatencyExpiryTimer();
    const sample = this.latency;
    this.latencyExpiryTimer = this.schedule(() => {
      // 计时器可能已被新样本替换；即使调度器丢弃了 clearTimeout，迟到回调也不能清除新样本。
      if (this.disposed || this.latency !== sample) return;
      this.latencyExpiryTimer = null;
      this.latency = undefined;
      // 过期是用户可见状态变化，立即发布，不等流量合并。
      this.publish({ ...this.snapshot });
    }, this.latencyStaleMs);
  }

  private clearLatencyExpiryTimer(): void {
    if (this.latencyExpiryTimer === null) return;
    this.cancel(this.latencyExpiryTimer);
    this.latencyExpiryTimer = null;
  }

  /** 新代际、断线、切换或 dispose 统一走这里，取消本地过期计时器。 */
  private clearLatency(): void {
    this.latency = undefined;
    this.clearLatencyExpiryTimer();
    // 同步清空快照，保证切换点读取 getSnapshot() 时不会看到已失效样本。
    this.snapshot = { ...this.snapshot, latency: undefined };
  }

  private connectionInfoFor(status: WebSocketConnectionStatus): WebConnectionInfo {
    return {
      // 只有 services 实际可用时才存在活动 RPC 通道；connecting/reconnecting/closed 均为 null。
      transport: status === "connected" ? "websocket" : null,
      directState: "disabled",
    };
  }

  private publish(snapshot: WebSocketConnectionSnapshot): void {
    // 本次发布已经带上最新累计值，不必再等合并通知。
    this.clearTrafficPublishTimer();
    const traffic = this.trafficSnapshot();
    this.snapshot = {
      ...snapshot,
      connectionInfo: this.connectionInfoFor(snapshot.status),
      traffic,
      latency: this.latency,
    };
    for (const listener of this.listeners) listener();
  }
}

function closeWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}

/**
 * 建立一次性的浏览器 WebSocket 服务连接。保留该入口供只需要单次握手的调用方使用；
 * Web 页面使用 connectViaWebSocketManaged 获得断线后的生命周期管理。
 */
export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    let raw: WebSocket;
    try {
      raw = (options?.webSocketFactory ?? ((url) => new WebSocket(url)))(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;

    raw.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    raw.addEventListener("close", (event) => {
      options?.onClose?.(closeEventFromWebSocket(event));
      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    raw.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(raw);
      resolve(
        connectViaProtocol(new SocketProtocol(wrapBrowserWebSocket(raw)), {
          cliProxyQuota: options?.cliProxyQuota === true,
        }),
      );
    });
  });
}

export function connectViaWebSocketManaged(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<WebSocketConnection> {
  return new ManagedWebSocketConnection(wsUrl, options ?? {}).start();
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options?: RemoteServiceAccessOptions,
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
