/* eslint-disable max-lines -- 连接选择器需要同时持有 fallback WSS、信令、peer 与代际切换状态。 */
import {
  ChannelClient,
  SocketProtocol,
  createDataChannelSocket,
  type DataChannelTransport,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  WEB_RTC_SIGNAL_VERSION,
  webRtcSignalSchema,
  type WebConnectionInfo,
  type WebRtcSignal,
} from "@zcode/shared";
import {
  connectViaWebSocketManaged,
  getWebSocketOrigin,
  type WebSocketConnection,
  type WebSocketConnectionOptions,
  type WebSocketConnectionSnapshot,
  type WebSocketConnectionStatus,
  type WebSocketFactory,
} from "./websocket.js";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { createDataChannelTransport, type RtcDataChannelLike } from "./webRtcTransport.js";

const WEBSOCKET_OPEN = 1;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALING_HEARTBEAT_MS = 20_000;
const DATA_CHANNEL_LABEL = "zcode-rpc";

export interface RtcPeerConnectionLike {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { type: string; sdp?: string } | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  onicegatheringstatechange: ((event: unknown) => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean }): RtcDataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  close(): void;
}

export type RtcPeerConnectionFactory = (
  configuration: RtcPeerConnectionConfiguration,
) => RtcPeerConnectionLike;

/**
 * 只声明本实现使用到的字段，避免 client 在没有 DOM lib 的消费者里（例如
 * desktop host 沿 server 源码间接编译）依赖全局 `RTCConfiguration`。
 * `iceServers` 恒为空，不做 STUN/TURN。
 */
export interface RtcPeerConnectionConfiguration {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
}

export type RtcDataChannelSocketFactory = (transport: DataChannelTransport) => ISocket;

export interface WebRtcConnectionOptions extends WebSocketConnectionOptions {
  /** 测试可注入可控 peer；生产使用全局 RTCPeerConnection。 */
  peerConnectionFactory?: RtcPeerConnectionFactory;
  /** 测试可注入可控 uuid；每条物理 fallback 连接都会调用一次。 */
  rtcIdFactory?: () => string;
  /** 通常由 @zcode/rpc 的 createDataChannelSocket 提供；测试可注入桥接实现。 */
  dataChannelSocketFactory?: RtcDataChannelSocketFactory;
  /** 从发起信令到 DataChannel 可用（含 ICE/answer）的上限。 */
  negotiationTimeoutMs?: number;
  /**
   * RTC ready 后信令 ping 的间隔。
   *
   * 信令沿用 fallback 的保护隧道；部分隧道会回收约 120 秒无数据的连接。
   * 保持 RTC 期间必须有应用层心跳，默认 20 秒，测试可注入更短间隔。
   */
  signalingHeartbeatMs?: number;
}

export interface WebRtcDirectAvailability {
  capability: boolean;
  isRemoteRoute: boolean;
  isSecureContext: boolean;
  hasPeerConnection: boolean;
}

/**
 * Web bootstrap 的唯一能力开关：只有宿主声明能力、当前不是 `?remote=` 路由、
 * 页面处于安全上下文且浏览器提供 RTCPeerConnection 时才尝试直连。
 */
export function shouldAttemptWebRtcDirect(input: WebRtcDirectAvailability): boolean {
  return (
    input.capability === true &&
    input.isRemoteRoute === false &&
    input.isSecureContext === true &&
    input.hasPeerConnection === true
  );
}

interface RtcSession {
  readonly id: number;
  ready: boolean;
  tearingDown: boolean;
  answerReceived: boolean;
  channelOpened: boolean;
  peer: RtcPeerConnectionLike | null;
  signal: WebSocket | null;
  channel: RtcDataChannelLike | null;
  socket: ISocket | null;
  protocol: SocketProtocol | null;
  client: ChannelClient | null;
  services: RemoteServiceAccess | null;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly aborts: Set<(error: Error) => void>;
  signalMessageHandler: ((event: unknown) => void) | null;
  signalCloseHandler: (() => void) | null;
  signalErrorHandler: (() => void) | null;
  readonly channelListeners: [string, (event: unknown) => void][];
  rpcInitialized: boolean;
  rpcInitializePromise: Promise<void>;
  resolveRpcInitialize: (() => void) | null;
}

