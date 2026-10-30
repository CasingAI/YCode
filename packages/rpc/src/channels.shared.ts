import type { CancellationToken, Event } from "./foundation.js";

export interface IChannel {
  call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
  listen<T>(event: string, arg?: any): Event<T>;
}

export interface IServerChannel<TContext = string> {
  call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T>;
  listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}

export const enum RequestType {
  Promise = 100,
  PromiseCancel = 101,
  EventListen = 102,
  EventDispose = 103,
}

export const enum ResponseType {
  Initialize = 200,
  PromiseSuccess = 201,
  PromiseError = 202,
  PromiseErrorObj = 203,
  EventFire = 204,
}

/** 响应 header 第 3 项的可选 metadata；旧对端忽略未知尾项。 */
export interface IRawResponseMetadata {
  readonly serverProcessingMs: number;
}

export type IRawResponse =
  | { type: ResponseType.Initialize }
  | {
      type: ResponseType.PromiseSuccess;
      id: number;
      data: any;
      metadata?: IRawResponseMetadata;
    }
  | {
      type: ResponseType.PromiseError;
      id: number;
      data: {
        message: string;
        name: string;
        stack: string[] | undefined;
        code?: unknown;
        kind?: unknown;
        status?: unknown;
        retryAfterMs?: unknown;
        data?: unknown;
        detail?: unknown;
        details?: unknown;
        taskId?: unknown;
        traceId?: unknown;
      };
      metadata?: IRawResponseMetadata;
    }
  | {
      type: ResponseType.PromiseErrorObj;
      id: number;
      data: any;
      metadata?: IRawResponseMetadata;
    }
  | { type: ResponseType.EventFire; id: number; data: any };

export type IHandler = (response: IRawResponse) => void;

export interface IChannelServer<TContext = string> {
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void;
  ready?(): void;
}

export interface IChannelClient {
  getChannel<T extends IChannel>(channelName: string): T;
}

export interface ChannelRequestLatencySample {
  readonly totalMs: number;
  readonly serverProcessingMs: number;
  readonly networkRoundTripMs: number;
}

export interface ChannelClientOptions {
  /** 单调时钟，默认 performance.now()。 */
  readonly now?: () => number;
  /** 每个通过校验的完整请求/响应样本回调一次；回调异常不得影响 RPC。 */
  readonly onRequestLatencySample?: (sample: ChannelRequestLatencySample) => void;
}

export interface ChannelServerOptions {
  /** 单调时钟，默认 performance.now()。 */
  readonly now?: () => number;
}
