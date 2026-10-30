import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type ChannelClientOptions,
  type ChannelRequestLatencySample,
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

enum State {
  Uninitialized,
  Idle,
}

const defaultNow = (): number => performance.now();

/**
 * 校验响应 header 第 3 项的 metadata。
 * 旧服务端不发送、长度不合法、字段缺失或值非法时一律视为没有样本，
 * 不能把缺失伪装成 0，也不能 clamp 数值。
 */
function readServerProcessingMs(metadata: unknown): number | undefined {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const value = (metadata as { readonly serverProcessingMs?: unknown }).serverProcessingMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  private activeRequests = new Set<IDisposable>();
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;
  private readonly now: () => number;
  private readonly onRequestLatencySample?: (sample: ChannelRequestLatencySample) => void;
  // 只在已成功写出请求后记录 t0；取消、断线、dispose 与 send 失败都必须移除。
  private readonly pendingLatencyStarts = new Map<number, number>();

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  constructor(
    private protocol: IMessagePassingProtocol,
    options: ChannelClientOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.onRequestLatencySample = options.onRequestLatencySample;
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    const id = this.lastRequestId++;

    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    let disposable: IDisposable | undefined;
    const result = new Promise<any>((resolve, reject) => {
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        const handler: IHandler = (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              const error = new Error(response.data.message) as Error & Record<string, unknown>;
              error.name = response.data.name;
              if (response.data.stack) {
                error.stack = response.data.stack.join("\n");
              }
              const passthroughKeys = [
                "code",
                "kind",
                "status",
                "retryAfterMs",
                "data",
                "detail",
                "details",
                "taskId",
                "traceId",
              ] as const;
              for (const key of passthroughKeys) {
                const value = response.data[key];
                if (value !== undefined) {
                  error[key] = value;
                }
              }
              reject(error);
              return;
            }
            case ResponseType.PromiseErrorObj:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg, true);
      };

      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      disposable = cancellationToken.onCancellationRequested(() => {
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        this.pendingLatencyStarts.delete(id);
        reject(new Error("Cancelled"));
      });
      this.activeRequests.add(disposable);
    });

    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        const doRequest = () => {
          this.activeRequests.add(emitter);
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    this.handlers.set(id, (response) => {
      emitter.fire((response as { data: any }).data);
    });

    return emitter.event;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
    trackLatency = false,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    // t0 在请求序列化完成之后、写出之前记录，因此不包含序列化与 Initialize 等待。
    if (trackLatency && this.onRequestLatencySample) {
      this.pendingLatencyStarts.set(id, this.now());
    }
    try {
      this.protocol.send(writer.buffer);
    } catch {
      // send 失败不会产生响应；移除 t0，避免迟到的同 id 帧被误当作样本。
      if (trackLatency) {
        this.pendingLatencyStarts.delete(id);
      }
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onBuffer(message: VSBuffer): void {
    // t1 在完整响应帧到达、反序列化之前记录；没有待采样请求时不读取时钟。
    const receivedAt = this.pendingLatencyStarts.size > 0 ? this.now() : undefined;
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.PromiseErrorObj: {
        const sample = this.takeLatencySample(header[1], header[2], receivedAt);
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        // 业务 handler 已按原逻辑消费 id 并 resolve/reject；旁路观察者此时才能执行。
        if (sample) {
          this.notifyLatencySample(sample);
        }
        return;
      }
      case ResponseType.EventFire:
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  /**
   * 在完整响应帧到达时单次消费同 id 的计时记录并校验为原始样本。
   * 记录先移除，保证重复或重入响应不会二次采样。
   */
  private takeLatencySample(
    id: number,
    metadata: unknown,
    receivedAt: number | undefined,
  ): ChannelRequestLatencySample | undefined {
    const startedAt = this.pendingLatencyStarts.get(id);
    if (startedAt === undefined) {
      return undefined;
    }
    this.pendingLatencyStarts.delete(id);

    if (receivedAt === undefined) {
      return undefined;
    }
    const serverProcessingMs = readServerProcessingMs(metadata);
    if (serverProcessingMs === undefined) {
      return undefined;
    }
    const totalMs = receivedAt - startedAt;
    if (!Number.isFinite(totalMs) || totalMs < 0 || serverProcessingMs > totalMs) {
      return undefined;
    }

    return {
      totalMs,
      serverProcessingMs,
      networkRoundTripMs: totalMs - serverProcessingMs,
    };
  }

  private notifyLatencySample(sample: ChannelRequestLatencySample): void {
    try {
      this.onRequestLatencySample?.(sample);
    } catch {
      // 采样观察者属于旁路统计，异常不能破坏 RPC 业务。
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    this.handlers.get(response.id)?.(response);
  }

  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;

    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    this.pendingLatencyStarts.clear();
    this._onDidInitialize.dispose();
  }
}
