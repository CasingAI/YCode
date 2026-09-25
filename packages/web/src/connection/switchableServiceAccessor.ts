import type { WebSocketConnectionSnapshot } from "@zcode/client";
import {
  markCommandNotSent,
  SERVICE_ACCESSOR_CONNECTION,
  type ServiceAccessorConnection,
} from "@zcode/shared";

type WebServices = NonNullable<WebSocketConnectionSnapshot["services"]>;
type ServiceObject = Record<string, unknown>;
type EventListener = (event: unknown) => void;

interface Disposable {
  dispose(): void;
}

interface EventSubscription {
  id: number;
  serviceKey: string;
  eventName: string;
  args: unknown[];
  listener: EventListener;
  generation: number;
  disposable?: Disposable;
}

export interface SwitchableServiceAccessor {
  readonly services: WebServices;
  setTarget(target: WebServices | null, generation: number): void;
  dispose(): void;
}

const OPTIONAL_SERVICE_KEYS = new Set([
  "mediaPreviewService",
  "onboardingRecordService",
  "windowControllerService",
  "mobileRemoteControlService",
  "cuaPermissionService",
]);

function isEventName(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= "A".charCodeAt(0) &&
    name.charCodeAt(2) <= "Z".charCodeAt(0)
  );
}

function isDynamicEventName(name: string): boolean {
  return (
    name.length > "onDynamic".length &&
    name.startsWith("onDynamic") &&
    name.charCodeAt("onDynamic".length) >= "A".charCodeAt(0) &&
    name.charCodeAt("onDynamic".length) <= "Z".charCodeAt(0)
  );
}

function createConnectionClosedError(generation: number): Error {
  const error = new Error(`WebSocket service generation ${generation} is not connected`);
  error.name = "ConnectionClosed";
  return error;
}

/** 上行之前就被 facade 拒绝：服务端必然没有收到这次调用。 */
function createNotSentConnectionClosedError(generation: number): Error {
  return markCommandNotSent(createConnectionClosedError(generation));
}

class SwitchableServiceAccessorImpl implements SwitchableServiceAccessor {
  private target: WebServices | null = null;
  private generation = 0;
  private disposed = false;
  private nextSubscriptionId = 0;
  private switching = false;
  private pendingSwitch: { target: WebServices | null; generation: number } | null = null;
  private readonly subscriptions = new Map<number, EventSubscription>();
  private readonly serviceProxies = new Map<string, ServiceObject>();
  private readonly connectionListeners = new Map<string, Set<() => void>>();
  private readonly connectionAttachments = new Map<string, object | null>();
  readonly services: WebServices;

  constructor() {
    this.services = new Proxy({} as WebServices, {
      get: (_target, property) => this.getServiceProperty(property),
    }) as WebServices;
  }

  setTarget(target: WebServices | null, generation: number): void {
    if (this.disposed) {
      return;
    }
    if (this.switching) {
      // 通知回调里重入 setTarget 必须排队：外层还在遍历订阅表，交错执行会让同一条
      // 订阅被重复绑定，或让旧代守卫永久失聪。只保留最后一次换代。
      this.pendingSwitch = { target, generation };
      return;
    }

    this.switching = true;
    try {
      let next: { target: WebServices | null; generation: number } | null = {
        target,
        generation,
      };
      while (next) {
        this.pendingSwitch = null;
        this.applySwitch(next.target, next.generation);
        next = this.pendingSwitch;
      }
    } finally {
      this.switching = false;
      this.pendingSwitch = null;
    }
  }