function createConnectionError(message: string): Error {
  const error = new Error(message);
  error.name = "ConnectionClosed";
  return error;
}

function resolvePeerConnectionFactory(
  options: WebRtcConnectionOptions,
): RtcPeerConnectionFactory | null {
  if (options.peerConnectionFactory) return options.peerConnectionFactory;
  const scope = globalThis as {
    RTCPeerConnection?: new (
      configuration: RtcPeerConnectionConfiguration,
    ) => RtcPeerConnectionLike;
    isSecureContext?: boolean;
  };
  // 非安全上下文不实例化 peer；HTTP LAN 继续沿用现有 WSS 行为。
  if (scope.isSecureContext === false) return null;
  const ctor = scope.RTCPeerConnection;
  return typeof ctor === "function" ? (configuration) => new ctor(configuration) : null;
}

function resolveRtcId(options: WebRtcConnectionOptions): string | null {
  if (options.rtcIdFactory) {
    try {
      // 空 id 视为无法生成：不能进入直连协商，也不能让信息层误报 connecting。
      return options.rtcIdFactory() || null;
    } catch {
      return null;
    }
  }
  const randomUUID = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof randomUUID !== "function") return null;
  try {
    return randomUUID.call(globalThis.crypto);
  } catch {
    return null;
  }
}

/** 保留 `?remote=` 等其他查询参数，只为单条物理 fallback 连接追加 rtcId。 */
function withRtcId(wsUrl: string, rtcId: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("rtcId", rtcId);
  return url.toString();
}

/** 信令端点固定挂在同一 origin 的 `/ws/rtc`，cookie 由浏览器自动携带。 */
function buildSignalUrl(wsUrl: string, rtcId: string): string {
  const url = new URL(wsUrl);
  url.pathname = "/ws/rtc";
  url.search = "";
  url.hash = "";
  url.searchParams.set("rtcId", rtcId);
  return url.toString();
}

