/**
 * Node 侧 WebRTC peer —— 生产实现。
 *
 * werift 是纯 TypeScript 实现，因此 Host 不需要 native addon；但依赖体积不小，
 * 只有真的收到信令 offer 时才懒加载。加载失败只表现为一条 error 信令，
 * 原有 WebSocket fallback 完全不受影响。
 */
import { Emitter, type DataChannelTransport } from "@zcode/rpc";

/** 协商期间等待 ICE 收集完成的上限；没有 STUN/TURN 时应远快于此。 */
const ICE_GATHERING_TIMEOUT_MS = 15_000;

/**
 * 浏览器端唯一合法的 RPC 通道。
 *
 * 只接受可靠、有序、无部分重传/生存期限制且子协议为空的二进制通道。
 * 客户端若能发任意 DataChannel，必须在这里拒绝，不能把不可靠流交给 SocketProtocol。
 */
const RPC_DATA_CHANNEL_LABEL = "zcode-rpc";

function isReliableOrderedRpcChannel(channel: import("werift").RTCDataChannel): boolean {
  return (
    channel.label === RPC_DATA_CHANNEL_LABEL &&
    channel.protocol === "" &&
    channel.ordered === true &&
    channel.maxRetransmits === null &&
    channel.maxPacketLifeTime === null
  );
}

export interface WebRtcPeerCallbacks {
  /** 对端创建并打开 DataChannel 后回调；此刻可以开始跑 RPC 帧。 */
  onDataChannel(channel: DataChannelTransport): void;
  /** 连接失败/底层关闭；控制器负责回收关联的信令与 socket。 */
  onFailure(error: Error): void;
}

export interface WebRtcPeer {
  /** 应用一次完整 offer，返回已收集完全部本地 ICE candidate 的 answer SDP。 */
  acceptOffer(offerSdp: string): Promise<string>;
  /** 幂等关闭；关闭后任何迟到事件都不再回调。 */
  close(): void;
}

export type WebRtcPeerFactory = (callbacks: WebRtcPeerCallbacks) => Promise<WebRtcPeer>;

/** werift 无法加载（未安装、平台不兼容、native 依赖缺失）时抛出，用于回 `unavailable`。 */
export class WebRtcUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebRtcUnavailableError";
  }
}

interface WeriftModule {
  RTCPeerConnection: typeof import("werift").RTCPeerConnection;
}