  private applySwitch(target: WebServices | null, generation: number): void {
    if (this.target === target && this.generation === generation) {
      return;
    }

    // 先切换代际并释放旧订阅，确保旧 transport 的迟到事件被忽略。
    this.target = target;
    this.generation = generation;
    for (const subscription of this.subscriptions.values()) {
      this.releaseSubscription(subscription);
    }

    // 通知期间新建的订阅会在 subscribe() 里自行 attach，第二段只重绑切换前
    // 已存在的条目；快照避免把新订阅再绑一次而泄漏上游 disposable。
    const migrating = [...this.subscriptions.values()];
    // transport owner 必须先收到 replacement 通知并清空旧 ownership，
    // 再把新 target 的事件 registrar 接上；否则 registrar 同步推送的初始帧
    // 可能进入即将失效的 decoder 或 subscription。
    this.notifyAttachmentChanges();
    for (const subscription of migrating) {
      if (!this.subscriptions.has(subscription.id) || subscription.disposable) continue;
      subscription.generation = this.generation;
      this.attachSubscription(subscription);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.target = null;
    this.generation += 1;
    for (const subscription of this.subscriptions.values()) {
      this.releaseSubscription(subscription);
    }
    this.subscriptions.clear();
    this.serviceProxies.clear();
    this.connectionListeners.clear();
    this.connectionAttachments.clear();
  }

  private getServiceProperty(property: PropertyKey): unknown {
    if (typeof property !== "string" || property === "then" || property === "toJSON") {
      return undefined;
    }

    const targetService = this.target
      ? (this.target as unknown as Record<string, unknown>)[property]
      : undefined;
    if (targetService == null && OPTIONAL_SERVICE_KEYS.has(property)) {
      return undefined;
    }
    return this.getServiceProxy(property);
  }

  private getServiceProxy(serviceKey: string): ServiceObject {
    const existing = this.serviceProxies.get(serviceKey);
    if (existing) {
      return existing;
    }

    const proxy = new Proxy({} as ServiceObject, {
      get: (_target, property) => this.getServiceMember(serviceKey, property),
    });
    this.serviceProxies.set(serviceKey, proxy);
    return proxy;
  }

  private getServiceMember(serviceKey: string, property: PropertyKey): unknown {
    if (property === SERVICE_ACCESSOR_CONNECTION) {
      return this.getServiceConnection(serviceKey);
    }
    if (typeof property !== "string" || property === "then" || property === "toJSON") {
      return undefined;
    }

    if (isEventName(property)) {
      if (isDynamicEventName(property)) {
        return (...args: unknown[]) =>
          (listener: EventListener) =>
            this.subscribe(serviceKey, property, args, listener);
      }
      return (listener: EventListener) => this.subscribe(serviceKey, property, [], listener);
    }

    return async (...args: unknown[]) => {
      const target = this.target;
      const generation = this.generation;
      const service: Record<string, unknown> | undefined = target
        ? ((target as unknown as Record<string, unknown>)[serviceKey] as
            | Record<string, unknown>
            | undefined)
        : undefined;
      const method = service?.[property];
      if (typeof method !== "function") {
        throw createNotSentConnectionClosedError(generation);
      }
      const result = await method.apply(service, args);
      if (this.target !== target || this.generation !== generation) {
        throw createConnectionClosedError(generation);
      }
      return result;
    };
  }

  private getTargetService(serviceKey: string): ServiceObject | null {
    if (!this.target) return null;
    const value = (this.target as unknown as Record<string, unknown>)[serviceKey];
    return value && (typeof value === "object" || typeof value === "function")
      ? (value as ServiceObject)
      : null;
  }

  private getServiceConnection(serviceKey: string): ServiceAccessorConnection {
    const listeners = this.connectionListeners.get(serviceKey) ?? new Set<() => void>();
    this.connectionListeners.set(serviceKey, listeners);
    return {
      getAttachment: () => this.getTargetService(serviceKey),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  private notifyAttachmentChanges(): void {
    for (const [serviceKey, listeners] of this.connectionListeners) {
      const attachment = this.getTargetService(serviceKey);
      const previous = this.connectionAttachments.get(serviceKey) ?? null;
      this.connectionAttachments.set(serviceKey, attachment);
      if (!attachment || attachment === previous || listeners.size === 0) continue;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // 通知会跑 renderer 侧 transport 回调；单个回调抛错不能中断
          // 事件订阅迁移，否则整个连接在本代内失聪。
        }
      }
    }
  }

  private subscribe(
    serviceKey: string,
    eventName: string,
    args: unknown[],
    listener: EventListener,
  ): Disposable {
    const subscription: EventSubscription = {
      id: this.nextSubscriptionId++,
      serviceKey,
      eventName,
      args,
      listener,
      generation: this.generation,
    };
    this.subscriptions.set(subscription.id, subscription);
    this.attachSubscription(subscription);
    return {
      dispose: () => {
        if (!this.subscriptions.delete(subscription.id)) {
          return;
        }
        this.releaseSubscription(subscription);
      },
    };
  }

  private releaseSubscription(subscription: EventSubscription): void {
    const disposable = subscription.disposable;
    subscription.disposable = undefined;
    if (!disposable) return;
    try {
      disposable.dispose();
    } catch {
      // 上游 dispose 抛错不能中断换代：其余订阅仍必须迁移到新 target。
    }
  }

  private attachSubscription(subscription: EventSubscription): void {
    const target = this.target;
    if (!target || this.disposed) {
      return;
    }

    const service: Record<string, unknown> | undefined = (
      target as unknown as Record<string, unknown>
    )[subscription.serviceKey] as Record<string, unknown> | undefined;
    const eventFactory = service?.[subscription.eventName];
    if (typeof eventFactory !== "function") {
      return;
    }

    const generation = this.generation;
    const guardedListener: EventListener = (event) => {
      if (subscription.generation !== generation || this.target !== target || this.disposed) {
        return;
      }
      subscription.listener(event);
    };

    try {
      const event = isDynamicEventName(subscription.eventName)
        ? eventFactory.apply(service, subscription.args)
        : eventFactory.call(service, guardedListener);
      if (typeof event === "function") {
        subscription.disposable = event(guardedListener) as Disposable;
      } else if (event && typeof event.dispose === "function") {
        subscription.disposable = event as Disposable;
      }
    } catch {
      // 旧 target 缺少事件时，保留订阅记录，等下一次 target 切换后再尝试绑定。
    }
  }
}

export function createSwitchableServiceAccessor(): SwitchableServiceAccessor {
  return new SwitchableServiceAccessorImpl();
}
