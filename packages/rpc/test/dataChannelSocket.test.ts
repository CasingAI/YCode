import assert from "node:assert/strict";
import test from "node:test";
import { VSBuffer } from "../src/buffer.js";
import {
  createDataChannelSocket,
  type DataChannelSocketOptions,
  type DataChannelTransport,
} from "../src/data-channel-socket.js";
import { Emitter } from "../src/foundation.js";
import { SocketProtocol } from "../src/protocol.js";

class FakeDataChannel implements DataChannelTransport {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;
  sendError: Error | null = null;
  autoFlush: boolean;
  peer: FakeDataChannel | null = null;

  private readonly messageEmitter = new Emitter<Uint8Array>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly errorEmitter = new Emitter<void>();
  private readonly lowEmitter = new Emitter<void>();

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;
  readonly onError = this.errorEmitter.event;
  readonly onBufferedAmountLow = this.lowEmitter.event;

  constructor(autoFlush = true) {
    this.autoFlush = autoFlush;
  }

  send(data: Uint8Array): void {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push(data.slice());
    if (this.autoFlush) {
      this.bufferedAmount = 0;
    } else {
      this.bufferedAmount += data.byteLength;
    }
    this.peer?.emitMessage(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
  }

  emitMessage(data: Uint8Array): void {
    this.messageEmitter.fire(data);
  }

  emitClose(): void {
    this.readyState = "closed";
    this.closeEmitter.fire();
  }

  emitError(): void {
    this.errorEmitter.fire();
  }

  emitLow(): void {
    this.lowEmitter.fire();
  }

  dispose(): void {
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
    this.errorEmitter.dispose();
    this.lowEmitter.dispose();
  }
}

function createPair(options?: DataChannelSocketOptions) {
  const a = new FakeDataChannel();
  const b = new FakeDataChannel();
  a.peer = b;
  b.peer = a;
  const socketA = createDataChannelSocket(a, options);
  const socketB = createDataChannelSocket(b, options);
  const protocolA = new SocketProtocol(socketA);
  const protocolB = new SocketProtocol(socketB);
  return { a, b, socketA, socketB, protocolA, protocolB };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function expectPending(promise: Promise<void>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
}

async function tick(): Promise<void> {
  await Promise.resolve();
}

test("分片消息经 SocketProtocol 在接收端完整重组", async () => {
  const { a, protocolA, protocolB } = createPair({ chunkSize: 5 });
  const received: Uint8Array[] = [];
  protocolB.onMessage((buffer) => received.push(buffer.buffer.slice()));

  const payload = new Uint8Array(500);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index % 251;
  }
  protocolA.send(VSBuffer.wrap(payload));

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], payload);
  assert.equal(a.sent.length, Math.ceil((payload.byteLength + 13) / 5));
  for (const chunk of a.sent) {
    assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 5);
  }
  await protocolA.drain();
});

test("大 payload 使用默认分片并在协议层还原", async () => {
  const { a, protocolA, protocolB } = createPair();
  const received: Uint8Array[] = [];
  protocolB.onMessage((buffer) => received.push(buffer.buffer.slice()));

  const payload = new Uint8Array(400 * 1024);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 7) % 256;
  }
  protocolA.send(VSBuffer.wrap(payload));

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], payload);
  assert.ok(a.sent.length > 1);
  for (const chunk of a.sent) {
    assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 16 * 1024);
  }
  await protocolA.drain();
});

test("多条消息保持发送顺序", async () => {
  const { protocolA, protocolB } = createPair({ chunkSize: 3 });
  const received: string[] = [];
  protocolB.onMessage((buffer) => received.push(buffer.toString()));

  const messages = Array.from({ length: 40 }, (_, index) => `message-${index}-`.repeat(index + 1));
  for (const message of messages) {
    protocolA.send(VSBuffer.fromString(message));
  }

  assert.deepEqual(received, messages);
  await protocolA.drain();
});

test("高水位暂停，低位事件恢复并完成 drain", async () => {
  const channel = new FakeDataChannel(false);
  const socket = createDataChannelSocket(channel, {
    chunkSize: 2,
    highWaterMark: 4,
    lowWaterMark: 2,
    maxQueuedBytes: 1024,
  });
  assert.equal(channel.bufferedAmountLowThreshold, 2);

  const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
  socket.write(VSBuffer.wrap(payload));
  assert.equal(channel.sent.length, 2);

  socket.write(VSBuffer.wrap(new Uint8Array([7, 8, 9, 10])));
  const drained = socket.drain();
  await expectPending(drained);
  assert.equal(channel.sent.length, 2);

  // 刚回到高水位附近还不算低位，不能恢复发送。
  channel.bufferedAmount = 2;
  channel.emitLow();
  assert.equal(channel.sent.length, 3);

  channel.bufferedAmount = 0;
  channel.emitLow();
  assert.equal(channel.sent.length, 5);
  await expectPending(drained);

  // 本地队列已清空，但发送缓冲仍高于低位阈值，drain 继续等待。
  channel.bufferedAmount = 0;
  channel.emitLow();
  await drained;
  assert.deepEqual(concat(channel.sent), concat([payload, new Uint8Array([7, 8, 9, 10])]));
});

