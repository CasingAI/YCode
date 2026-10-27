import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Emitter, VSBuffer, type Event, type IChannelServer, type ISocket } from "@zcode/rpc";
import type { ServiceCollection } from "@zcode/services";
import {
  createMobileAttachmentRegistry,
  type MobileAttachmentRegistry,
} from "../src/host/mobileRemoteControlAttachment.js";

class FakeSocket implements ISocket {
  private readonly onDataEmitter = new Emitter<VSBuffer>();
  private readonly onCloseEmitter = new Emitter<void>();
  private readonly onEndEmitter = new Emitter<void>();

  /** 用于断言 SocketProtocol / attachment 的订阅确实被释放。 */
  activeDataListeners = 0;
  activeCloseListeners = 0;
  disposed = false;
  readonly writes: string[] = [];

  readonly onData: Event<VSBuffer> = (listener) => {
    this.activeDataListeners += 1;
    const subscription = this.onDataEmitter.event(listener);
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.activeDataListeners -= 1;
        subscription.dispose();
      },
    };
  };

  readonly onClose: Event<void> = (listener) => {
    this.activeCloseListeners += 1;
    const subscription = this.onCloseEmitter.event(listener);
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.activeCloseListeners -= 1;
        subscription.dispose();
      },
    };
  };

  readonly onEnd: Event<void> = this.onEndEmitter.event;

  write(buffer: VSBuffer): void {
    this.writes.push(buffer.toString());
  }

  end(): void {
    this.dispose();
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onCloseEmitter.fire();
    this.onEndEmitter.fire();
  }
}

interface AttachmentRecord {
  readonly server: IChannelServer;
  readonly services: ServiceCollection;
  disposed: boolean;
}

function createRegistryHarness() {
  const sizes: number[] = [];
  const attachedLogs: number[] = [];
  const exposed: AttachmentRecord[] = [];
  const services = {} as ServiceCollection;
  const registry = createMobileAttachmentRegistry({
    getServices: () => services,
    exposeServices: (server, exposedServices) => {
      const record: AttachmentRecord = {
        server,
        services: exposedServices,
        disposed: false,
      };
      exposed.push(record);
      return () => {
        record.disposed = true;
      };
    },
    logRpc: () => undefined,
    onSizeChanged: (size) => sizes.push(size),
    logAttached: (size) => attachedLogs.push(size),
  });
  return { registry, sizes, attachedLogs, exposed, services };
}

function attachAll(registry: MobileAttachmentRegistry): {
  fallbacks: [FakeSocket, FakeSocket];
  rtc: [FakeSocket, FakeSocket];
} {
  const fallbackA = new FakeSocket();
  const fallbackB = new FakeSocket();
  const rtcA = new FakeSocket();
  const rtcB = new FakeSocket();
  registry.attach(fallbackA);
  registry.attach(fallbackB);
  registry.attach(rtcA, { counted: false });
  registry.attach(rtcB, { counted: false });
  return { fallbacks: [fallbackA, fallbackB], rtc: [rtcA, rtcB] };
}

describe("mobile attachment registry 计数", () => {
  it("RTC 附件不计入 connectedClients，逐一断开始终等于 fallback 数", () => {
    const harness = createRegistryHarness();
    const { fallbacks, rtc } = attachAll(harness.registry);

    assert.equal(harness.registry.size, 2);
    assert.deepEqual(harness.sizes, [1, 2]);
    assert.deepEqual(harness.attachedLogs, [1, 2]);

    // RTC 断开不应触发计数变化。
    rtc[0].dispose();
    assert.equal(harness.registry.size, 2);
    assert.deepEqual(harness.sizes, [1, 2]);

    fallbacks[0].dispose();
    assert.equal(harness.registry.size, 1);
    assert.deepEqual(harness.sizes, [1, 2, 1]);

    // 另一个 RTC 断开同样不影响逻辑连接数。
    rtc[1].dispose();
    assert.equal(harness.registry.size, 1);
    assert.deepEqual(harness.sizes, [1, 2, 1]);

    fallbacks[1].dispose();
    assert.equal(harness.registry.size, 0);
    assert.deepEqual(harness.sizes, [1, 2, 1, 0]);
  });

  it("同一条浏览器升级到 RTC 后逻辑连接数不翻倍", () => {
    const harness = createRegistryHarness();
    const fallback = new FakeSocket();
    harness.registry.attach(fallback);
    const rtc = new FakeSocket();
    harness.registry.attach(rtc, { counted: false });

    assert.equal(harness.registry.size, 1);
    assert.deepEqual(harness.sizes, [1]);

    // 升级后 fallback 断开（例如网络切换）时，RTC 仍存活但不再单独计数。
    fallback.dispose();
    assert.equal(harness.registry.size, 0);
    assert.deepEqual(harness.sizes, [1, 0]);
  });
});

describe("mobile attachment registry 生命周期", () => {
  it("disposeAll 释放全部 socket、SocketProtocol 订阅与 services 暴露", () => {
    const harness = createRegistryHarness();
    const { fallbacks, rtc } = attachAll(harness.registry);
    assert.equal(harness.exposed.length, 4);

    harness.registry.disposeAll();

    assert.equal(harness.registry.size, 0);
    // 逐个 counted 释放：2 -> 1 -> 0，RTC 不额外触发。
    assert.deepEqual(harness.sizes, [1, 2, 1, 0]);
    for (const socket of [...fallbacks, ...rtc]) {
      assert.equal(socket.disposed, true);
      assert.equal(socket.activeDataListeners, 0);
      assert.equal(socket.activeCloseListeners, 0);
    }
    assert.ok(harness.exposed.every((record) => record.disposed));
    // 所有附件都暴露同一份 activeServices。
    assert.ok(harness.exposed.every((record) => record.services === harness.services));
  });

  it("单条 attachment 释放时同时释放 SocketProtocol 与自身 onClose 订阅", () => {
    const harness = createRegistryHarness();
    const socket = new FakeSocket();
    harness.registry.attach(socket);

    assert.equal(socket.activeDataListeners, 1);
    assert.equal(socket.activeCloseListeners, 1);

    socket.dispose();

    assert.equal(harness.registry.size, 0);
    assert.equal(socket.activeDataListeners, 0);
    assert.equal(socket.activeCloseListeners, 0);
    assert.equal(harness.exposed[0]?.disposed, true);
  });

  it("没有可用服务时直接断开，且不计数", () => {
    const sizes: number[] = [];
    const registry = createMobileAttachmentRegistry({
      getServices: () => null,
      exposeServices: () => {
        throw new Error("exposeServices 不应在无服务时调用");
      },
      logRpc: () => undefined,
      onSizeChanged: (size) => sizes.push(size),
      logAttached: () => undefined,
    });
    const socket = new FakeSocket();
    registry.attach(socket);

    assert.equal(socket.disposed, true);
    assert.equal(registry.size, 0);
    assert.deepEqual(sizes, []);
  });
});
