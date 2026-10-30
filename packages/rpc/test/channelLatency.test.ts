import assert from "node:assert/strict";
import test from "node:test";
import { VSBuffer } from "../src/buffer.js";
import {
  ChannelClient,
  ChannelServer,
  RequestType,
  ResponseType,
  type ChannelClientOptions,
  type ChannelRequestLatencySample,
  type ChannelServerOptions,
  type IChannel,
  type IServerChannel,
} from "../src/channels.js";
import { CancellationTokenSource, Emitter, Event } from "../src/foundation.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

interface TestClock {
  readonly now: () => number;
  set(value: number): void;
}

function createClock(initial = 0): TestClock {
  let value = initial;
  return {
    now: () => value,
    set: (next) => {
      value = next;
    },
  };
}

function createFrame(header: unknown[], body?: unknown): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function readFrame(buffer: VSBuffer): { header: any[]; body: any } {
  const reader = new BufferReader(buffer);
  const header = deserialize(reader) as any[];
  const body = deserialize(reader);
  return { header, body };
}

function last<T>(items: readonly T[]): T {
  return items[items.length - 1];
}

/** 双向链路；默认同步 loopback，关闭 autoFlush 后可手动投递以制造乱序/延迟。 */
class TestLink implements IMessagePassingProtocol {
  private readonly emitter = new Emitter<VSBuffer>();
  readonly onMessage = this.emitter.event;
  readonly sent: VSBuffer[] = [];
  readonly queued: VSBuffer[] = [];
  peer: TestLink | null = null;
  autoFlush = true;
  sendError: Error | null = null;
  onSend?: (buffer: VSBuffer) => void;

  send(buffer: VSBuffer): void {
    this.sent.push(buffer);
    if (this.sendError) {
      throw this.sendError;
    }
    this.onSend?.(buffer);
    if (!this.peer) {
      return;
    }
    if (this.autoFlush) {
      this.peer.receive(buffer);
    } else {
      this.queued.push(buffer);
    }
  }

  flush(): void {
    const queued = this.queued.splice(0);
    for (const buffer of queued) {
      this.peer?.receive(buffer);
    }
  }

  receive(buffer: VSBuffer): void {
    this.emitter.fire(buffer);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function createClientFixture(clock: TestClock, initialize = true) {
  const peer = new TestLink();
  const samples: ChannelRequestLatencySample[] = [];
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: (sample) => samples.push(sample),
  });
  if (initialize) {
    peer.receive(createFrame([ResponseType.Initialize]));
  }
  return { client, peer, samples };
}

function createServerPair(
  settings: {
    channel?: IServerChannel<string>;
    clientOptions?: ChannelClientOptions;
    serverOptions?: ChannelServerOptions;
    timeoutDelay?: number;
    autoFlush?: boolean;
  } = {},
) {
  const clientLink = new TestLink();
  const serverLink = new TestLink();
  clientLink.peer = serverLink;
  serverLink.peer = clientLink;
  const autoFlush = settings.autoFlush ?? true;
  clientLink.autoFlush = autoFlush;
  serverLink.autoFlush = autoFlush;
  const samples: ChannelRequestLatencySample[] = [];
  const client = new ChannelClient(clientLink, {
    ...settings.clientOptions,
    onRequestLatencySample: (sample) => samples.push(sample),
  });
  const server = new ChannelServer(
    serverLink,
    "ctx",
    settings.timeoutDelay ?? 1000,
    false,
    settings.serverOptions,
  );
  if (settings.channel) {
    server.registerChannel("svc", settings.channel);
  }
  return { client, server, clientLink, serverLink, samples };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 客户端采样
// ---------------------------------------------------------------------------

test("并发请求响应乱序时按 id 正确配对样本", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);
  const channel = client.getChannel<IChannel>("svc");

  const first = channel.call("first");
  const second = channel.call("second");
  const firstId = readFrame(peer.sent[0]).header[1];
  const secondId = readFrame(peer.sent[1]).header[1];

  clock.set(300);
  peer.receive(
    createFrame([ResponseType.PromiseSuccess, secondId, { serverProcessingMs: 20 }], "B"),
  );
  clock.set(400);
  peer.receive(
    createFrame([ResponseType.PromiseSuccess, firstId, { serverProcessingMs: 50 }], "A"),
  );

  assert.equal(await first, "A");
  assert.equal(await second, "B");
  assert.deepEqual(samples, [
    { totalMs: 200, serverProcessingMs: 20, networkRoundTripMs: 180 },
    { totalMs: 300, serverProcessingMs: 50, networkRoundTripMs: 250 },
  ]);
});

