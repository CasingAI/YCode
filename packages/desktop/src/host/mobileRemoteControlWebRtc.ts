/**
 * 手机远控 WebRTC 直连的 Host 侧生命周期控制器。
 *
 * 所有权：
 * - 每条 fallback `/ws?rtcId=...` 在这里登记，只有 Cookie 鉴权通过后才会到这里；
 * - 每条 `/ws/rtc?rtcId=...` 信令连接必须绑定一个仍然存活的 fallback；
 * - 每个 rtcId 最多一次协商、一次 answer，失败后本代 fallback 不再重试；
 * - fallback / 信令 / DataChannel 任一关闭，或 stop/resetToken/suspend/dispose，
 *   都会同步作废 peer；所有异步回调在恢复后重新检查 generation，迟到的结果就地关闭。
 *
 * 这里不持有业务服务与 HTTP 鉴权：DataChannel 成帧后交给 attachment registry，
 * 复用与 WSS 完全相同的 exposeServices 权限裁剪。
 */
import {
  createDataChannelSocket,
  VSBuffer,
  type ISocket,
  type DataChannelTransport,
} from "@zcode/rpc";
import {
  WEB_RTC_SIGNAL_VERSION,
  webRtcIdSchema,
  webRtcSignalSchema,
  type WebRtcSignal,
} from "@zcode/shared";
import {
  WebRtcUnavailableError,
  type WebRtcPeer,
  type WebRtcPeerFactory,
} from "./mobileRemoteControlWebRtcPeer.js";

const DEFAULT_NEGOTIATION_TIMEOUT_MS = 30_000;
const DEFAULT_SIGNALING_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PEERS = 8;
/**
 * 原始信令帧上限。
 *
 * shared schema 已把解码后的 SDP 限制在 256 KiB；JSON 会转义 SDP 里的 CR/LF，
 * 因此原始帧必须留出约 2 倍余量，否则合法 SDP 会在解析前被误拒。
 */
const DEFAULT_MAX_SIGNAL_BYTES = 768 * 1024;

type ErrorCode = Extract<WebRtcSignal, { type: "error" }>["code"];

export interface MobileRemoteWebRtcLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface MobileRemoteWebRtcControllerOptions {
  createPeer: WebRtcPeerFactory;
  /**
   * DataChannel 适配成 ISocket 后交给宿主。
   *
   * 调用方（远控 runtime）应复用 attachment registry，且**不增加** connectedClients：
   * 同一条浏览器的 WSS 与 RTC 是同一逻辑连接。
   */
  attachDataChannel: (socket: ISocket) => void;
  logger?: MobileRemoteWebRtcLogger;
  negotiationTimeoutMs?: number;
  signalingIdleTimeoutMs?: number;
  maxPeers?: number;
  maxSignalBytes?: number;
}

export interface MobileRemoteWebRtcController {
  /**
   * 登记 fallback。
   *
   * 返回 false 时调用方必须断开 socket：rtcId 非法或同 rtcId 已有活跃 fallback。
   * 没有 rtcId 的旧客户端返回 true，但不会创建任何 RTC 状态。
   */
  acceptFallbackConnection(socket: ISocket, url: string): boolean;
  /**
   * 接管 `/ws/rtc` 信令 socket。
   *
   * 非法、未知关联、重复占用与超额都会写入一条 error 信令后关闭 socket；
   * 正常路径只等待一条 offer，回一条 answer。
   */
  acceptSignalingConnection(socket: ISocket, url: string): void;
  /** stop/resetToken/suspend/dispose：作废全部 peer 与信令，但不关闭 fallback socket（attachment registry 负责）。 */
  closeAll(): void;
  readonly fallbackCount: number;
  readonly activePeerCount: number;
}

interface RtcIdLookup {
  present: boolean;
  value?: string;
}

interface FallbackEntry {
  readonly rtcId: string;
  readonly socket: ISocket;
  closeSubscription: { dispose(): void };
  attempted: boolean;
  closed: boolean;
}

interface Session {
  readonly rtcId: string;
  readonly fallback: FallbackEntry;
  readonly signaling: ISocket;
  signalingCloseSubscription: { dispose(): void };
  signalingDataSubscription: { dispose(): void };
  state: "idle" | "negotiating" | "answered" | "closed";
  peer?: WebRtcPeer;
  dataSocket?: ISocket;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

function readRtcId(url: string): RtcIdLookup {
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("/") ? url : `/${url}`, "http://localhost");
  } catch {
    return { present: false };
  }
  const raw = parsed.searchParams.get("rtcId");
  if (raw === null) {
    return { present: false };
  }
  const result = webRtcIdSchema.safeParse(raw);
  return result.success ? { present: true, value: result.data } : { present: true };
}

function clearTimer(session: Session): void {
  if (session.timer !== undefined) {
    clearTimeout(session.timer);
    session.timer = undefined;
  }
}