test("暂停期间写入仍使用调用时的字节副本", async () => {
  const channel = new FakeDataChannel(false);
  const socket = createDataChannelSocket(channel, {
    chunkSize: 2,
    highWaterMark: 4,
    lowWaterMark: 2,
    maxQueuedBytes: 64,
  });

  const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const buffer = VSBuffer.wrap(payload);
  socket.write(buffer);
  payload.fill(9);

  channel.bufferedAmount = 0;
  channel.emitLow();
  channel.bufferedAmount = 0;
  channel.emitLow();

  assert.deepEqual(concat(channel.sent), new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test("本地队列超限时失败关闭并拒绝等待中的 drain", async () => {
  const channel = new FakeDataChannel(false);
  const socket = createDataChannelSocket(channel, {
    chunkSize: 2,
    highWaterMark: 4,
    lowWaterMark: 2,
    maxQueuedBytes: 6,
  });
  let closeEvents = 0;
  socket.onClose(() => {
    closeEvents += 1;
  });

  socket.write(VSBuffer.wrap(new Uint8Array(4)));
  const drained = socket.drain();
  await expectPending(drained);

  assert.throws(() => socket.write(VSBuffer.wrap(new Uint8Array(8))), /queue/i);
  assert.equal(closeEvents, 1);
  assert.equal(channel.closeCalls, 1);
  await assert.rejects(drained, /queue/i);
  assert.throws(() => socket.write(VSBuffer.wrap(new Uint8Array(1))));
});

test("通道未 open 时写入不被静默丢弃，而是失败关闭", async () => {
  const channel = new FakeDataChannel();
  channel.readyState = "connecting";
  const socket = createDataChannelSocket(channel);
  let closeEvents = 0;
  socket.onClose(() => {
    closeEvents += 1;
  });

  assert.throws(() => socket.write(VSBuffer.wrap(new Uint8Array(4))), /not open/i);
  assert.equal(closeEvents, 1);
  assert.equal(channel.closeCalls, 1);
  assert.throws(() => socket.write(VSBuffer.wrap(new Uint8Array(4))));
});

test("send 抛错时回收队列、关闭通道并拒绝 drain", async () => {
  const channel = new FakeDataChannel();
  const failure = new Error("channel send failed");
  channel.sendError = failure;
  const socket = createDataChannelSocket(channel);
  let closeEvents = 0;
  socket.onClose(() => {
    closeEvents += 1;
  });

  assert.throws(() => socket.write(VSBuffer.wrap(new Uint8Array(4))), /channel send failed/);
  assert.equal(closeEvents, 1);
  assert.equal(channel.closeCalls, 1);
  await assert.rejects(socket.drain(), /channel send failed/);
});

test("远端关闭会拒绝等待中的 drain", async () => {
  const channel = new FakeDataChannel(false);
  const socket = createDataChannelSocket(channel, {
    chunkSize: 2,
    highWaterMark: 4,
    lowWaterMark: 2,
    maxQueuedBytes: 64,
  });
  let closeEvents = 0;
  socket.onClose(() => {
    closeEvents += 1;
  });

  socket.write(VSBuffer.wrap(new Uint8Array(4)));
  const drained = socket.drain();
  await expectPending(drained);

  channel.emitClose();
  assert.equal(closeEvents, 1);
  await assert.rejects(drained, /closed|close/i);
});

test("SocketProtocol 按 Regular payload 字节计数，不含帧头和 KeepAlive", () => {
  const channelA = new FakeDataChannel();
  const channelB = new FakeDataChannel();
  channelA.peer = channelB;
  channelB.peer = channelA;
  const socketA = createDataChannelSocket(channelA);
  const socketB = createDataChannelSocket(channelB);
  const counts = { sent: 0, received: 0 };
  const protocolA = new SocketProtocol(socketA, {
    onSent: (bytes) => (counts.sent += bytes),
  });
  const protocolB = new SocketProtocol(socketB, {
    onReceived: (bytes) => (counts.received += bytes),
  });
  protocolA.onMessage(() => {});
  protocolB.onMessage(() => {});

  const utf8 = VSBuffer.fromString("连接");
  protocolA.send(utf8);
  protocolA.send(VSBuffer.wrap(new Uint8Array([0, 255, 1])));
  protocolA.sendKeepAlive();

  assert.equal(counts.sent, utf8.byteLength + 3);
  assert.equal(counts.received, utf8.byteLength + 3);
  protocolA.dispose();
  protocolB.dispose();
  socketA.dispose();
  socketB.dispose();
});

test("dispose 幂等、关闭通道并取消订阅", async () => {
  const channel = new FakeDataChannel();
  const socket = createDataChannelSocket(channel);
  let dataEvents = 0;
  socket.onData(() => {
    dataEvents += 1;
  });

  socket.dispose();
  socket.dispose();
  assert.equal(channel.closeCalls, 1);

  channel.emitMessage(new Uint8Array([1, 2, 3]));
  await tick();
  assert.equal(dataEvents, 0);
});