test("旧服务端响应没有 metadata 时不采样且业务正常", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);

  const promise = client.getChannel<IChannel>("svc").call("legacy");
  const id = readFrame(last(peer.sent)).header[1];
  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id], "value"));

  assert.equal(await promise, "value");
  assert.equal(samples.length, 0);
});

test("非法 metadata 丢弃样本且不阻塞后续合法样本", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);
  const channel = client.getChannel<IChannel>("svc");

  const invalidMetadatas: unknown[] = [
    null,
    {},
    "bad",
    42,
    [],
    { serverProcessingMs: "12" },
    { serverProcessingMs: Number.NaN },
    { serverProcessingMs: Number.POSITIVE_INFINITY },
    { serverProcessingMs: -1 },
    { serverProcessingMs: 500 },
    { serverProcessingMs: 150 },
  ];

  for (const metadata of invalidMetadatas) {
    clock.set(100);
    const promise = channel.call("call");
    const id = readFrame(last(peer.sent)).header[1];
    clock.set(200);
    peer.receive(createFrame([ResponseType.PromiseSuccess, id, metadata], "ok"));
    assert.equal(await promise, "ok");
    assert.equal(samples.length, 0, `metadata ${JSON.stringify(metadata)} 不应产生样本`);
  }

  clock.set(300);
  const valid = channel.call("call");
  const validId = readFrame(last(peer.sent)).header[1];
  clock.set(400);
  peer.receive(
    createFrame([ResponseType.PromiseSuccess, validId, { serverProcessingMs: 40 }], "ok"),
  );

  assert.equal(await valid, "ok");
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 40, networkRoundTripMs: 60 }]);
});

test("totalMs 为负或非有限时丢弃样本", async () => {
  const negativeClock = createClock(200);
  const negative = createClientFixture(negativeClock);
  const negativePromise = negative.client.getChannel<IChannel>("svc").call("call");
  const negativeId = readFrame(last(negative.peer.sent)).header[1];
  negativeClock.set(100);
  negative.peer.receive(
    createFrame([ResponseType.PromiseSuccess, negativeId, { serverProcessingMs: 10 }], "ok"),
  );
  assert.equal(await negativePromise, "ok");
  assert.equal(negative.samples.length, 0);

  const nanClock = createClock(100);
  const notANumber = createClientFixture(nanClock);
  const nanPromise = notANumber.client.getChannel<IChannel>("svc").call("call");
  const nanId = readFrame(last(notANumber.peer.sent)).header[1];
  nanClock.set(Number.NaN);
  notANumber.peer.receive(
    createFrame([ResponseType.PromiseSuccess, nanId, { serverProcessingMs: 10 }], "ok"),
  );
  assert.equal(await nanPromise, "ok");
  assert.equal(notANumber.samples.length, 0);
});

test("取消后的迟到响应不采样", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);
  const cancellation = new CancellationTokenSource();

  const promise = client.getChannel<IChannel>("svc").call("cancel", undefined, cancellation.token);
  const id = readFrame(peer.sent[0]).header[1];
  cancellation.cancel();
  await assert.rejects(promise, /Cancelled/);

  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "late"));
  assert.equal(samples.length, 0);
});

test("dispose 后不采样且请求按既有语义失败", async () => {
  const clock = createClock(100);
  const { client, samples } = createClientFixture(clock);

  const promise = client.getChannel<IChannel>("svc").call("dispose");
  client.dispose();
  await assert.rejects(promise, /disposed/);
  assert.equal(samples.length, 0);
});

