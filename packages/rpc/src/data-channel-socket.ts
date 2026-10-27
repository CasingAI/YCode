import { VSBuffer } from "./buffer.js";
import { DisposableStore, Emitter, type Event } from "./foundation.js";
import type { ISocket } from "./protocol.js";

/**
 * WebRTC DataChannel 的最小结构接口。
 *
 * 浏览器 RTCDataChannel 与 Node 实现（如 werift）都能直接满足该形状；
 * 适配层不依赖 DOM、werift 或任何业务类型，只按可靠有序的二进制消息收发。
 */
export interface DataChannelTransport {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: Uint8Array): void;
  close(): void;
  readonly onMessage: Event<Uint8Array>;
  readonly onClose: Event<void>;
  readonly onError: Event<void>;
  readonly onBufferedAmountLow: Event<void>;
}

export interface DataChannelSocketOptions {
  /** 单条 DataChannel 消息的最大字节数，默认 16 KiB。 */
  readonly chunkSize?: number;
  /** 通道 bufferedAmount 达到该值时暂停发送；本地队列由 maxQueuedBytes 约束，默认 256 KiB。 */
  readonly highWaterMark?: number;
  /** bufferedAmount 回落到该值以下时恢复发送并用于 drain，默认 64 KiB。 */
  readonly lowWaterMark?: number;
  /** 本地待发送队列上限，超过即失败关闭，默认 16 MiB。 */
  readonly maxQueuedBytes?: number;
}

const DEFAULT_CHUNK_SIZE = 16 * 1024;
const DEFAULT_HIGH_WATER_MARK = 256 * 1024;
const DEFAULT_LOW_WATER_MARK = 64 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

interface QueuedFrame {
  readonly data: Uint8Array;
  offset: number;
}

interface DrainWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function createCloseError(message: string): Error {
  const error = new Error(message);
  error.name = "DataChannelClosed";
  return error;
}

function requireSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正整数`);
  }
}

/**
 * 把可靠有序的 DataChannel 适配成 ISocket。
 *
 * 完整性约束：
 * - write() 的字节立即复制，调用方后续修改原 Uint8Array 不会污染待发数据；
 * - 发送按固定大小分片，接收端沿用 SocketProtocol 的分片重组；
 * - 队列溢出、send 抛错、通道未 open 都失败关闭，不会静默丢帧后继续；
 * - drain 只在本地队列清空且 bufferedAmount 回落到低位时完成，关闭时拒绝。
 */
class DataChannelSocket implements ISocket {
  private readonly onDataEmitter = new Emitter<VSBuffer>();
  private readonly onCloseEmitter = new Emitter<void>();
  private readonly onEndEmitter = new Emitter<void>();

  readonly onData = this.onDataEmitter.event;
  readonly onClose = this.onCloseEmitter.event;
  readonly onEnd = this.onEndEmitter.event;

  private readonly chunkSize: number;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly maxQueuedBytes: number;
  private readonly subscriptions = new DisposableStore();
  private readonly queue: QueuedFrame[] = [];
  private drainWaiters: DrainWaiter[] = [];

  private queuedBytes = 0;
  private paused = false;
  private closed = false;
  private closeError: Error | null = null;

  constructor(
    private readonly channel: DataChannelTransport,
    options: DataChannelSocketOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.lowWaterMark = options.lowWaterMark ?? DEFAULT_LOW_WATER_MARK;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;

    requireSafeInteger(this.chunkSize, "chunkSize");
    requireSafeInteger(this.highWaterMark, "highWaterMark");
    requireSafeInteger(this.maxQueuedBytes, "maxQueuedBytes");
    if (!Number.isSafeInteger(this.lowWaterMark) || this.lowWaterMark < 0) {
      throw new RangeError("lowWaterMark 必须是非负整数");
    }
    if (this.lowWaterMark > this.highWaterMark) {
      throw new RangeError("lowWaterMark 不能大于 highWaterMark");
    }

    // 低位事件由实现按阈值触发；阈值必须与 drain 的完成条件保持一致。
    channel.bufferedAmountLowThreshold = this.lowWaterMark;

    this.subscriptions.add(channel.onMessage((data) => this.handleMessage(data)));
    this.subscriptions.add(
      channel.onClose(() => this.shutdown(false, createCloseError("DataChannel closed by remote"))),
    );
    this.subscriptions.add(
      channel.onError(() => this.shutdown(false, createCloseError("DataChannel transport error"))),
    );
    this.subscriptions.add(channel.onBufferedAmountLow(() => this.handleBufferedAmountLow()));
  }

  write(buffer: VSBuffer): void {
    this.assertWritable();

    const raw = buffer.buffer;
    // 必须在入队时复制：调用方可能复用同一 Uint8Array 继续写入。
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    if (copy.byteLength === 0) {
      return;
    }

    if (this.queuedBytes + copy.byteLength > this.maxQueuedBytes) {
      const error = new Error(
        `DataChannel socket queue overflow: ${this.queuedBytes + copy.byteLength} > ${this.maxQueuedBytes}`,
      );
      this.fail(error);
      throw error;
    }

    this.queue.push({ data: copy, offset: 0 });
    this.queuedBytes += copy.byteLength;
    this.pump();
  }

  end(): void {
    this.shutdown(true, createCloseError("DataChannel socket ended"));
  }

  drain(): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? createCloseError("DataChannel socket is closed"));
    }
    if (this.isDrained()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.drainWaiters.push({ resolve, reject });
    });
  }

  dispose(): void {
    this.shutdown(true, createCloseError("DataChannel socket disposed"));
    this.onDataEmitter.dispose();
    this.onCloseEmitter.dispose();
    this.onEndEmitter.dispose();
  }

  private assertWritable(): void {
    if (this.closed) {
      throw this.closeError ?? createCloseError("DataChannel socket is closed");
    }
    if (this.channel.readyState !== "open") {
      const error = new Error(`DataChannel is not open (readyState=${this.channel.readyState})`);
      this.fail(error);
      throw error;
    }
  }

  private handleMessage(data: Uint8Array): void {
    if (this.closed) {
      return;
    }
    if (!(data instanceof Uint8Array)) {
      this.fail(new Error("DataChannel socket received an invalid payload"));
      return;
    }
    // 接收侧同样复制一次，避免底层实现复用同一块消息缓冲。
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.onDataEmitter.fire(VSBuffer.wrap(copy));
  }

  private handleBufferedAmountLow(): void {
    if (this.closed) {
      return;
    }
    this.paused = false;
    try {
      this.pump();
    } catch {
      // pump 内已失败关闭并回收；事件回调不能再把异常抛回传输实现。
    }
  }

  private pump(): void {
    while (!this.closed && !this.paused && this.queue.length > 0) {
      if (this.channel.readyState !== "open") {
        this.fail(new Error(`DataChannel is not open (readyState=${this.channel.readyState})`));
        return;
      }

      const frame = this.queue[0];
      const size = Math.min(this.chunkSize, frame.data.byteLength - frame.offset);
      const chunk = new Uint8Array(size);
      chunk.set(frame.data.subarray(frame.offset, frame.offset + size));

      try {
        this.channel.send(chunk);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.fail(normalized);
        throw normalized;
      }

      frame.offset += size;
      this.queuedBytes -= size;
      if (frame.offset >= frame.data.byteLength) {
        this.queue.shift();
      }

      // 只按通道发送缓冲判断高水位。若把本地队列也算进去，单条大于高水位的
      // payload 会在通道仍空闲时暂停，而 bufferedAmount 不会再下降触发低位事件。
      if (this.readBufferedAmount() >= this.highWaterMark) {
        this.paused = true;
      }
    }

    this.maybeResolveDrain();
  }

  private readBufferedAmount(): number {
    const value = this.channel.bufferedAmount;
    // 非有限值视为 0，避免异常观察值把背压状态永久卡住。
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private isDrained(): boolean {
    return this.queuedBytes === 0 && this.readBufferedAmount() <= this.lowWaterMark;
  }

  private maybeResolveDrain(): void {
    if (this.closed || this.drainWaiters.length === 0 || !this.isDrained()) {
      return;
    }
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private fail(error: Error): void {
    this.shutdown(true, error);
  }

  private shutdown(closeTransport: boolean, error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    this.paused = false;
    this.queue.length = 0;
    this.queuedBytes = 0;

    this.subscriptions.dispose();

    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }

    if (closeTransport) {
      try {
        this.channel.close();
      } catch {
        // 关闭失败不能影响本地状态回收与等待方拒绝。
      }
    }

    this.onCloseEmitter.fire();
    this.onEndEmitter.fire();
  }
}

export function createDataChannelSocket(
  channel: DataChannelTransport,
  options?: DataChannelSocketOptions,
): ISocket {
  return new DataChannelSocket(channel, options);
}
