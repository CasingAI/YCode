import { Emitter, type DataChannelTransport } from "@zcode/rpc";

/**
 * 浏览器 RTCDataChannel 的最小结构接口。
 *
 * 浏览器 DOM 的 RTCDataChannel 在结构上满足它；测试也可以注入可控实现。
 * 这里只声明本实现使用到的字段，client 的 peer 抽象同样保持结构化，避免依赖
 * 全局 DOM 类型来驱动传输。
 */
export interface RtcDataChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

function toBinary(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * 把浏览器 DataChannel 的 DOM 事件转换成 rpc 适配器使用的 Event 接口。
 * 分片、有限队列与背压由 `@zcode/rpc` 的 `createDataChannelSocket` 负责，
 * 这里只做事件桥接，不重复实现传输语义。
 */
export function createDataChannelTransport(channel: RtcDataChannelLike): DataChannelTransport {
  const onMessage = new Emitter<Uint8Array>();
  const onClose = new Emitter<void>();
  const onError = new Emitter<void>();
  const onBufferedAmountLow = new Emitter<void>();
  let ended = false;

  // 二进制可靠有序通道，避免浏览器把 message 事件包装成 Blob。
  channel.binaryType = "arraybuffer";

  function detach(): void {
    // close 时四个 DOM listener 都要显式摘除；只 dispose Emitter 会让已关闭
    // 通道仍持有回调，直到通道对象本身被回收。
    channel.removeEventListener?.("message", handleMessage);
    channel.removeEventListener?.("close", handleClose);
    channel.removeEventListener?.("error", handleError);
    channel.removeEventListener?.("bufferedamountlow", handleBufferedAmountLow);
  }

  function disposeEmitters(): void {
    onMessage.dispose();
    onClose.dispose();
    onError.dispose();
    onBufferedAmountLow.dispose();
  }

  function handleMessage(event: unknown): void {
    if (ended) return;
    const bytes = toBinary((event as { data?: unknown } | null)?.data);
    if (!bytes) {
      // 文本/Blob 或未知载荷无法进入 SocketProtocol 帧流。静默丢弃会让后续
      // 帧错位，因此必须报错并关闭通道，由上层回退 WSS。
      ended = true;
      onError.fire();
      detach();
      disposeEmitters();
      try {
        channel.close();
      } catch {
        // 关闭失败不影响已进入的错误/关闭状态。
      }
      return;
    }
    onMessage.fire(bytes);
  }

  function handleClose(): void {
    if (ended) return;
    ended = true;
    onClose.fire();
    detach();
    disposeEmitters();
  }

  function handleError(): void {
    if (ended) return;
    onError.fire();
  }

  function handleBufferedAmountLow(): void {
    if (!ended) onBufferedAmountLow.fire();
  }

  channel.addEventListener("message", handleMessage);
  channel.addEventListener("close", handleClose);
  channel.addEventListener("error", handleError);
  channel.addEventListener("bufferedamountlow", handleBufferedAmountLow);

  return {
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
      channel.send(data);
    },
    close() {
      channel.close();
    },
    onMessage: onMessage.event,
    onClose: onClose.event,
    onError: onError.event,
    onBufferedAmountLow: onBufferedAmountLow.event,
  };
}
