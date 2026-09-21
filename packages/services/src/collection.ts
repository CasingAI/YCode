import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

export interface ExposeOnChannelServerOptions {
  /**
   * 不暴露给该 channel server 的频道名。
   *
   * 用途：面向手机/远端 workspace 的 socket 不能暴露远控开关本身，否则手机可以
   * 关掉自己所在的入口。服务仍留在集合里，只对这条连接隐藏。
   */
  excludeChannelNames?: readonly string[];
}

/**
 * ServiceCollection — 服务注册中心
 *
 * 服务端用来注册服务实例，并自动暴露到 ChannelServer。
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** 将所有已注册的服务自动暴露为 channel */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
    options: ExposeOnChannelServerOptions = {},
  ): void {
    const excluded = new Set(options.excludeChannelNames ?? []);
    for (const [channelName, instance] of this._services) {
      if (excluded.has(channelName)) continue;
      const exposed = overrides.get(channelName) ?? instance;
      server.registerChannel(
        channelName,
        ProxyChannel.fromService(exposed as Record<string, unknown>),
      );
    }
  }
}
