import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Emitter, VSBuffer, type Event, type ISocket } from "@zcode/rpc";
import type { DataChannelTransport } from "@zcode/rpc";
import {
  createMobileRemoteWebRtcController,
  type MobileRemoteWebRtcController,
} from "../src/host/mobileRemoteControlWebRtc.js";
import {
  WebRtcUnavailableError,
  type WebRtcPeer,
  type WebRtcPeerCallbacks,
} from "../src/host/mobileRemoteControlWebRtcPeer.js";

const RTC_ID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_RTC_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function rtcUrl(id = RTC_ID, path = "/ws/rtc"): string {
  return `${path}?rtcId=${id}`;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSocket implements ISocket {
  private readonly onDataEmitter = new Emitter<VSBuffer>();
  private readonly onCloseEmitter = new Emitter<void>();
  private readonly onEndEmitter = new Emitter<void>();
  readonly writes: string[] = [];
  disposed = false;
  /** 用于断言控制器关闭会话时释放了 onData/onClose 订阅。 */
  activeDataListeners = 0;
  activeCloseListeners = 0;

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
  readonly onEnd = this.onEndEmitter.event;

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

  /** 模拟客户端消息。 */
  receive(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    this.onDataEmitter.fire(VSBuffer.fromString(text));
  }

  receiveRaw(text: string): void {
    this.onDataEmitter.fire(VSBuffer.fromString(text));
  }

  signals(): Array<Record<string, unknown>> {
    return this.writes.map((write) => JSON.parse(write) as Record<string, unknown>);
  }
}

class FakeDataChannel implements DataChannelTransport {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;

  private readonly onMessageEmitter = new Emitter<Uint8Array>();
  private readonly onCloseEmitter = new Emitter<void>();
  private readonly onErrorEmitter = new Emitter<void>();
  private readonly onBufferedEmitter = new Emitter<void>();

  readonly onMessage = this.onMessageEmitter.event;
  readonly onClose = this.onCloseEmitter.event;
  readonly onError = this.onErrorEmitter.event;
  readonly onBufferedAmountLow = this.onBufferedEmitter.event;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
    this.onCloseEmitter.fire();
  }

  receive(data: Uint8Array): void {
    this.onMessageEmitter.fire(data);
  }
}

interface FakePeer extends WebRtcPeer {
  readonly callbacks: WebRtcPeerCallbacks;
  closed: boolean;
  acceptCalls: number;
  readonly offers: string[];
}

type PeerBehavior =
  | { kind: "answer"; answer?: string }
  | { kind: "reject"; error?: Error }
  | { kind: "hang" }
  | { kind: "deferred"; answer: string };

/** 可注入的 peer 工厂，记录创建与关闭，方便断言生命周期。 */
function createPeerHarness(behavior: PeerBehavior = { kind: "answer" }) {
  const peers: FakePeer[] = [];
  let releaseDeferred: (() => void) | undefined;
  const factory = async (callbacks: WebRtcPeerCallbacks): Promise<WebRtcPeer> => {
    const peer: FakePeer = {
      callbacks,
      closed: false,
      acceptCalls: 0,
      offers: [],
      async acceptOffer(sdp: string) {
        peer.acceptCalls += 1;
        peer.offers.push(sdp);
        if (behavior.kind === "reject") {
          throw behavior.error ?? new Error("negotiation failed");
        }
        if (behavior.kind === "hang") {
          return new Promise<string>(() => undefined);
        }
        if (behavior.kind === "deferred") {
          await new Promise<void>((resolve) => {
            releaseDeferred = resolve;
          });
          return behavior.answer;
        }
        return behavior.answer ?? "v=0\r\ns=answer\r\n";
      },
      close() {
        peer.closed = true;
      },
    };
    peers.push(peer);
    return peer;
  };
  return {
    factory,
    peers,
    releaseDeferred: () => releaseDeferred?.(),
  };
}