function sendSignal(socket: ISocket, signal: WebRtcSignal): void {
  try {
    socket.write(VSBuffer.fromString(JSON.stringify(signal)));
  } catch {
    // socket 已关闭；错误路径不能反过来打断生命周期清理。
  }
}

function errorSignal(code: ErrorCode): WebRtcSignal {
  return { version: WEB_RTC_SIGNAL_VERSION, type: "error", code };
}

export function createMobileRemoteWebRtcController(
  options: MobileRemoteWebRtcControllerOptions,
): MobileRemoteWebRtcController {
  const negotiationTimeoutMs = options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
  const signalingIdleTimeoutMs =
    options.signalingIdleTimeoutMs ?? DEFAULT_SIGNALING_IDLE_TIMEOUT_MS;
  const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
  const maxSignalBytes = options.maxSignalBytes ?? DEFAULT_MAX_SIGNAL_BYTES;

  const fallbacks = new Map<string, FallbackEntry>();
  const sessions = new Map<string, Session>();

  const closeSession = (session: Session): void => {
    if (session.closed) return;
    session.closed = true;
    session.state = "closed";
    clearTimer(session);
    if (sessions.get(session.rtcId) === session) {
      sessions.delete(session.rtcId);
    }

    // 先摘掉引用再关闭，避免 peer/socket 的关闭事件递归回到这里。
    const peer = session.peer;
    session.peer = undefined;
    try {
      peer?.close();
    } catch {
      // 关闭失败不影响其余资源回收。
    }

    const dataSocket = session.dataSocket;
    session.dataSocket = undefined;
    try {
      dataSocket?.dispose();
    } catch {
      // registry 可能已经先一步 dispose。
    }

    session.signalingCloseSubscription.dispose();
    session.signalingDataSubscription.dispose();
    try {
      session.signaling.dispose();
    } catch {
      // 已经关闭。
    }
  };

  const failSession = (session: Session, code?: ErrorCode): void => {
    if (session.closed) return;
    if (code) {
      sendSignal(session.signaling, errorSignal(code));
    }
    closeSession(session);
  };

  const handleDataChannel = (session: Session, channel: DataChannelTransport): void => {
    // 只有 answer 已交给浏览器、会话仍有效，才允许升级；迟到回调就地关闭。
    if (session.closed || session.state !== "answered" || session.dataSocket) {
      try {
        channel.close();
      } catch {
        // ignore
      }
      return;
    }
    const socket = createDataChannelSocket(channel);
    session.dataSocket = socket;
    clearTimer(session);
    // DataChannel 断开等价于 RTC 失败：回收 peer 与信令，fallback 继续存活。
    socket.onClose(() => closeSession(session));
    try {
      options.attachDataChannel(socket);
    } catch (error) {
      // 只记录异常类型：底层异常文本可能包含 SDP / token / 地址，不能写入日志。
      options.logger?.warn("mobile remote WebRTC data channel attach failed", {
        rtcId: session.rtcId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      socket.dispose();
      closeSession(session);
    }
  };

  const handleOffer = async (session: Session, offerSdp: string): Promise<void> => {
    session.state = "negotiating";
    clearTimer(session);
    session.timer = setTimeout(
      () => failSession(session, "negotiation-failed"),
      negotiationTimeoutMs,
    );

    let peer: WebRtcPeer;
    try {
      peer = await options.createPeer({
        onDataChannel: (channel) => handleDataChannel(session, channel),
        onFailure: () => {
          // answer 已发出后不再追加 error 帧，浏览器会直接回退 WSS。
          failSession(session, session.state === "negotiating" ? "negotiation-failed" : undefined);
        },
      });
    } catch (error) {
      if (session.closed) return;
      options.logger?.warn("mobile remote WebRTC peer creation failed", {
        rtcId: session.rtcId,
        code: error instanceof WebRtcUnavailableError ? "unavailable" : "negotiation-failed",
      });
      failSession(
        session,
        error instanceof WebRtcUnavailableError ? "unavailable" : "negotiation-failed",
      );
      return;
    }

    if (session.closed) {
      peer.close();
      return;
    }
    session.peer = peer;

    try {
      const answerSdp = await peer.acceptOffer(offerSdp);
      // 等待期间 fallback/信令可能已经关闭；迟到的 answer 绝不能复活会话。
      if (session.closed) return;
      session.state = "answered";
      clearTimer(session);
      // answer 之后还要等 DataChannel 建立；超时同样回收，避免悬挂的 peer。
      session.timer = setTimeout(
        () => failSession(session, "negotiation-failed"),
        negotiationTimeoutMs,
      );
      sendSignal(session.signaling, {
        version: WEB_RTC_SIGNAL_VERSION,
        type: "answer",
        sdp: answerSdp,
      });
    } catch (error) {
      if (session.closed) return;
      options.logger?.warn("mobile remote WebRTC negotiation failed", {
        rtcId: session.rtcId,
        code: error instanceof WebRtcUnavailableError ? "unavailable" : "negotiation-failed",
      });
      failSession(session, "negotiation-failed");
    }
  };

  const handleSignalData = (session: Session, data: VSBuffer): void => {
    if (session.closed) return;
    if (data.byteLength > maxSignalBytes) {
      failSession(session, "invalid-signal");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      failSession(session, "invalid-signal");
      return;
    }
    const parsed = webRtcSignalSchema.safeParse(payload);
    if (!parsed.success) {
      // strict schema：任何多余字段、未知 type 或非法版本都直接拒绝，不能宽松忽略。
      failSession(session, "invalid-signal");
      return;
    }
    if (parsed.data.type === "ping") {
      // 只允许 RTC 真正 ready（answer 已发且 DataChannel 已接入）的会话保活。
      // 协商阶段的 ping 仍按非法信令处理；ping 只回 pong，不消耗直连尝试、不碰 RPC。
      if (session.state !== "answered" || !session.dataSocket) {
        failSession(session, "invalid-signal");
        return;
      }
      sendSignal(session.signaling, { version: WEB_RTC_SIGNAL_VERSION, type: "pong" });
      return;
    }
    if (parsed.data.type !== "offer") {
      // answer/error/pong 都是 Host 发出或仅由 Host 处理的方向，客户端发送即非法。
      failSession(session, "invalid-signal");
      return;
    }
    if (session.state !== "idle") {
      // 同一连接重复 offer（或 answer 之后再发）统一按占用中拒绝。
      failSession(session, "busy");
      return;
    }
    void handleOffer(session, parsed.data.sdp);
  };

  const acceptFallbackConnection = (socket: ISocket, url: string): boolean => {
    const lookup = readRtcId(url);
    if (!lookup.present) {
      // 旧客户端没有 rtcId：保持原 WSS 行为，不创建 RTC 状态。
      return true;
    }
    if (!lookup.value) {
      return false;
    }
    const rtcId = lookup.value;
    if (fallbacks.has(rtcId)) {
      // 重复 fallback 不能顶掉现有绑定，否则旧页面会被新连接劫持。
      return false;
    }

    const entry: FallbackEntry = {
      rtcId,
      socket,
      closeSubscription: { dispose() {} },
      attempted: false,
      closed: false,
    };
    entry.closeSubscription = socket.onClose(() => {
      if (entry.closed) return;
      entry.closed = true;
      // 关闭事件已经触发，主动释放这条订阅，避免 retained fallback socket 继续持有控制器。
      entry.closeSubscription.dispose();
      if (fallbacks.get(rtcId) === entry) {
        fallbacks.delete(rtcId);
      }
      const session = sessions.get(rtcId);
      if (session && session.fallback === entry) {
        closeSession(session);
      }
    });
    fallbacks.set(rtcId, entry);
    return true;
  };

  const acceptSignalingConnection = (socket: ISocket, url: string): void => {
    const lookup = readRtcId(url);
    if (!lookup.value) {
      sendSignal(socket, errorSignal("invalid-signal"));
      socket.dispose();
      return;
    }
    const rtcId = lookup.value;
    const fallback = fallbacks.get(rtcId);
    if (!fallback || fallback.closed) {
      sendSignal(socket, errorSignal("unavailable"));
      socket.dispose();
      return;
    }
    // 一个 fallback generation 只允许一次直连尝试：失败后必须等 fallback 换代（新 rtcId）。
    if (fallback.attempted || sessions.has(rtcId)) {
      sendSignal(socket, errorSignal("busy"));
      socket.dispose();
      return;
    }
    if (sessions.size >= maxPeers) {
      sendSignal(socket, errorSignal("busy"));
      socket.dispose();
      return;
    }

    fallback.attempted = true;
    const session: Session = {
      rtcId,
      fallback,
      signaling: socket,
      signalingCloseSubscription: { dispose() {} },
      signalingDataSubscription: { dispose() {} },
      state: "idle",
      closed: false,
    };
    session.signalingCloseSubscription = socket.onClose(() => closeSession(session));
    session.signalingDataSubscription = socket.onData((data) => handleSignalData(session, data));
    sessions.set(rtcId, session);
    session.timer = setTimeout(
      () => failSession(session, "negotiation-failed"),
      signalingIdleTimeoutMs,
    );
  };

  const closeAll = (): void => {
    for (const session of Array.from(sessions.values())) {
      closeSession(session);
    }
    sessions.clear();
    for (const entry of Array.from(fallbacks.values())) {
      entry.closed = true;
      entry.closeSubscription.dispose();
    }
    fallbacks.clear();
  };

  return {
    acceptFallbackConnection,
    acceptSignalingConnection,
    closeAll,
    get fallbackCount() {
      return fallbacks.size;
    },
    get activePeerCount() {
      return sessions.size;
    },
  };
}