export interface WeriftPeerFactoryOptions {
  /** 测试注入；生产不传，走动态 import，避免 Host 启动时加载整棵 WebRTC 依赖。 */
  loadWerift?: () => Promise<WeriftModule>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNodeBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * 把 werift 的 DataChannel 适配成 @zcode/rpc 的小结构接口。
 *
 * 消息统一成 Uint8Array；字符串消息（非本协议正常路径）按 UTF-8 编码，
 * 不把文本帧误当成可解析的业务帧。
 */
function adaptDataChannel(channel: import("werift").RTCDataChannel): {
  transport: DataChannelTransport;
  dispose: () => void;
} {
  const onMessage = new Emitter<Uint8Array>();
  const onClose = new Emitter<void>();
  const onError = new Emitter<void>();
  const onBufferedAmountLow = new Emitter<void>();
  let closed = false;

  const closeState = channel.stateChange.subscribe((state) => {
    if (state !== "closed" || closed) return;
    closed = true;
    onClose.fire();
  });
  const errorState = channel.error.subscribe(() => {
    if (closed) return;
    onError.fire();
  });
  const messageState = channel.onMessage.subscribe((data) => {
    if (closed) return;
    if (typeof data === "string") {
      // 协议只接受二进制帧。把文本按 UTF-8 塞进 SocketProtocol 会被误当成帧头，
      // 无法安全解析；直接以传输错误拒绝，让上层关闭并回退 WSS。
      onError.fire();
      return;
    }
    onMessage.fire(new Uint8Array(data));
  });
  const bufferedState = channel.bufferedAmountLow.subscribe(() => {
    if (closed) return;
    onBufferedAmountLow.fire();
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    closeState.unSubscribe();
    errorState.unSubscribe();
    messageState.unSubscribe();
    bufferedState.unSubscribe();
    onMessage.dispose();
    onClose.dispose();
    onError.dispose();
    onBufferedAmountLow.dispose();
  };

  return {
    transport: {
      get readyState() {
        return channel.readyState;
      },
      get bufferedAmount() {
        return channel.bufferedAmount;
      },
      get bufferedAmountLowThreshold() {
        return channel.bufferedAmountLowThreshold;
      },
      set bufferedAmountLowThreshold(value: number) {
        channel.bufferedAmountLowThreshold = value;
      },
      send(data: Uint8Array) {
        channel.send(toNodeBuffer(data));
      },
      close() {
        if (channel.readyState !== "closed") {
          channel.close();
        }
      },
      onMessage: onMessage.event,
      onClose: onClose.event,
      onError: onError.event,
      onBufferedAmountLow: onBufferedAmountLow.event,
    },
    dispose,
  };
}

export function createWeriftPeerFactory(options: WeriftPeerFactoryOptions = {}): WebRtcPeerFactory {
  const loadWerift =
    options.loadWerift ?? (() => import("werift") as unknown as Promise<WeriftModule>);

  return async (callbacks) => {
    let werift: WeriftModule;
    try {
      werift = await loadWerift();
    } catch (error) {
      throw new WebRtcUnavailableError("WebRTC 运行时不可用", { cause: error });
    }

    const pc = new werift.RTCPeerConnection({
      // 明确不使用任何外部 STUN/TURN；直连失败就回退 WSS。
      iceServers: [],
      iceUseIpv6: false,
    });
    let closed = false;
    const cleanups: Array<() => void> = [];
    const channelDisposers = new Set<() => void>();

    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      for (const dispose of Array.from(channelDisposers)) {
        dispose();
      }
      channelDisposers.clear();
      void pc.close().catch(() => undefined);
    };

    const connectionSub = pc.connectionStateChange.subscribe((state) => {
      if (closed) return;
      if (state === "failed" || state === "closed") {
        callbacks.onFailure(new Error(`WebRTC connection ${state}`));
        close();
      }
    });
    cleanups.push(() => connectionSub.unSubscribe());

    let mainChannelSeen = false;
    /**
     * 关闭被拒绝的通道。
     *
     * werift 在 DataChannel 尚未收到 ACK 时直接 close 会把通道从内部表移除，
     * 之后的 DATA_CHANNEL_ACK 会抛 "channel not found" 并波及整条连接。
     * 因此 connecting 状态先等待 open/closed，再安全关闭。
     */
    const rejectDataChannel = (channel: import("werift").RTCDataChannel): void => {
      if (channel.readyState === "closed") return;
      // 放到下一轮事件循环再 close：werift 先要完成 DCEP ACK 的发送，
      // 否则 RECONFIG（关闭）可能先到对端，对端再收到 ACK 时会抛 "channel not found"
      // 并波及整条连接。延后关闭也能保证不会打断合法主通道。
      const closeLater = (): void => {
        const timer = setTimeout(() => {
          if (channel.readyState === "closed") return;
          try {
            channel.close();
          } catch {
            // 已经关闭。
          }
        }, 0);
        timer.unref?.();
        cleanups.push(() => clearTimeout(timer));
      };
      if (channel.readyState === "open") {
        closeLater();
        return;
      }
      const stateSub = channel.stateChange.subscribe((state) => {
        if (state === "open") {
          stateSub.unSubscribe();
          closeLater();
        } else if (state === "closed") {
          stateSub.unSubscribe();
        }
      });
      cleanups.push(() => stateSub.unSubscribe());
    };

    const channelSub = pc.onDataChannel.subscribe((channel) => {
      if (closed) {
        rejectDataChannel(channel);
        return;
      }
      // 只接受唯一一条可靠有序的 zcode-rpc 通道。额外通道（任意 label/protocol/
      // 部分可靠）就地关闭，不注册回调，也不触发 onFailure——否则恶意追加的
      // 通道可以借关闭事件把合法主通道一起带挂。
      if (mainChannelSeen || !isReliableOrderedRpcChannel(channel)) {
        rejectDataChannel(channel);
        return;
      }
      mainChannelSeen = true;
      const deliver = (): void => {
        if (closed) {
          channel.close();
          return;
        }
        const adapted = adaptDataChannel(channel);
        channelDisposers.add(adapted.dispose);
        callbacks.onDataChannel(adapted.transport);
      };
      if (channel.readyState === "open") {
        deliver();
        return;
      }
      const stateSub = channel.stateChange.subscribe((state) => {
        if (state === "open") {
          stateSub.unSubscribe();
          deliver();
        } else if (state === "closed") {
          stateSub.unSubscribe();
        }
      });
      cleanups.push(() => stateSub.unSubscribe());
    });
    cleanups.push(() => channelSub.unSubscribe());

    const waitForIceGathering = async (): Promise<void> => {
      const deadline = Date.now() + ICE_GATHERING_TIMEOUT_MS;
      while (!closed) {
        if (pc.iceGatheringState === "complete") return;
        if (Date.now() > deadline) {
          throw new Error("WebRTC ICE gathering timed out");
        }
        await delay(5);
      }
      throw new Error("WebRTC peer closed");
    };

    return {
      async acceptOffer(offerSdp: string) {
        if (closed) throw new Error("WebRTC peer is closed");
        await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering();
        if (closed) throw new Error("WebRTC peer is closed");
        const local = pc.localDescription;
        if (!local?.sdp) {
          throw new Error("WebRTC local description missing");
        }
        return local.sdp;
      },
      close,
    };
  };
}