interface ControllerHarness {
  controller: MobileRemoteWebRtcController;
  peers: FakePeer[];
  dataSockets: ISocket[];
  releaseDeferred: () => void;
}

function createController(
  behavior: PeerBehavior = { kind: "answer" },
  options: {
    negotiationTimeoutMs?: number;
    signalingIdleTimeoutMs?: number;
    maxPeers?: number;
    factory?: (callbacks: WebRtcPeerCallbacks) => Promise<WebRtcPeer>;
    attachDataChannel?: (socket: ISocket) => void;
    logger?: { warn(message: string, details?: Record<string, unknown>): void };
  } = {},
): ControllerHarness {
  const harness = createPeerHarness(behavior);
  const dataSockets: ISocket[] = [];
  const controller = createMobileRemoteWebRtcController({
    createPeer: options.factory ?? harness.factory,
    attachDataChannel:
      options.attachDataChannel ??
      ((socket) => {
        dataSockets.push(socket);
      }),
    logger: options.logger ?? silentLogger,
    ...(options.negotiationTimeoutMs !== undefined
      ? { negotiationTimeoutMs: options.negotiationTimeoutMs }
      : {}),
    ...(options.signalingIdleTimeoutMs !== undefined
      ? { signalingIdleTimeoutMs: options.signalingIdleTimeoutMs }
      : {}),
    ...(options.maxPeers !== undefined ? { maxPeers: options.maxPeers } : {}),
  });
  return {
    controller,
    peers: harness.peers,
    dataSockets,
    releaseDeferred: harness.releaseDeferred,
  };
}

/** 建立一条 fallback 并开一条信令，返回两者。 */
function establishPair(
  controller: MobileRemoteWebRtcController,
  rtcId = RTC_ID,
): { fallback: FakeSocket; signaling: FakeSocket } {
  const fallback = new FakeSocket();
  assert.equal(controller.acceptFallbackConnection(fallback, rtcUrl(rtcId, "/ws")), true);
  const signaling = new FakeSocket();
  controller.acceptSignalingConnection(signaling, rtcUrl(rtcId));
  return { fallback, signaling };
}

/** 完成一次 offer/answer 并接入 DataChannel，模拟 RTC 已经 ready。 */
async function establishReadyRtc(
  harness: ControllerHarness,
  rtcId = RTC_ID,
): Promise<{
  fallback: FakeSocket;
  signaling: FakeSocket;
  channel: FakeDataChannel;
  dataSocket: ISocket;
}> {
  const { fallback, signaling } = establishPair(harness.controller, rtcId);
  signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
  await waitFor(() => signaling.signals().find((signal) => signal.type === "answer"));
  const channel = new FakeDataChannel();
  harness.peers.at(-1)?.callbacks.onDataChannel(channel);
  const dataSocket = harness.dataSockets.at(-1);
  assert.ok(dataSocket, "DataChannel socket was not attached");
  return { fallback, signaling, channel, dataSocket };
}

function pongs(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.signals().filter((signal) => signal.type === "pong");
}