test("重复响应只采样一次", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);

  const promise = client.getChannel<IChannel>("svc").call("duplicate");
  const id = readFrame(last(peer.sent)).header[1];
  clock.set(200);
  const response = createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "ok");
  peer.receive(response);
  peer.receive(response);

  assert.equal(await promise, "ok");
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 10, networkRoundTripMs: 90 }]);
});

test("EventListen / EventFire 不采样", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);

  const received: string[] = [];
  const dispose = client.getChannel<IChannel>("svc").listen<string>("change")((value) => {
    received.push(value);
  });
  const id = readFrame(peer.sent[0]).header[1];
  assert.equal(readFrame(peer.sent[0]).header[0], RequestType.EventListen);

  clock.set(200);
  peer.receive(createFrame([ResponseType.EventFire, id, { serverProcessingMs: 10 }], "changed"));

  assert.deepEqual(received, ["changed"]);
  assert.equal(samples.length, 0);
  dispose.dispose();
});

test("Initialize 前的排队等待不计入 totalMs", async () => {
  const clock = createClock(0);
  const { client, peer, samples } = createClientFixture(clock, false);

  const promise = client.getChannel<IChannel>("svc").call("queued");
  assert.equal(peer.sent.length, 0);

  clock.set(100);
  peer.receive(createFrame([ResponseType.Initialize]));
  await tick();
  assert.equal(peer.sent.length, 1);

  const id = readFrame(peer.sent[0]).header[1];
  clock.set(150);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 20 }], "ok"));

  assert.equal(await promise, "ok");
  assert.deepEqual(samples, [{ totalMs: 50, serverProcessingMs: 20, networkRoundTripMs: 30 }]);
});

test("observer 在样本回调中取消同一请求不改变业务结果", async () => {
  const clock = createClock(100);
  const peer = new TestLink();
  const cancellation = new CancellationTokenSource();
  const samples: ChannelRequestLatencySample[] = [];
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: (sample) => {
      samples.push(sample);
      cancellation.cancel();
    },
  });
  peer.receive(createFrame([ResponseType.Initialize]));

  const promise = client.getChannel<IChannel>("svc").call("cancel", undefined, cancellation.token);
  const id = readFrame(last(peer.sent)).header[1];
  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "ok"));

  assert.equal(await promise, "ok");
  // 业务 id 已消费，重入的取消不会再发 PromiseCancel 或改写结果。
  assert.equal(peer.sent.length, 1);
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 10, networkRoundTripMs: 90 }]);
});

test("observer 在样本回调中 dispose 不改变业务结果", async () => {
  const clock = createClock(100);
  const peer = new TestLink();
  const samples: ChannelRequestLatencySample[] = [];
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: (sample) => {
      samples.push(sample);
      client.dispose();
    },
  });
  peer.receive(createFrame([ResponseType.Initialize]));

  const promise = client.getChannel<IChannel>("svc").call("dispose");
  const id = readFrame(last(peer.sent)).header[1];
  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "ok"));

  assert.equal(await promise, "ok");
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 10, networkRoundTripMs: 90 }]);
});

test("observer 重入重复响应不改变业务结果且只采样一次", async () => {
  const clock = createClock(100);
  const peer = new TestLink();
  const samples: ChannelRequestLatencySample[] = [];
  let replay: (() => void) | null = null;
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: (sample) => {
      samples.push(sample);
      replay?.();
    },
  });
  peer.receive(createFrame([ResponseType.Initialize]));

  const promise = client.getChannel<IChannel>("svc").call("replay");
  const id = readFrame(last(peer.sent)).header[1];
  replay = () => {
    peer.receive(
      createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "hijacked"),
    );
  };
  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "ok"));

  assert.equal(await promise, "ok");
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 10, networkRoundTripMs: 90 }]);
});

test("observer 抛错不影响 RPC 业务", async () => {
  const clock = createClock(100);
  const peer = new TestLink();
  let attempts = 0;
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: () => {
      attempts += 1;
      throw new Error("observer failed");
    },
  });
  peer.receive(createFrame([ResponseType.Initialize]));

  const promise = client.getChannel<IChannel>("svc").call("observe");
  const id = readFrame(last(peer.sent)).header[1];
  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "ok"));

  assert.equal(await promise, "ok");
  assert.equal(attempts, 1);
});

