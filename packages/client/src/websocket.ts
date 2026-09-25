/* eslint-disable max-lines -- WebSocket 生命周期状态机与浏览器/测试适配保持在单一传输边界。 */
import {
  ChannelClient,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IDisposable,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export type WebSocketConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface WebSocketConnectionSnapshot {
  readonly status: WebSocketConnectionStatus;
  readonly generation: number;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly services: IServiceAccessor | null;
  readonly lastClose: WebSocketConnectionCloseEvent | null;
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
  now?: () => number;
  setTimeout?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface ActiveConnection {
  readonly raw: WebSocket;
  readonly generation: number;
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
}

const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_RESET_MS = 30_000;

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
  private snapshot: WebSocketConnectionSnapshot = {
    status: "connecting",
    generation: 0,
    attempt: 0,
    nextRetryAt: null,
    services: null,
    lastClose: null,
  };
  private active: ActiveConnection | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAttempts = 0;
  private hasConnected = false;
  private disposed = false;
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
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.browserListenersAttached = false;
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
    this.detachBrowserListeners();
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
    target.addEventListener("online", this.handleBrowserRetry);
    target.addEventListener("focus", this.handleBrowserRetry);
    target.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.browserListenersAttached = true;
  }

  private detachBrowserListeners(): void {
    if (!this.browserListenersAttached) return;
    const target = browserWindow();
    target?.removeEventListener("online", this.handleBrowserRetry);
    target?.removeEventListener("focus", this.handleBrowserRetry);
    target?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.browserListenersAttached = false;
  }

  private readonly handleBrowserRetry = (): void => {
    this.retryNow();
  };

  private readonly handleVisibilityChange = (): void => {
    const document = (globalThis as unknown as BrowserGlobal).document;
    if (!document || document.visibilityState === "visible") {
      this.retryNow();
    }
  };

  private attemptConnection(initial: boolean): void {
    if (this.disposed || this.active) return;
    this.clearRetryTimer();
    const generation = this.snapshot.generation + 1;
    this.publish({
      ...this.snapshot,
      status: initial ? "connecting" : "reconnecting",
      generation,
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

    const protocol = new SocketProtocol(wrapBrowserWebSocket(raw));
    const client = new ChannelClient(protocol);
    const services = new RemoteServiceAccess(client);
    const active: ActiveConnection = {
      raw,
      generation,
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
    this.publish({
      status: "connected",
      generation: active.generation,
      attempt: 0,
      nextRetryAt: null,
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
      attempt: this.failedAttempts,
      nextRetryAt,
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
    active.client.dispose(error);
    active.protocol.dispose();
    closeWebSocket(active.raw);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.cancel(this.retryTimer);
    this.retryTimer = null;
  }

  private publish(snapshot: WebSocketConnectionSnapshot): void {
    this.snapshot = snapshot;
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
      resolve(connectViaProtocol(new SocketProtocol(wrapBrowserWebSocket(raw))));
    });
  });
}

export function connectViaWebSocketManaged(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<WebSocketConnection> {
  return new ManagedWebSocketConnection(wsUrl, options ?? {}).start();
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}