describe("mobile remote WebRTC controller 关联与鉴权", () => {
  it("没有 rtcId 的旧客户端按普通 fallback 接入，不创建 RTC 状态", () => {
    const { controller } = createController();
    const fallback = new FakeSocket();
    assert.equal(controller.acceptFallbackConnection(fallback, "/ws"), true);
    assert.equal(controller.fallbackCount, 0);
    assert.equal(controller.activePeerCount, 0);
  });

  it("非法 rtcId 与重复 fallback 被拒绝，且不覆盖原 fallback", () => {
    const { controller } = createController();
    assert.equal(
      controller.acceptFallbackConnection(new FakeSocket(), "/ws?rtcId=not-a-uuid"),
      false,
    );

    const first = new FakeSocket();
    assert.equal(controller.acceptFallbackConnection(first, rtcUrl()), true);
    const duplicate = new FakeSocket();
    assert.equal(controller.acceptFallbackConnection(duplicate, rtcUrl()), false);
    assert.equal(controller.fallbackCount, 1);

    // 原 fallback 仍能建立信令，重复连接没有把它替换掉。
    const signaling = new FakeSocket();
    controller.acceptSignalingConnection(signaling, rtcUrl());
    assert.equal(signaling.disposed, false);
  });

  it("未知 fallback 的信令返回 unavailable 并关闭", () => {
    const { controller } = createController();
    const signaling = new FakeSocket();
    controller.acceptSignalingConnection(signaling, rtcUrl());
    assert.deepEqual(signaling.signals()[0], {
      version: 1,
      type: "error",
      code: "unavailable",
    });
    assert.equal(signaling.disposed, true);
  });

  it("非法 rtcId 的信令返回 invalid-signal", () => {
    const { controller } = createController();
    const signaling = new FakeSocket();
    controller.acceptSignalingConnection(signaling, "/ws/rtc?rtcId=nope");
    assert.equal(signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
  });

  it("同一 rtcId 的重复信令返回 busy，不影响已建立的关联", () => {
    const { controller } = createController();
    const { signaling } = establishPair(controller);
    const duplicate = new FakeSocket();
    controller.acceptSignalingConnection(duplicate, rtcUrl());
    assert.equal(duplicate.signals()[0]?.code, "busy");
    assert.equal(duplicate.disposed, true);
    assert.equal(signaling.disposed, false);
  });

  it("超过 peer 总数上限返回 busy", () => {
    const { controller } = createController({ kind: "answer" }, { maxPeers: 1 });
    establishPair(controller, RTC_ID);
    const second = establishPair(controller, OTHER_RTC_ID);
    assert.equal(second.signaling.signals()[0]?.code, "busy");
    assert.equal(second.signaling.disposed, true);
  });
});

describe("mobile remote WebRTC controller 信令交换", () => {
  it("一次 offer 得到一次 answer，后续 offer 被拒绝", async () => {
    const harness = createController({ kind: "answer", answer: "v=0 answer-sdp" });
    const { signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer-sdp" });
    const answer = await waitFor(() =>
      signaling.signals().find((signal) => signal.type === "answer"),
    );
    assert.equal(answer.sdp, "v=0 answer-sdp");
    assert.equal(harness.peers.length, 1);
    assert.deepEqual(harness.peers[0]?.offers, ["v=0 offer-sdp"]);

    signaling.receive({ version: 1, type: "offer", sdp: "v=0 second-offer" });
    assert.equal(signaling.signals().at(-1)?.code, "busy");
    assert.equal(harness.peers.length, 1);
  });

  it("非法 JSON、错误 union 与超长 SDP 返回 invalid-signal", async () => {
    const harness = createController();
    const first = establishPair(harness.controller);
    first.signaling.receiveRaw("not json");
    assert.equal(first.signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(first.signaling.disposed, true);

    const second = establishPair(harness.controller, OTHER_RTC_ID);
    second.signaling.receive({ version: 1, type: "offer" });
    assert.equal(second.signaling.signals()[0]?.code, "invalid-signal");

    const third = establishPair(harness.controller, "11111111-2222-4333-8444-555555555555");
    third.signaling.receive({
      version: 1,
      type: "offer",
      sdp: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(third.signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(harness.peers.length, 0);
  });

  it("客户端发 answer/error 视为非法信令", () => {
    const harness = createController();
    const { signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "answer", sdp: "v=0" });
    assert.equal(signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
  });

  it("协商失败只发 error，fallback 仍保持可用", async () => {
    const harness = createController({ kind: "reject" });
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    const error = await waitFor(() => signaling.signals().find((s) => s.type === "error"));
    assert.equal(error.code, "negotiation-failed");
    assert.equal(signaling.disposed, true);
    assert.equal(fallback.disposed, false);
    assert.equal(harness.peers[0]?.closed, true);
  });

  it("缺少 werift 时返回 unavailable，不抛出到 fallback", async () => {
    const harness = createController(
      { kind: "answer" },
      {
        factory: async () => {
          throw new WebRtcUnavailableError("werift missing");
        },
      },
    );
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    const error = await waitFor(() => signaling.signals().find((s) => s.type === "error"));
    assert.equal(error.code, "unavailable");
    assert.equal(fallback.disposed, false);
    assert.equal(signaling.disposed, true);
  });

  it("协商超时回收 peer 与信令，迟到 answer 不写回", async () => {
    const harness = createController(
      { kind: "deferred", answer: "late answer" },
      {
        negotiationTimeoutMs: 30,
      },
    );
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    const error = await waitFor(() => signaling.signals().find((s) => s.type === "error"));
    assert.equal(error.code, "negotiation-failed");
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(fallback.disposed, false);

    harness.releaseDeferred();
    await delay(20);
    assert.equal(signaling.signals().filter((s) => s.type === "answer").length, 0);
  });

  it("等待 offer 超时也会回收信令", async () => {
    const harness = createController({ kind: "answer" }, { signalingIdleTimeoutMs: 20 });
    const { fallback, signaling } = establishPair(harness.controller);
    const error = await waitFor(() => signaling.signals().find((s) => s.type === "error"));
    assert.equal(error.code, "negotiation-failed");
    assert.equal(signaling.disposed, true);
    assert.equal(fallback.disposed, false);
  });

  it("每个 fallback generation 最多尝试一次直连", async () => {
    const harness = createController({ kind: "reject" });
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "error"));

    const retry = new FakeSocket();
    harness.controller.acceptSignalingConnection(retry, rtcUrl());
    assert.equal(retry.signals()[0]?.code, "busy");
    assert.equal(retry.disposed, true);
    assert.equal(fallback.disposed, false);
  });
});

describe("mobile remote WebRTC controller 保活 ping/pong", () => {
  it("RTC ready 后每次 ping 都回 pong，peer 与 DataChannel 保持活跃", async () => {
    const harness = createController({ kind: "answer", answer: "v=0 answer-sdp" });
    const { fallback, signaling, channel, dataSocket } = await establishReadyRtc(harness);

    signaling.receive({ version: 1, type: "ping" });
    signaling.receive({ version: 1, type: "ping" });
    signaling.receive({ version: 1, type: "ping" });

    assert.deepEqual(pongs(signaling), [
      { version: 1, type: "pong" },
      { version: 1, type: "pong" },
      { version: 1, type: "pong" },
    ]);
    assert.equal(
      signaling.signals().filter((signal) => signal.type === "error").length,
      0,
      "ping 不应触发错误信令",
    );
    // 保活不能消耗直连尝试、重启协商或改动 RTC 状态。
    assert.equal(harness.peers.length, 1);
    assert.equal(harness.peers[0]?.acceptCalls, 1);
    assert.equal(harness.peers[0]?.closed, false);
    assert.equal(harness.dataSockets.length, 1);
    assert.equal(harness.dataSockets[0], dataSocket);
    assert.equal(channel.readyState, "open");
    assert.equal(channel.closeCalls, 0);
    // ping 只在信令通道上回应，不能进入 DataChannel/RPC。
    assert.equal(channel.sent.length, 0);
    assert.equal(signaling.disposed, false);
    assert.equal(fallback.disposed, false);
    assert.equal(harness.controller.activePeerCount, 1);

    // 同一 fallback generation 仍不允许第二条信令，ping 没有重置尝试状态。
    const retry = new FakeSocket();
    harness.controller.acceptSignalingConnection(retry, rtcUrl());
    assert.equal(retry.signals()[0]?.code, "busy");
    assert.equal(retry.disposed, true);
  });

  it("协商中（尚未发出 answer）的 ping 视为非法信令", async () => {
    const harness = createController({ kind: "deferred", answer: "late answer" });
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => harness.peers.length === 1);

    signaling.receive({ version: 1, type: "ping" });

    assert.equal(signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(fallback.disposed, false);
    harness.releaseDeferred();
    await delay(20);
    assert.equal(signaling.signals().filter((signal) => signal.type === "answer").length, 0);
  });

  it("等待 offer 阶段的 ping 视为非法信令", () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);

    signaling.receive({ version: 1, type: "ping" });

    assert.equal(signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(harness.peers.length, 0);
    assert.equal(fallback.disposed, false);
  });

  it("answer 已发出但 DataChannel 尚未接入时 ping 被拒绝", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((signal) => signal.type === "answer"));

    signaling.receive({ version: 1, type: "ping" });

    assert.equal(signaling.signals().at(-1)?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(harness.dataSockets.length, 0);
    assert.equal(fallback.disposed, false);
  });

  it("客户端发 pong 在任何阶段都按非法信令拒绝", async () => {
    const harness = createController();
    const { fallback, signaling } = await establishReadyRtc(harness);
    const peer = harness.peers[0];

    signaling.receive({ version: 1, type: "pong" });

    assert.equal(signaling.signals().at(-1)?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(peer?.closed, true);
    assert.equal(fallback.disposed, false);
  });

  it("协商中收到客户端 pong 同样拒绝", async () => {
    const harness = createController({ kind: "deferred", answer: "late answer" });
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => harness.peers.length === 1);

    signaling.receive({ version: 1, type: "pong" });

    assert.equal(signaling.signals()[0]?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(fallback.disposed, false);
    harness.releaseDeferred();
    await delay(20);
    assert.equal(signaling.signals().filter((signal) => signal.type === "answer").length, 0);
  });

  it("非严格 ping payload 不被宽松接受", async () => {
    const harness = createController();
    const { signaling } = await establishReadyRtc(harness);

    // ping 分支是 strict 的：附带额外字段必须拒绝，不能当保活放过。
    signaling.receive({ version: 1, type: "ping", sdp: "v=0 extra" });

    assert.equal(signaling.signals().at(-1)?.code, "invalid-signal");
    assert.equal(signaling.disposed, true);
    assert.equal(pongs(signaling).length, 0);
  });

  it("stop/closeAll 后不再回应 ping", async () => {
    const harness = createController();
    const { signaling } = await establishReadyRtc(harness);
    signaling.receive({ version: 1, type: "ping" });
    assert.equal(pongs(signaling).length, 1);

    harness.controller.closeAll();
    const writesAfterClose = signaling.writes.length;

    signaling.receive({ version: 1, type: "ping" });
    signaling.receive({ version: 1, type: "ping" });

    assert.equal(signaling.writes.length, writesAfterClose, "关闭后不能再写任何信令");
    assert.equal(pongs(signaling).length, 1);
    assert.equal(harness.controller.activePeerCount, 0);
  });
});

describe("mobile remote WebRTC controller 生命周期", () => {
  it("fallback 关闭会作废 peer 与信令", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));
    assert.equal(harness.peers[0]?.closed, false);

    fallback.dispose();
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(signaling.disposed, true);
    assert.equal(harness.controller.fallbackCount, 0);
  });

  it("信令关闭会作废 peer，但保留 fallback", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    signaling.dispose();
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(fallback.disposed, false);
  });

  it("closeAll（stop/resetToken/suspend）回收全部 peer 与信令", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    harness.controller.closeAll();
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(signaling.disposed, true);
    assert.equal(harness.controller.activePeerCount, 0);
    assert.equal(harness.controller.fallbackCount, 0);
    // fallback socket 由 attachment registry 负责关闭，控制器不越权。
    assert.equal(fallback.disposed, false);
  });

  it("关闭后迟到的 peer 工厂结果被就地关闭，不会复活会话", async () => {
    const harness = createController({ kind: "deferred", answer: "late" });
    const { signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => harness.peers.length === 1);

    harness.controller.closeAll();
    // 工厂已经返回 peer；迟到的 acceptOffer 结果不应再发送 answer。
    harness.releaseDeferred();
    await delay(20);
    assert.equal(signaling.signals().filter((s) => s.type === "answer").length, 0);
    assert.equal(harness.peers[0]?.closed, true);
  });
});