function readSignalText(event: unknown): string | null {
  const data = (event as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return null;
}

function closeWebSocket(socket: WebSocket): void {
  const state = (socket as { readyState?: number }).readyState;
  if (state === 0 || state === WEBSOCKET_OPEN) {
    try {
      socket.close();
    } catch {
      // 关闭失败不影响回退；下面的 peer/channel 回收仍会执行。
    }
  }
}

class OpportunityWebRtcConnection implements WebSocketConnection {
  private readonly listeners = new Set<() => void>();
  private readonly schedule: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly signalFactory: WebSocketFactory;
  private readonly negotiationTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly signalingHeartbeatMs: number;
  /** 已配置服务入口的脱敏 origin；断开和 dispose 后仍保留。 */
  private readonly endpoint: string | null;
  private readonly unsubscribeFallback: () => void;
  private snapshot: WebSocketConnectionSnapshot;
  private fallbackGeneration: number;
  /** 连接选择器自己的代次，跨 WSS/RTC 切换严格单调。 */
  private generation = 0;
  private targetKey: string | null = null;
  private attemptedGeneration: number | null = null;
  /**
   * 页面生命周期内所有 RTC 物理通道的 RPC 载荷累计值。
   *
   * 协商期间也会产生 Initialize、在途请求和旧会话迟到载荷；它们都是真实
   * 业务流量，进入页面累计值，但不依赖某个 session 是否已成为当前 services。
   */
  private readonly rtcTraffic = { sentBytes: 0, receivedBytes: 0 };
  private trafficPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly trafficPublishIntervalMs: number;
  private rtc: RtcSession | null = null;
  private nextSessionId = 0;
  private disposed = false;

  constructor(
    private readonly fallback: WebSocketConnection,
    private readonly wsUrl: string,
    /** 读取当前物理 fallback 对应的临时 rtcId；每条 fallback 连接都会重新生成。 */
    private readonly rtcIdProvider: (() => string | null) | null,
    private readonly peerFactory: RtcPeerConnectionFactory | null,
    private readonly dataChannelSocketFactory: RtcDataChannelSocketFactory | null,
    signalFactory: WebSocketFactory,
    private readonly options: WebRtcConnectionOptions,
  ) {
    this.schedule =
      options.setTimeout ??
      ((handler, timeoutMs) => setTimeout(handler, timeoutMs) as ReturnType<typeof setTimeout>);
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    // 信令必须使用原始工厂，不能复用按 fallback 逐个追加 rtcId 的包装工厂。
    this.signalFactory = signalFactory;
    this.negotiationTimeoutMs = options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.signalingHeartbeatMs = options.signalingHeartbeatMs ?? DEFAULT_SIGNALING_HEARTBEAT_MS;
    this.trafficPublishIntervalMs = options.trafficPublishIntervalMs ?? 250;
    this.endpoint = getWebSocketOrigin(wsUrl);

    const fallbackSnapshot = fallback.getSnapshot();
    this.fallbackGeneration = fallbackSnapshot.generation;
    this.snapshot = {
      ...fallbackSnapshot,
      generation: 0,
      connectionInfo: this.connectionInfoFor(fallbackSnapshot, null),
      traffic: fallbackSnapshot.traffic,
    };
    this.unsubscribeFallback = fallback.subscribe(this.handleFallbackChange);
  }

  start(): WebSocketConnection {
    this.publishComposed();
    this.maybeAttemptRtc();
    return this;
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
    if (this.disposed) return;
    this.fallback.retryNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTrafficPublishTimer();
    this.unsubscribeFallback();
    this.teardownCurrentRtc();
    this.fallback.dispose();
    this.generation += 1;
    this.snapshot = {
      ...this.snapshot,
      status: "closed",
      generation: this.generation,
      nextRetryAt: null,
      services: null,
      connectionInfo: this.connectionInfoFor(this.fallback.getSnapshot(), null),
      traffic: this.trafficSnapshot(this.fallback.getSnapshot()),
    };
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  private readonly handleFallbackChange = (): void => {
    if (this.disposed) return;
    const fallback = this.fallback.getSnapshot();
    if (fallback.generation !== this.fallbackGeneration) {
      // fallback 换代（含前台强制重建）后，旧 RTC/信令立即失效；
      // 新代恢复 connected 后允许再尝试一次。
      this.fallbackGeneration = fallback.generation;
      this.teardownCurrentRtc();
      this.attemptedGeneration = null;
    } else if (this.rtc && (fallback.status !== "connected" || !fallback.services)) {
      // fallback 断开意味着 rtcId 关联已失效，不能继续使用直连。
      this.teardownCurrentRtc();
    }
    this.publishComposed();
    this.maybeAttemptRtc();
  };

  private clearTrafficPublishTimer(): void {
    if (this.trafficPublishTimer === null) return;
    this.cancel(this.trafficPublishTimer);
    this.trafficPublishTimer = null;
  }

  private scheduleTrafficPublish(): void {
    if (this.disposed || this.trafficPublishTimer !== null) return;
    this.trafficPublishTimer = this.schedule(() => {
      this.trafficPublishTimer = null;
      if (this.disposed) return;
      this.publishTrafficOnly();
    }, this.trafficPublishIntervalMs);
  }

  private publishTrafficOnly(): void {
    this.snapshot = {
      ...this.snapshot,
      traffic: this.trafficSnapshot(this.fallback.getSnapshot()),
    };
    for (const listener of this.listeners) listener();
  }

  private trafficSnapshot(fallback: WebSocketConnectionSnapshot): {
    sentBytes: number;
    receivedBytes: number;
  } {
    const fallbackTraffic = fallback.traffic ?? { sentBytes: 0, receivedBytes: 0 };
    return {
      sentBytes: fallbackTraffic.sentBytes + this.rtcTraffic.sentBytes,
      receivedBytes: fallbackTraffic.receivedBytes + this.rtcTraffic.receivedBytes,
    };
  }

  private publishComposed(): void {
    const fallback = this.fallback.getSnapshot();
    const rtc = this.rtc;
    let services: IServiceAccessor | null;
    let status: WebSocketConnectionStatus;
    let targetKey: string | null;
    let transport: WebConnectionInfo["transport"];

    if (rtc?.ready && rtc.services && !rtc.tearingDown) {
      services = rtc.services;
      status = "connected";
      targetKey = `rtc:${rtc.id}`;
      transport = "webrtc";
    } else if (fallback.status === "connected" && fallback.services) {
      services = fallback.services;
      status = "connected";
      targetKey = `wss:${fallback.generation}`;
      transport = "websocket";
    } else {
      services = null;
      status = fallback.status;
      targetKey = null;
      transport = null;
    }

    if (targetKey !== this.targetKey) {
      this.targetKey = targetKey;
      this.generation += 1;
    }

    // 本次发布已经带上最新累计值，不必再等合并通知。
    this.clearTrafficPublishTimer();
    this.snapshot = {
      status,
      generation: this.generation,
      attempt: fallback.attempt,
      nextRetryAt: fallback.nextRetryAt,
      disconnectedAt: fallback.disconnectedAt,
      services,
      lastClose: fallback.lastClose,
      connectionInfo: this.connectionInfoFor(fallback, transport),
      traffic: this.trafficSnapshot(fallback),
    };
    for (const listener of this.listeners) listener();
  }

  /**
   * 连接信息与 services 使用同一次选择结果，避免 info 和实际业务通道分离。
   *
   * `connected` 只在活动传输是 RTC 时出现；RTC 失败或断开后必须回到
   * fallback/waiting，closed/dispose 不允许保留 webrtc。
   */
  private connectionInfoFor(
    fallback: WebSocketConnectionSnapshot,
    transport: WebConnectionInfo["transport"],
  ): WebConnectionInfo {
    return {
      transport,
      directState: this.resolveDirectState(fallback, transport),
      endpoint: this.endpoint,
    };
  }

  private resolveDirectState(
    fallback: WebSocketConnectionSnapshot,
    transport: WebConnectionInfo["transport"],
  ): WebConnectionInfo["directState"] {
    if (!this.hasRtcCapability()) return "disabled";
    if (transport === "webrtc") return "connected";
    // 基础连接不可用时只能等待，不能继续声称正在尝试直连。
    if (fallback.status !== "connected" || !fallback.services) return "waiting";
    if (this.rtc) return "connecting";
    // attemptedGeneration 在尝试开始时即写入；rtc 已回收才表示本代尝试结束。
    return this.attemptedGeneration === fallback.generation ? "fallback" : "connecting";
  }

  private hasRtcCapability(): boolean {
    return (
      this.rtcIdProvider !== null &&
      this.peerFactory !== null &&
      this.dataChannelSocketFactory !== null &&
      this.rtcIdProvider() !== null
    );
  }

  private maybeAttemptRtc(): void {
    if (this.disposed || this.rtc) return;
    if (!this.rtcIdProvider || !this.peerFactory || !this.dataChannelSocketFactory) {
      return;
    }
    const fallback = this.fallback.getSnapshot();
    if (fallback.status !== "connected" || !fallback.services) return;
    // 每个 fallback generation 最多尝试一次，失败不建立热循环。
    if (this.attemptedGeneration === fallback.generation) return;
    // 读取当前物理 fallback 的 rtcId；API/crypto 缺失时不会生成信令。
    const rtcId = this.rtcIdProvider();
    if (!rtcId) return;
    this.attemptedGeneration = fallback.generation;
    void this.runRtcAttempt(rtcId);
  }

  private async runRtcAttempt(currentRtcId: string): Promise<void> {
    const peerFactory = this.peerFactory;
    const socketFactory = this.dataChannelSocketFactory;
    if (!peerFactory || !socketFactory) return;

    const session: RtcSession = {
      id: (this.nextSessionId += 1),
      ready: false,
      tearingDown: false,
      answerReceived: false,
      channelOpened: false,
      peer: null,
      signal: null,
      channel: null,
      socket: null,
      protocol: null,
      client: null,
      services: null,
      timers: new Set(),
      aborts: new Set(),
      signalMessageHandler: null,
      signalCloseHandler: null,
      signalErrorHandler: null,
      channelListeners: [],
      rpcInitialized: false,
      rpcInitializePromise: Promise.resolve(),
      resolveRpcInitialize: null,
    };
    // 必须先建立 Initialize 等待器：对端可能在 DataChannel open 的同一轮事件里
    // 就发出 Initialize，晚注册会永久错过。
    session.rpcInitializePromise = new Promise<void>((resolve) => {
      session.resolveRpcInitialize = resolve;
    });
    this.rtc = session;
    session.timers.add(
      this.schedule(
        () => this.failRtc(session, "RTC negotiation timed out"),
        this.negotiationTimeoutMs,
      ),
    );

    try {
      const signal = this.signalFactory(buildSignalUrl(this.wsUrl, currentRtcId));
      // 信令 socket 在同一受保护端点上收发二进制帧。浏览器 WebSocket 默认把
      // 二进制消息包装成 Blob，而信令解析是同步的；不指定 arraybuffer 会丢掉
      // 所有 answer/error，导致 RTC 永远无法升级。必须在建连后立即设置。
      signal.binaryType = "arraybuffer";
      session.signal = signal;
      await this.guard(session, this.waitForSignalOpen(session, signal));
      if (!this.isCurrent(session)) return;

      session.signalMessageHandler = (event) => this.handleSignalMessage(session, event);
      session.signalCloseHandler = () => this.failRtc(session, "RTC signaling closed");
      session.signalErrorHandler = () => this.failRtc(session, "RTC signaling error");
      signal.addEventListener("message", session.signalMessageHandler);
      signal.addEventListener("close", session.signalCloseHandler);
      signal.addEventListener("error", session.signalErrorHandler);

      await this.negotiate(session, peerFactory, socketFactory);
    } catch (error) {
      if (this.rtc === session) {
        this.failRtc(session, error instanceof Error ? error.message : "RTC negotiation failed");
      }
    }
  }

  private waitForSignalOpen(session: RtcSession, signal: WebSocket): Promise<void> {
    if (signal.readyState === WEBSOCKET_OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      function cleanup(): void {
        signal.removeEventListener("open", onOpen);
        signal.removeEventListener("error", onError);
        signal.removeEventListener("close", onClose);
        session.aborts.delete(abort);
      }
      // teardown 会通过 session.aborts 取消等待；即使底层 socket 不再触发
      // close（fake/超时实现常见），也必须注销三个监听器。
      function abort(): void {
        if (settled) return;
        settled = true;
        cleanup();
      }
      function settle(finish: () => void): void {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      }
      function onOpen(): void {
        settle(resolve);
      }
      function onError(): void {
        settle(() => reject(createConnectionError("RTC signaling failed to open")));
      }
      function onClose(): void {
        settle(() => reject(createConnectionError("RTC signaling closed before open")));
      }
      session.aborts.add(abort);
      // 不使用 {once}：abort 路径必须能用同一个函数引用注销监听。
      signal.addEventListener("open", onOpen);
      signal.addEventListener("error", onError);
      signal.addEventListener("close", onClose);
    });
  }

  private async negotiate(
    session: RtcSession,
    peerFactory: RtcPeerConnectionFactory,
    socketFactory: RtcDataChannelSocketFactory,
  ): Promise<void> {
    const peer = peerFactory({ iceServers: [] });
    session.peer = peer;
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.failRtc(session, `RTC peer ${state}`);
      }
    };

    const channel = peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    session.channel = channel;
    // 可靠、有序、二进制；不设置 maxRetransmits / maxPacketLifeTime。
    // binaryType 与高低水位分别由传输桥和 rpc 适配器持有，这里不重复设置。

    const channelOpen = new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        if (session.tearingDown) return;
        session.channelOpened = true;
        resolve();
      };
      const onClose = (): void => {
        if (!session.channelOpened && !session.tearingDown) {
          reject(createConnectionError("RTC data channel closed before open"));
        }
        this.failRtc(session, "RTC data channel closed");
      };
      const onError = (): void => {
        if (!session.channelOpened && !session.tearingDown) {
          reject(createConnectionError("RTC data channel error"));
        }
        this.failRtc(session, "RTC data channel error");
      };
      session.channelListeners.push(["open", onOpen], ["close", onClose], ["error", onError]);
      channel.addEventListener("open", onOpen);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onError);
      if (channel.readyState === "open") onOpen();
    });

    // 先建好 SocketProtocol/ChannelClient，确保 DataChannel open 后不会丢掉
    // 对端立即发送的 Initialize 响应；但只有 Initialize 到达后才发布 services。
    this.prepareRpcClient(session, channel, socketFactory);

    const offer = await this.guard(session, peer.createOffer());
    if (!this.isCurrent(session)) return;
    await this.guard(session, peer.setLocalDescription({ type: "offer", sdp: offer.sdp }));
    if (!this.isCurrent(session)) return;
    await this.guard(session, this.waitForIceGathering(peer));
    if (!this.isCurrent(session)) return;

    const sdp = peer.localDescription?.sdp ?? offer.sdp ?? "";
    if (!sdp) throw createConnectionError("RTC offer has no SDP");
    this.sendSignal(session, { version: WEB_RTC_SIGNAL_VERSION, type: "offer", sdp });

    await this.guard(session, channelOpen);
    if (!this.isCurrent(session)) return;
    await this.guard(session, this.waitForRpcInitialize(session));
    if (!this.isCurrent(session)) return;

    session.ready = true;
    this.clearSessionTimers(session);
    // 清除协商/初始化计时器后启动心跳；心跳计时器同样归 session.timers 管理。
    this.startHeartbeat(session);
    this.publishComposed();
  }

  /**
   * RTC ready 后周期性发送 ping，避免保护隧道因信令长时间空闲而回收连接。
   * 计时器随 session 回收；send 失败说明信令已经不可用，必须立即回退 WSS。
   */
  private startHeartbeat(session: RtcSession): void {
    const scheduleTick = (): void => {
      const timer = this.schedule(() => {
        // 先移除已触发计时器，避免 session.timers 随运行时间无限增长。
        session.timers.delete(timer);
        if (!this.isCurrent(session) || !session.ready) return;
        try {
          this.sendSignal(session, { version: WEB_RTC_SIGNAL_VERSION, type: "ping" });
        } catch (error) {
          this.failRtc(
            session,
            error instanceof Error ? error.message : "RTC signaling heartbeat failed",
          );
          return;
        }
        scheduleTick();
      }, this.signalingHeartbeatMs);
      session.timers.add(timer);
    };
    scheduleTick();
  }

  private waitForIceGathering(peer: RtcPeerConnectionLike): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") resolve();
      };
    });
  }

  private prepareRpcClient(
    session: RtcSession,
    channel: RtcDataChannelLike,
    socketFactory: RtcDataChannelSocketFactory,
  ): void {
    const transport = createDataChannelTransport(channel);
    const socket = socketFactory(transport);
    const protocol = new SocketProtocol(socket, {
      onSent: (bytes) => {
        if (this.disposed) return;
        this.rtcTraffic.sentBytes += bytes;
        this.scheduleTrafficPublish();
      },
      onReceived: (bytes) => {
        if (this.disposed) return;
        this.rtcTraffic.receivedBytes += bytes;
        this.scheduleTrafficPublish();
      },
    });
    const client = new ChannelClient(protocol);
    const initializeListener = client.onDidInitialize(() => {
      session.rpcInitialized = true;
      initializeListener.dispose();
      session.resolveRpcInitialize?.();
    });
    const services = new RemoteServiceAccess(client, {
      cliProxyQuota: this.options.cliProxyQuota === true,
    });
    session.socket = socket;
    session.protocol = protocol;
    session.client = client;
    session.services = services;
  }

  private waitForRpcInitialize(session: RtcSession): Promise<void> {
    if (session.rpcInitialized) return Promise.resolve();
    if (!session.client) {
      return Promise.reject(createConnectionError("RTC RPC client is missing"));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          this.cancel(timer);
          session.timers.delete(timer);
        }
        resolve();
      };
      if (session.rpcInitialized) {
        finish();
        return;
      }
      void session.rpcInitializePromise.then(finish);
      timer = this.schedule(() => {
        if (settled) return;
        settled = true;
        if (timer !== null) session.timers.delete(timer);
        reject(createConnectionError("RTC RPC initialization timed out"));
      }, this.initializeTimeoutMs);
      session.timers.add(timer);
    });
  }

  private sendSignal(
    session: RtcSession,
    signal: Extract<WebRtcSignal, { type: "offer" | "ping" }>,
  ): void {
    const socket = session.signal;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
      throw createConnectionError("RTC signaling socket is not open");
    }
    socket.send(JSON.stringify(signal));
  }

  private handleSignalMessage(session: RtcSession, event: unknown): void {
    if (!this.isCurrent(session)) return;
    const text = readSignalText(event);
    if (text === null) {
      this.failRtc(session, "RTC signaling payload is not text");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.failRtc(session, "RTC signaling payload is not JSON");
      return;
    }
    const result = webRtcSignalSchema.safeParse(parsed);
    if (!result.success) {
      // 浏览器只接受一次 answer；error/异常信令立即回退，不把底层信息写入日志。
      this.failRtc(session, "RTC signaling rejected");
      return;
    }
    const signal = result.data;
    if (signal.type === "ping" || signal.type === "pong") {
      if (signal.type === "ping") {
        // 客户端是心跳发起方，服务端不应主动 ping。
        this.failRtc(session, "RTC signaling received unexpected ping");
        return;
      }
      if (!session.ready) {
        this.failRtc(session, "RTC signaling received pong before ready");
        return;
      }
      // 有效 pong 只证明信令仍存活，不参与 answer 状态，也不发布新 generation。
      return;
    }
    if (signal.type !== "answer") {
      this.failRtc(session, "RTC signaling rejected");
      return;
    }
    if (session.answerReceived) {
      this.failRtc(session, "RTC signaling received duplicate answer");
      return;
    }
    session.answerReceived = true;
    const peer = session.peer;
    if (!peer) {
      this.failRtc(session, "RTC peer is missing");
      return;
    }
    void peer.setRemoteDescription({ type: "answer", sdp: signal.sdp }).then(
      () => undefined,
      () => this.failRtc(session, "RTC answer could not be applied"),
    );
  }

  private guard<T>(session: RtcSession, promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      session.aborts.add(abort);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          session.aborts.delete(abort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          session.aborts.delete(abort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private isCurrent(session: RtcSession): boolean {
    return !this.disposed && this.rtc === session && !session.tearingDown;
  }

  private failRtc(session: RtcSession, message: string): void {
    if (this.rtc !== session) return;
    this.rtc = null;
    this.teardownSession(session, createConnectionError(message));
    // RTC 失败后立即发布仍然存活的 fallback services；同一代不再重试。
    this.publishComposed();
  }

  private teardownCurrentRtc(): void {
    const session = this.rtc;
    if (!session) return;
    this.rtc = null;
    this.teardownSession(session, createConnectionError("RTC session superseded"));
  }

  private teardownSession(session: RtcSession, error: Error): void {
    if (session.tearingDown) return;
    session.tearingDown = true;
    for (const abort of session.aborts) abort(error);
    session.aborts.clear();
    this.clearSessionTimers(session);

    const signal = session.signal;
    if (signal) {
      if (session.signalMessageHandler) {
        signal.removeEventListener("message", session.signalMessageHandler);
      }
      if (session.signalCloseHandler) {
        signal.removeEventListener("close", session.signalCloseHandler);
      }
      if (session.signalErrorHandler) {
        signal.removeEventListener("error", session.signalErrorHandler);
      }
      closeWebSocket(signal);
    }

    const peer = session.peer;
    if (peer) {
      // 断开 peer 的事件处理器，避免迟到事件把已回收的 session 重新拉起来。
      peer.onconnectionstatechange = null;
      peer.onicegatheringstatechange = null;
    }

    for (const [type, listener] of session.channelListeners) {
      session.channel?.removeEventListener?.(type, listener);
    }
    session.channelListeners.length = 0;

    try {
      session.client?.dispose(error);
    } catch {
      // dispose 失败不能阻断后续资源回收。
    }
    try {
      session.protocol?.dispose();
    } catch {
      // 同上。
    }
    try {
      session.socket?.dispose();
    } catch {
      // 同上。
    }
    try {
      session.channel?.close();
    } catch {
      // 同上。
    }
    try {
      session.peer?.close();
    } catch {
      // 同上。
    }

    session.services = null;
    session.client = null;
    session.protocol = null;
    session.socket = null;
    session.channel = null;
    session.peer = null;
    session.signal = null;
    session.resolveRpcInitialize = null;
  }

  private clearSessionTimers(session: RtcSession): void {
    for (const timer of session.timers) this.cancel(timer);
    session.timers.clear();
  }
}

/**
 * 机会性直连入口：先等待现有 managed fallback WebSocket ready 并返回，再在后台
 * 为当前 fallback 代尝试一次 WebRTC。失败、超时或关闭都不会影响 fallback 业务。
 */
export async function connectViaWebRtcManaged(
  wsUrl: string,
  options: WebRtcConnectionOptions = {},
): Promise<WebSocketConnection> {
  const peerFactory = resolvePeerConnectionFactory(options);
  // 生产路径直接使用 rpc 已公开的 DataChannel 适配；测试可注入桥接实现。
  const dataChannelSocketFactory = options.dataChannelSocketFactory ?? createDataChannelSocket;
  const signalFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  const canUseRtc = peerFactory !== null && hasWebRtcSignaling(options);
  const rtcIds = canUseRtc ? createFallbackRtcIdTracker(options, signalFactory) : null;

  // 没有能力时不包装 fallback 工厂，也不追加任何 rtcId。
  const fallbackOptions = rtcIds
    ? { ...options, webSocketFactory: rtcIds.webSocketFactory }
    : options;
  const fallback = await connectViaWebSocketManaged(wsUrl, fallbackOptions);
  const connection = new OpportunityWebRtcConnection(
    fallback,
    wsUrl,
    rtcIds ? rtcIds.currentRtcId : null,
    canUseRtc ? peerFactory : null,
    canUseRtc ? dataChannelSocketFactory : null,
    signalFactory,
    options,
  );
  return connection.start();
}

interface FallbackRtcIdTracker {
  /** 每条物理 fallback 连接都会生成新的临时 rtcId 并追加到 URL。 */
  readonly webSocketFactory: WebSocketFactory;
  /** 最近一次创建的 fallback 连接对应的 rtcId；缺失时为 null。 */
  currentRtcId(): string | null;
}

/**
 * 按物理 fallback 连接生成 rtcId。
 *
 * managed WebSocket 重连时仍调用同一个工厂，因此不能只在入口生成一次 id：
 * 旧 server 可能尚未感知上一条连接断开，复用同一 id 会被当作重复占用拒绝。
 * 这里包装工厂而不改 managed WebSocket；信令仍使用未经包装的原始工厂。
 */
function createFallbackRtcIdTracker(
  options: WebRtcConnectionOptions,
  baseFactory: WebSocketFactory,
): FallbackRtcIdTracker {
  let current: string | null = null;
  return {
    webSocketFactory(url: string): WebSocket {
      // API/crypto 缺失时不追加 rtcId，该连接保持纯 WSS。
      const rtcId = resolveRtcId(options);
      const socket = baseFactory(rtcId ? withRtcId(url, rtcId) : url);
      current = rtcId;
      return socket;
    },
    currentRtcId: () => current,
  };
}

function hasWebRtcSignaling(options: WebRtcConnectionOptions): boolean {
  return typeof options.webSocketFactory === "function" || typeof WebSocket !== "undefined";
}