test("send 失败不会留下可被迟到响应误匹配的样本", async () => {
  const clock = createClock(100);
  const { client, peer, samples } = createClientFixture(clock);
  peer.sendError = new Error("send failed");

  const promise = client.getChannel<IChannel>("svc").call("broken");
  const id = readFrame(peer.sent[0]).header[1];
  peer.sendError = null;

  clock.set(200);
  peer.receive(createFrame([ResponseType.PromiseSuccess, id, { serverProcessingMs: 10 }], "late"));
  await promise;
  assert.equal(samples.length, 0);
});

test("同步 loopback 发送也能采到样本", async () => {
  const clock = createClock(100);
  const samples: ChannelRequestLatencySample[] = [];
  const peer = new TestLink();
  peer.onSend = (buffer) => {
    const { header } = readFrame(buffer);
    if (header[0] !== RequestType.Promise) {
      return;
    }
    clock.set(160);
    peer.receive(
      createFrame([ResponseType.PromiseSuccess, header[1], { serverProcessingMs: 10 }], "value"),
    );
  };
  const client = new ChannelClient(peer, {
    now: clock.now,
    onRequestLatencySample: (sample) => samples.push(sample),
  });
  peer.receive(createFrame([ResponseType.Initialize]));

  const result = client.getChannel<IChannel>("svc").call("sync");
  assert.deepEqual(samples, [{ totalMs: 60, serverProcessingMs: 10, networkRoundTripMs: 50 }]);
  assert.equal(await result, "value");
});

// ---------------------------------------------------------------------------
// 服务端 metadata 与端到端行为
// ---------------------------------------------------------------------------

test("成功、PromiseError、PromiseErrorObj 响应均携带 serverProcessingMs 并采样", async () => {
  const clientClock = createClock(100);
  const serverClock = createClock(200);
  const channel: IServerChannel<string> = {
    call: async <T>(_ctx: string, command: string) => {
      if (command === "error") {
        throw new Error("boom");
      }
      if (command === "non-error") {
        throw "plain failure";
      }
      return "value" as T;
    },
    listen: () => Event.None,
  };
  const { client, serverLink, samples } = createServerPair({
    channel,
    clientOptions: { now: clientClock.now },
    serverOptions: { now: serverClock.now },
  });
  const svc = client.getChannel<IChannel>("svc");

  const success = svc.call("success");
  clientClock.set(300);
  serverClock.set(230);
  assert.equal(await success, "value");
  assert.deepEqual(readFrame(last(serverLink.sent)).header.slice(0, 2), [
    ResponseType.PromiseSuccess,
    0,
  ]);
  assert.deepEqual(readFrame(last(serverLink.sent)).header[2], { serverProcessingMs: 30 });

  const failed = svc.call("error");
  clientClock.set(400);
  serverClock.set(260);
  await assert.rejects(failed, /boom/);
  const errorFrame = readFrame(last(serverLink.sent));
  assert.equal(errorFrame.header[0], ResponseType.PromiseError);
  assert.deepEqual(errorFrame.header[2], { serverProcessingMs: 30 });
  assert.equal(errorFrame.body.name, "Error");

  const nonError = svc.call("non-error");
  clientClock.set(500);
  serverClock.set(290);
  await assert.rejects(nonError, (error: unknown) => error === "plain failure");
  const nonErrorFrame = readFrame(last(serverLink.sent));
  assert.equal(nonErrorFrame.header[0], ResponseType.PromiseErrorObj);
  assert.deepEqual(nonErrorFrame.header[2], { serverProcessingMs: 30 });

  assert.deepEqual(samples, [
    { totalMs: 200, serverProcessingMs: 30, networkRoundTripMs: 170 },
    { totalMs: 100, serverProcessingMs: 30, networkRoundTripMs: 70 },
    { totalMs: 100, serverProcessingMs: 30, networkRoundTripMs: 70 },
  ]);
});