describe("mobile remote WebRTC controller DataChannel", () => {
  it("协商完成后接入 DataChannel socket，关闭后回收会话", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    const channel = new FakeDataChannel();
    harness.peers[0]?.callbacks.onDataChannel(channel);
    assert.equal(harness.dataSockets.length, 1);
    const socket = harness.dataSockets[0];
    assert.ok(socket);

    channel.receive(VSBuffer.fromString("hello").buffer);
    let received = "";
    socket.onData((buffer) => {
      received += buffer.toString();
    });
    // onData 只接收订阅之后的帧，这里验证适配器没有把消息吞掉：重新发一帧。
    channel.receive(VSBuffer.fromString("hello").buffer);
    assert.equal(received, "hello");

    channel.close();
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(signaling.disposed, true);
    assert.equal(fallback.disposed, false);
  });

  it("会话关闭后迟到的 DataChannel 立即关闭且不接入", async () => {
    const harness = createController();
    const { signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    harness.controller.closeAll();
    const channel = new FakeDataChannel();
    harness.peers[0]?.callbacks.onDataChannel(channel);
    assert.equal(channel.closeCalls, 1);
    assert.equal(harness.dataSockets.length, 0);
  });
});

describe("mobile remote WebRTC controller 订阅释放", () => {
  it("信令关闭时释放 onData/onClose 订阅", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    assert.equal(signaling.activeDataListeners, 1);
    assert.equal(signaling.activeCloseListeners, 1);

    signaling.dispose();

    assert.equal(signaling.activeDataListeners, 0);
    assert.equal(signaling.activeCloseListeners, 0);
    assert.equal(fallback.disposed, false);
  });

  it("fallback 关闭时释放自身 onClose 订阅", () => {
    const harness = createController();
    const { fallback } = establishPair(harness.controller);
    assert.equal(fallback.activeCloseListeners, 1);

    fallback.dispose();

    assert.equal(fallback.activeCloseListeners, 0);
    assert.equal(harness.controller.fallbackCount, 0);
  });

  it("closeAll 同时释放 fallback 与信令订阅", async () => {
    const harness = createController();
    const { fallback, signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    harness.controller.closeAll();

    assert.equal(fallback.activeCloseListeners, 0);
    assert.equal(signaling.activeDataListeners, 0);
    assert.equal(signaling.activeCloseListeners, 0);
    // fallback socket 由 registry 负责关闭，控制器只释放自己的订阅。
    assert.equal(fallback.disposed, false);
  });
});

describe("mobile remote WebRTC controller 日志", () => {
  it("接入失败的日志不写入底层异常文本（可能包含 SDP）", async () => {
    const logs: string[] = [];
    const harness = createController(
      { kind: "answer" },
      {
        attachDataChannel: () => {
          throw new Error("v=0\r\na=fingerprint:AA:BB:CC secret-token");
        },
        logger: {
          warn: (message, details) => {
            logs.push(`${message} ${JSON.stringify(details ?? {})}`);
          },
        },
      },
    );
    const { signaling } = establishPair(harness.controller);
    signaling.receive({ version: 1, type: "offer", sdp: "v=0 offer" });
    await waitFor(() => signaling.signals().find((s) => s.type === "answer"));

    const channel = new FakeDataChannel();
    harness.peers[0]?.callbacks.onDataChannel(channel);

    assert.ok(logs.length > 0);
    const joined = logs.join("\n");
    assert.equal(joined.includes("fingerprint"), false);
    assert.equal(joined.includes("secret-token"), false);
    assert.equal(joined.includes("v=0"), false);
    // 会话仍按失败路径回收。
    assert.equal(harness.peers[0]?.closed, true);
    assert.equal(signaling.disposed, true);
  });
});