test("服务端处理时长包含 handler 的 await", async () => {
  const clientClock = createClock(1000);
  const serverClock = createClock(0);
  let resolveCall!: (value: string) => void;
  const channel: IServerChannel<string> = {
    call: <T>() =>
      new Promise<T>((resolve) => {
        resolveCall = (value) => resolve(value as T);
      }),
    listen: () => Event.None,
  };
  const { client, serverLink, samples } = createServerPair({
    channel,
    clientOptions: { now: clientClock.now },
    serverOptions: { now: serverClock.now },
  });

  const promise = client.getChannel<IChannel>("svc").call("slow");
  clientClock.set(1400);
  serverClock.set(300);
  resolveCall("done");

  assert.equal(await promise, "done");
  assert.deepEqual(readFrame(last(serverLink.sent)).header[2], { serverProcessingMs: 300 });
  assert.deepEqual(samples, [{ totalMs: 400, serverProcessingMs: 300, networkRoundTripMs: 100 }]);
});

test("一次 call 的协议帧数量不变，仅响应 header 增加 metadata", async () => {
  const clientClock = createClock(0);
  const serverClock = createClock(100);
  const channel: IServerChannel<string> = {
    call: async <T>() => "value" as T,
    listen: () => Event.None,
  };
  const { client, clientLink, serverLink, samples } = createServerPair({
    channel,
    clientOptions: { now: clientClock.now },
    serverOptions: { now: serverClock.now },
  });

  const requestsBefore = clientLink.sent.length;
  const responsesBefore = serverLink.sent.length;

  const promise = client.getChannel<IChannel>("svc").call("once");
  clientClock.set(100);
  serverClock.set(125);
  assert.equal(await promise, "value");

  assert.equal(clientLink.sent.length - requestsBefore, 1);
  assert.equal(serverLink.sent.length - responsesBefore, 1);
  const response = readFrame(last(serverLink.sent));
  assert.equal(response.header[0], ResponseType.PromiseSuccess);
  assert.equal(response.header.length, 3);
  assert.deepEqual(response.header[2], { serverProcessingMs: 25 });
  assert.equal(response.body, "value");
  assert.deepEqual(samples, [{ totalMs: 100, serverProcessingMs: 25, networkRoundTripMs: 75 }]);
});

test("Initialize、EventFire 与未知 channel 超时不携带 metadata", async () => {
  const emitter = new Emitter<string>();
  const channel: IServerChannel<string> = {
    call: async <T>() => "value" as T,
    listen: <T>() => emitter.event as Event<T>,
  };
  const { client, serverLink, samples } = createServerPair({ channel, timeoutDelay: 1 });

  const initFrame = readFrame(serverLink.sent[0]);
  assert.equal(initFrame.header[0], ResponseType.Initialize);
  assert.equal(initFrame.header.length, 1);

  const received: string[] = [];
  client.getChannel<IChannel>("svc").listen<string>("tick")((value) => received.push(value));
  emitter.fire("fired");

  const missing = client.getChannel<IChannel>("missing").call("call");
  await assert.rejects(missing, /timed out/);

  const frames = serverLink.sent.map(readFrame);
  const eventFrame = frames.find((frame) => frame.header[0] === ResponseType.EventFire);
  assert.ok(eventFrame);
  assert.equal(eventFrame.header.length, 2);
  assert.deepEqual(received, ["fired"]);

  const timeoutFrame = frames.find((frame) => frame.header[0] === ResponseType.PromiseError);
  assert.ok(timeoutFrame);
  assert.equal(timeoutFrame.header.length, 2);
  assert.equal(samples.length, 0);

  emitter.dispose();
});

test("服务端时钟差值非有限或为负时不附 metadata", async () => {
  const serverClock = createClock(200);
  const channel: IServerChannel<string> = {
    call: async <T>() => "value" as T,
    listen: () => Event.None,
  };
  const clientClock = createClock(0);
  const { client, serverLink, samples } = createServerPair({
    channel,
    clientOptions: { now: clientClock.now },
    serverOptions: { now: serverClock.now },
  });

  const promise = client.getChannel<IChannel>("svc").call("call");
  clientClock.set(100);
  serverClock.set(100);
  assert.equal(await promise, "value");

  const response = readFrame(last(serverLink.sent));
  assert.equal(response.header[0], ResponseType.PromiseSuccess);
  assert.equal(response.header.length, 2);
  assert.equal(samples.length, 0);
});
