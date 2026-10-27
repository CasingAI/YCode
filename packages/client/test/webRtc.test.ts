import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type DataChannelTransport,
  type ISocket,
} from "@zcode/rpc";
import { ISettingService } from "@zcode/services";
import {
  connectViaWebRtcManaged,
  shouldAttemptWebRtcDirect,
  type RtcPeerConnectionLike,
  type WebRtcConnectionOptions,
} from "../src/index.js";
import { createDataChannelTransport, type RtcDataChannelLike } from "../src/webRtcTransport.js";

const RTC_ID = "11111111-1111-4111-8111-111111111111";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: string[] = [];
  /** 模拟底层 socket 已关闭但不再派发 close 事件（超时/异常实现）。 */
  silentClose = false;
  /** 模拟发送阶段抛错（底层已断开但 close 事件尚未到达）。 */
  failSend = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void {
    const wrapped = options?.once
      ? (event: unknown): void => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(wrapped);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.failSend) throw new Error("send failed");
    if (typeof data === "string") this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.silentClose) return;
    this.dispatch("close", { code: 1000, reason: "", wasClean: true });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  receive(bytes: Uint8Array): void {
    this.dispatch("message", { data: bytes.slice().buffer });
  }

  /** 模拟真实浏览器：默认 binaryType="blob" 时二进制帧以 Blob 交付。 */
  receiveBinary(bytes: Uint8Array): void {
    if (this.binaryType === "arraybuffer") {
      this.receive(bytes);
      return;
    }
    this.dispatch("message", { data: new Blob([bytes.slice()]) });
  }

  receiveText(text: string): void {
    this.dispatch("message", { data: text });
  }

  fail(): void {
    this.dispatch("error", {});
    this.close();
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeDataChannel implements RtcDataChannelLike {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  readonly label: string;
  readonly init: { ordered?: boolean } | undefined;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(label: string, init?: { ordered?: boolean }) {
    this.label = label;
    this.init = init;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("data channel is not open");
    this.dispatch("send", { data: data.slice() });
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatch("close", {});
  }

  open(): void {
    this.readyState = "open";
    this.dispatch("open", {});
  }

  receive(bytes: Uint8Array): void {
    this.dispatch("message", { data: bytes.slice().buffer });
  }

  receiveText(text: string): void {
    this.dispatch("message", { data: text });
  }

  receiveBlob(bytes: Uint8Array): void {
    this.dispatch("message", { data: new Blob([bytes.slice()]) });
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakePeerConnection implements RtcPeerConnectionLike {
  static instances: FakePeerConnection[] = [];
  readonly config: RTCConfiguration;
  connectionState = "new";
  iceGatheringState = "new";
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: "answer"; sdp: string } | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  onicegatheringstatechange: ((event: unknown) => void) | null = null;
  readonly channels: FakeDataChannel[] = [];
  /** 测试迟到 setLocalDescription 的结果，验证过期异步建连不会复活。 */
  deferLocalDescription = false;
  private pendingLocalDescription: (() => void) | null = null;

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string, init?: { ordered?: boolean }): FakeDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ type: string; sdp?: string }> {
    return { type: "offer", sdp: "v=0\r\nfake-offer" };
  }

  setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { ...description };
    if (!this.deferLocalDescription) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingLocalDescription = resolve;
    });
  }

  completeLocalDescription(): void {
    const resolve = this.pendingLocalDescription;
    this.pendingLocalDescription = null;
    resolve?.();
  }

  async setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }

  completeIce(): void {
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.({});
  }

  close(): void {
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.onconnectionstatechange?.({});
  }
}

function installFakeWebSocket(): () => void {
  const previousWebSocket = globalThis.WebSocket;
  const previousPeerConnection = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  return () => {
    globalThis.WebSocket = previousWebSocket;
    if (previousPeerConnection === undefined) {
      delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    } else {
      Object.defineProperty(globalThis, "RTCPeerConnection", {
        configurable: true,
        value: previousPeerConnection,
      });
    }
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
  };
}

function attachFallbackServer(
  socket: FakeWebSocket,
  onCall?: (command: string) => void,
): ChannelServer<string> {
  const incoming = new Emitter<VSBuffer>();
  const serverSocket: ISocket = {
    onData: incoming.event,
    onClose: new Emitter<void>().event,
    onEnd: new Emitter<void>().event,
    write(buffer) {
      socket.receive(buffer.buffer);
    },
    end() {
      socket.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      socket.close();
    },
  };
  const protocol = new SocketProtocol(serverSocket);
  const server = new ChannelServer(protocol, "test");
  server.registerChannel(ISettingService.channelName, {
    call: async (_ctx, command) => {
      onCall?.(command);
      return new Promise(() => {});
    },
  });
  socket.addEventListener("send", (event) => {
    const data = (event as { data: string }).data;
    incoming.fire(VSBuffer.wrap(new TextEncoder().encode(data)));
  });
  return server;
}

interface RtcServerOptions {
  /** 延迟发送 Initialize，用于验证客户端 gate。 */
  deferInit?: boolean;
  /** 覆盖默认 call 行为，便于构造在途请求。 */
  handleCall?: (command: string, arg: unknown) => Promise<unknown> | unknown;
}

function attachRtcServer(
  channel: FakeDataChannel,
  result: string,
  options: RtcServerOptions = {},
): ChannelServer<string> {
  const incoming = new Emitter<VSBuffer>();
  const serverSocket: ISocket = {
    onData: incoming.event,
    onClose: new Emitter<void>().event,
    onEnd: new Emitter<void>().event,
    write(buffer) {
      channel.receive(buffer.buffer);
    },
    end() {
      channel.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      channel.close();
    },
  };
  const protocol = new SocketProtocol(serverSocket);
  const server = new ChannelServer(protocol, "rtc-test", 1000, options.deferInit === true);
  server.registerChannel(ISettingService.channelName, {
    call: async (_ctx, command, arg) =>
      options.handleCall ? options.handleCall(command, arg) : result,
  });
  channel.addEventListener("send", (event) => {
    const data = (event as { data: Uint8Array }).data;
    incoming.fire(VSBuffer.wrap(data));
  });
  return server;
}

/** 测试侧模拟 rpc 的 createDataChannelSocket：只做 ISocket 桥接，不重复生产分片逻辑。 */
function createTransportSocket(transport: DataChannelTransport): ISocket {
  const onData = new Emitter<VSBuffer>();
  transport.onMessage((bytes) => onData.fire(VSBuffer.wrap(bytes)));
  return {
    onData: onData.event,
    onClose: transport.onClose,
    onEnd: transport.onClose,
    write(buffer) {
      transport.send(buffer.buffer);
    },
    end() {
      transport.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      transport.close();
      onData.dispose();
    },
  };
}

function waitFor(milliseconds = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isSignalSocket(socket: FakeWebSocket): boolean {
  return new URL(socket.url).pathname === "/ws/rtc";
}

function isFallbackSocket(socket: FakeWebSocket): boolean {
  return !isSignalSocket(socket);
}

interface SentSignal {
  version: number;
  type: string;
  sdp?: string;
}

/** 信令通道同时承载 offer 与 ping；断言时必须按类型区分。 */
function sentSignals(socket: FakeWebSocket): SentSignal[] {
  return socket.sent.map((text) => JSON.parse(text) as SentSignal);
}

function countSent(socket: FakeWebSocket, type: string): number {
  return sentSignals(socket).filter((signal) => signal.type === type).length;
}

interface Harness {
  connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>>;
  fallback: FakeWebSocket;
  signal: FakeWebSocket;
  fallbackServices: NonNullable<ReturnType<Harness["connection"]["getSnapshot"]>["services"]>;
}

async function bootWebRtc(
  options: Partial<WebRtcConnectionOptions> = {},
  hooks: { fallbackOnCall?: (command: string) => void } = {},
): Promise<Harness> {
  const pending = connectViaWebRtcManaged("ws://test/ws", {
    initializeTimeoutMs: 500,
    negotiationTimeoutMs: 500,
    retryDelaysMs: [0],
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    peerConnectionFactory: (config) =>
      new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
    dataChannelSocketFactory: createTransportSocket,
    rtcIdFactory: () => RTC_ID,
    ...options,
  });
  const fallback = FakeWebSocket.instances.find(isFallbackSocket);
  assert.ok(fallback, "fallback WebSocket 应该已创建");
  fallback.open();
  attachFallbackServer(fallback, hooks.fallbackOnCall);
  const connection = await pending;
  const signal = FakeWebSocket.instances.find(isSignalSocket);
  assert.ok(signal, "fallback ready 后应创建信令 WebSocket");
  const fallbackServices = connection.getSnapshot().services;
  assert.ok(fallbackServices);
  return { connection, fallback, signal, fallbackServices };
}

async function completeRtcUpgrade(
  signal: FakeWebSocket,
  peer: FakePeerConnection,
  channel: FakeDataChannel,
  result = "rtc-ok",
): Promise<void> {
  assert.equal(countSent(signal, "offer"), 0, "信令 open 后、ICE 完成前不能发送 offer");
  peer.completeIce();
  await flush();
  assert.equal(countSent(signal, "offer"), 1, "ICE gathering complete 后发送一次 offer");
  const offer = sentSignals(signal).find((item) => item.type === "offer");
  assert.ok(offer);
  assert.equal(offer.version, 1);
  assert.equal(offer.sdp, "v=0\r\nfake-offer");

  attachRtcServer(channel, result);
  // Host 通过同一受保护端点的二进制帧发送 answer；这里按真实浏览器语义交付。
  signal.receiveBinary(
    new TextEncoder().encode(
      JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" }),
    ),
  );
  await flush();
  assert.deepEqual(peer.remoteDescription, { type: "answer", sdp: "v=0\r\nfake-answer" });

  channel.open();
  await flush();
  await flush();
}

interface ReadyRtcHarness extends Harness {
  peer: FakePeerConnection;
  channel: FakeDataChannel;
  rtcGeneration: number;
}

async function bootReadyRtc(
  options: Partial<WebRtcConnectionOptions> = {},
): Promise<ReadyRtcHarness> {
  const harness = await bootWebRtc(options);
  const { connection, signal } = harness;
  signal.open();
  await flush();
  const peer = FakePeerConnection.instances[0];
  assert.ok(peer);
  const channel = peer.channels[0];
  assert.ok(channel);
  await completeRtcUpgrade(signal, peer, channel);
  assert.notEqual(connection.getSnapshot().services, harness.fallbackServices);
  return {
    ...harness,
    peer,
    channel,
    rtcGeneration: connection.getSnapshot().generation,
  };
}

test("能力开关要求 capability、非 remote、安全上下文与 RTCPeerConnection 同时满足", () => {
  assert.equal(
    shouldAttemptWebRtcDirect({
      capability: true,
      isRemoteRoute: false,
      isSecureContext: true,
      hasPeerConnection: true,
    }),
    true,
  );
  assert.equal(
    shouldAttemptWebRtcDirect({
      capability: false,
      isRemoteRoute: false,
      isSecureContext: true,
      hasPeerConnection: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptWebRtcDirect({
      capability: true,
      isRemoteRoute: true,
      isSecureContext: true,
      hasPeerConnection: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptWebRtcDirect({
      capability: true,
      isRemoteRoute: false,
      isSecureContext: false,
      hasPeerConnection: true,
    }),
    false,
  );
  assert.equal(
    shouldAttemptWebRtcDirect({
      capability: true,
      isRemoteRoute: false,
      isSecureContext: true,
      hasPeerConnection: false,
    }),
    false,
  );
});

test("缺少浏览器 peer 实现时不创建 rtcId、信令或 peer，只保留原 WSS", async () => {
  const restore = installFakeWebSocket();
  try {
    const pending = connectViaWebRtcManaged("ws://test/ws", {
      initializeTimeoutMs: 500,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const fallback = FakeWebSocket.instances[0];
    assert.ok(fallback);
    assert.equal(new URL(fallback.url).searchParams.get("rtcId"), null);
    fallback.open();
    attachFallbackServer(fallback);
    const connection = await pending;
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 0);
    assert.equal(FakePeerConnection.instances.length, 0);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "disabled",
      endpoint: "ws://test",
    });
    connection.dispose();
  } finally {
    restore();
  }
});

test("rtcIdFactory 抛错导致无法生成 id 时保持 disabled，不创建信令或 peer", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const pending = connectViaWebRtcManaged("ws://test/ws", {
      initializeTimeoutMs: 500,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      peerConnectionFactory: (config) =>
        new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
      dataChannelSocketFactory: createTransportSocket,
      rtcIdFactory: () => {
        throw new Error("no secure random");
      },
    });
    const fallback = FakeWebSocket.instances[0];
    assert.ok(fallback);
    // 有效的临时 id 是直连前提；生成失败时不能携带或补发 rtcId。
    assert.equal(new URL(fallback.url).searchParams.get("rtcId"), null);
    fallback.open();
    attachFallbackServer(fallback);
    connection = await pending;
    await waitFor();
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "disabled",
      endpoint: "ws://test",
    });
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 0);
    assert.equal(FakePeerConnection.instances.length, 0);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("rtcIdFactory 返回空 id 时保持 disabled，不创建信令或 peer", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const pending = connectViaWebRtcManaged("ws://test/ws", {
      initializeTimeoutMs: 500,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      peerConnectionFactory: (config) =>
        new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
      dataChannelSocketFactory: createTransportSocket,
      rtcIdFactory: () => "",
    });
    const fallback = FakeWebSocket.instances[0];
    assert.ok(fallback);
    assert.equal(new URL(fallback.url).searchParams.get("rtcId"), null);
    fallback.open();
    attachFallbackServer(fallback);
    connection = await pending;
    await waitFor();
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "disabled",
      endpoint: "ws://test",
    });
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 0);
    assert.equal(FakePeerConnection.instances.length, 0);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("首屏先返回 fallback ready，后台才建立同 rtcId 的信令连接", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallback, signal, fallbackServices } = await bootWebRtc();
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().services, fallbackServices);

    const fallbackUrl = new URL(fallback.url);
    assert.equal(fallbackUrl.pathname, "/ws");
    assert.equal(fallbackUrl.searchParams.get("rtcId"), RTC_ID);
    const signalUrl = new URL(signal.url);
    assert.equal(signalUrl.pathname, "/ws/rtc");
    assert.equal(signalUrl.searchParams.get("rtcId"), RTC_ID);
    assert.equal(signal.url, `ws://test/ws/rtc?rtcId=${RTC_ID}`);
    // 不设置 arraybuffer 时浏览器会把二进制信令包装成 Blob，同步解析必然失败。
    assert.equal(signal.binaryType, "arraybuffer");

    // 信令未 open 时不创建 peer，也不发送任何信令。
    assert.equal(FakePeerConnection.instances.length, 0);
    assert.equal(signal.sent.length, 0);
    connection.dispose();
  } finally {
    restore();
  }
});

test("DataChannel 与 RPC Initialize 完成后才发布新代 services，调用真实走 RTC", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    const initialGeneration = connection.getSnapshot().generation;
    // fallback ready、信令尚未 open：业务仍走 WSS，直连在连接中。
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "connecting",
      endpoint: "ws://test",
    });

    signal.open();
    await flush();
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "connecting",
      endpoint: "ws://test",
    });
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    assert.deepEqual(peer.config.iceServers, []);
    const channel = peer.channels[0];
    assert.ok(channel);
    assert.equal(channel.label, "zcode-rpc");
    assert.deepEqual(channel.init, { ordered: true });
    assert.equal(channel.binaryType, "arraybuffer");

    peer.completeIce();
    await flush();
    assert.equal(countSent(signal, "offer"), 1);

    // 收到 answer 但 DataChannel 尚未 open / Initialize 前，仍然发布 fallback。
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" }));
    await flush();
    assert.equal(connection.getSnapshot().services, fallbackServices);

    attachRtcServer(channel, "rtc-ok");
    channel.open();
    await flush();
    await flush();

    const upgraded = connection.getSnapshot();
    assert.equal(upgraded.status, "connected");
    assert.notEqual(upgraded.services, fallbackServices);
    assert.ok(upgraded.generation > initialGeneration);
    assert.deepEqual(upgraded.connectionInfo, {
      transport: "webrtc",
      directState: "connected",
      endpoint: "ws://test",
    });
    const result = await upgraded.services?.settingService.get();
    assert.equal(result, "rtc-ok");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("connectionInfo 在 Initialize 前保持 connecting，endpoint 只发布脱敏 origin", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const pending = connectViaWebRtcManaged(
      "wss://alice:secret@test:9443/ws?token=abc&rtcId=xyz&remote=1#frag",
      {
        initializeTimeoutMs: 500,
        negotiationTimeoutMs: 500,
        retryDelaysMs: [0],
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
        peerConnectionFactory: (config) =>
          new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
        dataChannelSocketFactory: createTransportSocket,
        rtcIdFactory: () => RTC_ID,
      },
    );
    const fallback = FakeWebSocket.instances.find(isFallbackSocket);
    assert.ok(fallback);
    fallback.open();
    attachFallbackServer(fallback);
    connection = await pending;
    const fallbackServices = connection.getSnapshot().services;
    assert.ok(fallbackServices);

    const expectedBase = {
      transport: "websocket",
      directState: "connecting",
      endpoint: "wss://test:9443",
    } as const;
    assert.deepEqual(connection.getSnapshot().connectionInfo, expectedBase);

    const signal = FakeWebSocket.instances.find(isSignalSocket);
    assert.ok(signal);
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);

    peer.completeIce();
    await flush();
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" }));
    await flush();
    const server = attachRtcServer(channel, "rtc-ok", { deferInit: true });
    channel.open();
    await flush();
    await flush();

    // DataChannel 已 open 但 Initialize 未完成：仍不能显示 RTC 已生效。
    assert.equal(connection.getSnapshot().services, fallbackServices);
    assert.deepEqual(connection.getSnapshot().connectionInfo, expectedBase);

    server.ready();
    await flush();
    await flush();
    assert.notEqual(connection.getSnapshot().services, fallbackServices);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "webrtc",
      directState: "connected",
      endpoint: "wss://test:9443",
    });
    const serialized = JSON.stringify(connection.getSnapshot().connectionInfo);
    for (const secret of ["alice", "secret", "/ws", "token", "rtcId", "remote", "frag"]) {
      assert.equal(serialized.includes(secret), false, `连接信息不能包含 ${secret}`);
    }
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC 失败不影响 fallback，且同一 fallback 代只尝试一次", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallbackServices, signal } = await bootWebRtc();
    const before = connection.getSnapshot();
    assert.deepEqual(before.connectionInfo, {
      transport: "websocket",
      directState: "connecting",
      endpoint: "ws://test",
    });
    signal.fail();
    await flush();
    await waitFor(20);
    const after = connection.getSnapshot();
    assert.equal(after.status, "connected");
    assert.equal(after.services, fallbackServices);
    // 直连状态变化只更新信息，不产生新的 services 代次或重放。
    assert.equal(after.generation, before.generation);
    assert.equal(after.services, before.services);
    assert.deepEqual(after.connectionInfo, {
      transport: "websocket",
      directState: "fallback",
      endpoint: "ws://test",
    });
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 1);
    assert.equal(FakePeerConnection.instances.length, 0);
    connection.dispose();
  } finally {
    restore();
  }
});

test("协商超时有界失败，不重试同代也不影响 WSS", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallbackServices, signal } = await bootWebRtc({ negotiationTimeoutMs: 20 });
    // 故意不 open 信令，等待有界超时。
    await waitFor(60);
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().services, fallbackServices);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "fallback",
      endpoint: "ws://test",
    });
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 1);
    connection.dispose();
  } finally {
    restore();
  }
});

test("RTC DataChannel 关闭立即切回存活 WSS 且 generation 单调递增", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);
    await completeRtcUpgrade(signal, peer, channel);
    const rtcGeneration = connection.getSnapshot().generation;
    assert.notEqual(connection.getSnapshot().services, fallbackServices);

    channel.close();
    await flush();
    const after = connection.getSnapshot();
    assert.equal(after.status, "connected");
    assert.equal(after.services, fallbackServices);
    assert.ok(after.generation > rtcGeneration);
    assert.deepEqual(after.connectionInfo, {
      transport: "websocket",
      directState: "fallback",
      endpoint: "ws://test",
    });
  } finally {
    connection?.dispose();
    restore();
  }
});

test("fallback 换代销毁旧 peer/信令，迟到回调不能复活旧 RTC，新代可再次尝试", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { fallback, fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const oldPeer = FakePeerConnection.instances[0];
    assert.ok(oldPeer);
    const oldChannel = oldPeer.channels[0];
    assert.ok(oldChannel);
    await completeRtcUpgrade(signal, oldPeer, oldChannel);
    assert.notEqual(connection.getSnapshot().services, fallbackServices);

    fallback.close();
    await flush();
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(oldPeer.connectionState, "closed");
    assert.equal(oldChannel.readyState, "closed");
    assert.equal(connection.getSnapshot().status, "reconnecting");
    assert.equal(connection.getSnapshot().services, null);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: null,
      directState: "waiting",
      endpoint: "ws://test",
    });

    await waitFor(10);
    const nextFallback = FakeWebSocket.instances.filter(isFallbackSocket)[1];
    assert.ok(nextFallback);
    nextFallback.open();
    attachFallbackServer(nextFallback);
    await flush();

    assert.equal(connection.getSnapshot().status, "connected");
    assert.ok(connection.getSnapshot().services);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "connecting",
      endpoint: "ws://test",
    });
    const signals = FakeWebSocket.instances.filter(isSignalSocket);
    assert.equal(signals.length, 2, "新 fallback 代应重新尝试一次");

    // 旧信令/旧通道的迟到回调必须被忽略。
    const oldRemoteDescription = oldPeer.remoteDescription;
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nlate" }));
    oldChannel.open();
    await flush();
    assert.deepEqual(oldPeer.remoteDescription, oldRemoteDescription);
    assert.equal(oldPeer.remoteDescription?.sdp, "v=0\r\nfake-answer");
    assert.ok(connection.getSnapshot().services);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: "websocket",
      directState: "connecting",
      endpoint: "ws://test",
    });
  } finally {
    connection?.dispose();
    restore();
  }
});

test("fallback 在 RTC ready 前断开时立即销毁 peer 与信令", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallback, signal } = await bootWebRtc();
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    fallback.close();
    await flush();
    assert.equal(peer.connectionState, "closed");
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().services, null);
    connection.dispose();
  } finally {
    restore();
  }
});

test("重复 answer 或异常信令有界失败，不回写 RTC services", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallbackServices, signal } = await bootWebRtc();
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);
    peer.completeIce();
    await flush();

    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfirst" }));
    await flush();
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nsecond" }));
    await flush();
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().services, fallbackServices);
    connection.dispose();
  } finally {
    restore();
  }
});

test("非法 SDP 超限/未知版本被拒绝", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallbackServices, signal } = await bootWebRtc();
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    peer.completeIce();
    await flush();

    const hugeSdp = "x".repeat(256 * 1024 + 1);
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: hugeSdp }));
    await flush();
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().services, fallbackServices);
    connection.dispose();
  } finally {
    restore();
  }
});

test("dispose 回收 fallback、信令、peer、DataChannel 与 client", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallback, signal } = await bootWebRtc();
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);

    connection.dispose();
    assert.equal(fallback.readyState, FakeWebSocket.CLOSED);
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(peer.connectionState, "closed");
    assert.equal(channel.readyState, "closed");
    assert.equal(connection.getSnapshot().status, "closed");
    assert.equal(connection.getSnapshot().services, null);
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: null,
      directState: "waiting",
      endpoint: "ws://test",
    });

    await flush();
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
  } finally {
    restore();
  }
});

test("默认使用 rpc createDataChannelSocket：Initialize 前不升级，分片承载大 payload", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    // 不注入 dataChannelSocketFactory，验证生产默认使用 rpc 的公开适配。
    const harness = await bootWebRtc({ dataChannelSocketFactory: undefined });
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);

    peer.completeIce();
    await flush();
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" }));
    await flush();

    channel.open();
    await flush();
    await flush();
    // DataChannel 已 open 但服务端还没发 Initialize：必须继续挂 fallback。
    assert.equal(connection.getSnapshot().services, fallbackServices);

    let updateArg: unknown;
    const server = attachRtcServer(channel, "rtc-ok", {
      deferInit: true,
      handleCall: (command, arg) => {
        if (command === "update") updateArg = arg;
        return "rtc-ok";
      },
    });
    await flush();
    assert.equal(
      connection.getSnapshot().services,
      fallbackServices,
      "Initialize 前不能发布 RTC 服务",
    );

    server.ready();
    await flush();
    await flush();
    const upgraded = connection.getSnapshot();
    assert.notEqual(upgraded.services, fallbackServices);

    const chunks: number[] = [];
    channel.addEventListener("send", (event) => {
      chunks.push((event as { data: Uint8Array }).data.byteLength);
    });
    const big = "x".repeat(100_000);
    await upgraded.services?.settingService.update({ recentProjects: [big] });
    await flush();
    assert.equal(
      (updateArg as [{ recentProjects: string[] }])[0].recentProjects[0].length,
      big.length,
      "大 payload 必须完整跨分片重组",
    );
    assert.ok(chunks.length > 1, "大 payload 必须被分片");
    assert.ok(
      chunks.every((size) => size <= 16 * 1024),
      "单条 DataChannel 消息不能超过 rpc 适配的默认分片大小",
    );
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC 失效拒绝在途调用且不把它重放到 fallback", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    let fallbackGetCalls = 0;
    let resolveRtcGet: ((value: string) => void) | null = null;
    const rtcGet = new Promise<string>((resolve) => {
      resolveRtcGet = resolve;
    });
    const harness = await bootWebRtc(
      {},
      {
        fallbackOnCall: (command) => {
          if (command === "get") fallbackGetCalls += 1;
        },
      },
    );
    connection = harness.connection;
    const { fallback, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);
    peer.completeIce();
    await flush();
    attachRtcServer(channel, "rtc-ok", { handleCall: () => rtcGet });
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" }));
    await flush();
    channel.open();
    await flush();
    await flush();

    const upgraded = connection.getSnapshot();
    assert.notEqual(upgraded.services, harness.fallbackServices);
    const pending = upgraded.services?.settingService.get();
    assert.ok(pending);
    // 先挂 rejection handler，再触发断线，避免测试进程把预期失败当作未处理拒绝。
    const settled = pending.then(
      () => assert.fail("RTC 失效后挂起调用必须 reject"),
      (error: Error) => error,
    );
    await flush();

    // fallback 断开立即作废 RTC；在途调用必须失败，不能转到 fallback 重放。
    fallback.close();
    await flush();
    const rejection = await settled;
    assert.equal(rejection.name, "ConnectionClosed");

    await waitFor(10);
    const nextFallback = FakeWebSocket.instances.filter(isFallbackSocket)[1];
    assert.ok(nextFallback);
    nextFallback.open();
    attachFallbackServer(nextFallback, (command) => {
      if (command === "get") fallbackGetCalls += 1;
    });
    await flush();
    assert.equal(fallbackGetCalls, 0, "在途调用不能自动重放到新 attachment");
    assert.equal(connection.getSnapshot().status, "connected");
    assert.ok(connection.getSnapshot().generation > upgraded.generation);
    const reconnectedServices = connection.getSnapshot().services;
    assert.ok(reconnectedServices);
    assert.notEqual(reconnectedServices, harness.fallbackServices);

    resolveRtcGet?.("late");
    await flush();
    // 迟到的 RTC 响应不能重新发布旧 attachment。
    assert.equal(connection.getSnapshot().services, reconnectedServices);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("协商超时后迟到的 ICE/answer/open 不能复活 RTC", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc({ negotiationTimeoutMs: 20 });
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);

    await waitFor(60);
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);

    peer.completeIce();
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nlate" }));
    channel.open();
    await flush();
    await flush();

    assert.equal(connection.getSnapshot().services, fallbackServices);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("fallback 换代时迟到的 setLocalDescription 不能发送 offer 或复活旧 RTC", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc({
      peerConnectionFactory: (config) => {
        const peer = new FakePeerConnection(config);
        peer.deferLocalDescription = true;
        return peer as unknown as RtcPeerConnectionLike;
      },
    });
    connection = harness.connection;
    const { fallback, signal } = harness;
    signal.open();
    await flush();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    assert.equal(peer.localDescription?.type, "offer");

    fallback.close();
    await flush();
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(peer.connectionState, "closed");
    assert.equal(connection.getSnapshot().status, "reconnecting");
    assert.equal(connection.getSnapshot().services, null);

    peer.completeLocalDescription();
    await flush();
    await flush();
    assert.equal(countSent(signal, "offer"), 0, "过期 setLocalDescription 不能补发 offer");
    assert.equal(connection.getSnapshot().services, null);
    assert.equal(connection.getSnapshot().status, "reconnecting");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC ready 后信令关闭立即回收 peer 并回退 fallback", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);
    await completeRtcUpgrade(signal, peer, channel);
    const rtcGeneration = connection.getSnapshot().generation;
    assert.notEqual(connection.getSnapshot().services, fallbackServices);

    signal.close();
    await flush();
    assert.equal(peer.connectionState, "closed");
    assert.equal(channel.readyState, "closed");
    assert.equal(connection.getSnapshot().services, fallbackServices);
    assert.ok(connection.getSnapshot().generation > rtcGeneration);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("dispose 后迟到 ICE/answer/open 不复活 RTC，也不创建新资源", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, fallback, signal } = await bootWebRtc();
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    const channel = peer.channels[0];
    assert.ok(channel);

    connection.dispose();
    const disposedGeneration = connection.getSnapshot().generation;
    peer.completeIce();
    signal.receiveText(JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nlate" }));
    channel.open();
    await flush();
    await waitFor(10);

    assert.equal(fallback.readyState, FakeWebSocket.CLOSED);
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(peer.connectionState, "closed");
    assert.equal(connection.getSnapshot().status, "closed");
    assert.equal(connection.getSnapshot().services, null);
    assert.equal(connection.getSnapshot().generation, disposedGeneration);
    assert.equal(FakeWebSocket.instances.filter(isSignalSocket).length, 1);
    assert.equal(FakePeerConnection.instances.length, 1);
  } finally {
    restore();
  }
});

test("DataChannel transport 负责 DOM 事件到二进制/关闭事件的转换", () => {
  const channel = new FakeDataChannel("test", { ordered: true });
  channel.readyState = "open";
  const transport = createDataChannelTransport(channel);
  assert.equal(channel.binaryType, "arraybuffer");

  const messages: Uint8Array[] = [];
  let closes = 0;
  transport.onMessage((bytes) => messages.push(bytes));
  transport.onClose(() => {
    closes += 1;
  });

  channel.receive(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...messages[0]], [1, 2, 3]);

  transport.send(new Uint8Array([9]));
  assert.equal(channel.bufferedAmount, 0);
  channel.close();
  assert.equal(closes, 1);
  // close 后四个 DOM listener 都必须摘除，不能只 dispose Emitter。
  assert.equal(channel.listenerCount("message"), 0);
  assert.equal(channel.listenerCount("close"), 0);
  assert.equal(channel.listenerCount("error"), 0);
  assert.equal(channel.listenerCount("bufferedamountlow"), 0);
});

test("DataChannel transport 对文本/Blob 非法载荷 fail-closed，不把残帧交给 RPC", () => {
  for (const kind of ["text", "blob"] as const) {
    const channel = new FakeDataChannel("test");
    channel.readyState = "open";
    const transport = createDataChannelTransport(channel);
    const messages: Uint8Array[] = [];
    let errors = 0;
    let closes = 0;
    transport.onMessage((bytes) => messages.push(bytes));
    transport.onError(() => {
      errors += 1;
    });
    transport.onClose(() => {
      closes += 1;
    });

    if (kind === "text") {
      channel.receiveText("not-binary");
    } else {
      channel.receiveBlob(new Uint8Array([1, 2, 3]));
    }

    assert.equal(messages.length, 0, `${kind} 载荷不能进入 SocketProtocol`);
    assert.equal(errors, 1, `${kind} 载荷必须触发 onError`);
    // 错误路径主动关闭通道；Detach 后的 close 不再派发 onClose。
    assert.equal(channel.readyState, "closed");
    assert.equal(closes, 0);
    for (const type of ["message", "close", "error", "bufferedamountlow"]) {
      assert.equal(channel.listenerCount(type), 0, `${kind} 载荷后应摘除 ${type} listener`);
    }
  }
});

test("每条物理 fallback 生成独立 rtcId，换代后的新信令不复用旧 id", async () => {
  const restore = installFakeWebSocket();
  const secondRtcId = "22222222-2222-4222-8222-222222222222";
  let nextRtcId = RTC_ID;
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const pending = connectViaWebRtcManaged("ws://test/ws", {
      initializeTimeoutMs: 500,
      negotiationTimeoutMs: 500,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      peerConnectionFactory: (config) =>
        new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
      dataChannelSocketFactory: createTransportSocket,
      rtcIdFactory: () => nextRtcId,
    });
    const firstFallback = FakeWebSocket.instances.find(isFallbackSocket);
    assert.ok(firstFallback);
    firstFallback.open();
    attachFallbackServer(firstFallback);
    connection = await pending;
    const firstSignal = FakeWebSocket.instances.find(isSignalSocket);
    assert.ok(firstSignal);
    assert.equal(new URL(firstFallback.url).searchParams.get("rtcId"), RTC_ID);
    assert.equal(new URL(firstSignal.url).searchParams.get("rtcId"), RTC_ID);

    // 旧 server 仍持有第一 rtcId 时 client 换代；新 fallback 必须换新 id，
    // 否则会被 Host 当作重复占用拒绝。
    nextRtcId = secondRtcId;
    firstFallback.close();
    await flush();
    await waitFor(10);
    const secondFallback = FakeWebSocket.instances.filter(isFallbackSocket)[1];
    assert.ok(secondFallback);
    const secondFallbackId = new URL(secondFallback.url).searchParams.get("rtcId");
    assert.equal(secondFallbackId, secondRtcId);
    assert.notEqual(secondFallbackId, RTC_ID);

    secondFallback.open();
    attachFallbackServer(secondFallback);
    await flush();
    const signals = FakeWebSocket.instances.filter(isSignalSocket);
    assert.equal(signals.length, 2, "新 fallback 代应新建信令连接");
    assert.equal(new URL(signals[1].url).searchParams.get("rtcId"), secondRtcId);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("dispose 注销 waitForSignalOpen 的 open/error/close 监听，即使 socket 不再派发 close", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { signal } = harness;
    // 模拟超时/异常实现：socket 已被关闭，但永远不再派发 close。
    signal.silentClose = true;
    assert.equal(signal.listenerCount("open"), 1);
    assert.equal(signal.listenerCount("error"), 1);
    assert.equal(signal.listenerCount("close"), 1);

    connection.dispose();

    assert.equal(signal.listenerCount("open"), 0);
    assert.equal(signal.listenerCount("error"), 0);
    assert.equal(signal.listenerCount("close"), 0);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("协商超时也注销 waitForSignalOpen 监听，不依赖 close 事件", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc({ negotiationTimeoutMs: 20 });
    connection = harness.connection;
    const { signal } = harness;
    signal.silentClose = true;
    await waitFor(60);

    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(signal.listenerCount("open"), 0);
    assert.equal(signal.listenerCount("error"), 0);
    assert.equal(signal.listenerCount("close"), 0);
    assert.ok(connection.getSnapshot().services, "超时后 fallback 必须继续可用");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC ready 后按间隔发送 ping，有效 pong 不改变 RTC 代", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootReadyRtc({ signalingHeartbeatMs: 15 });
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    await waitFor(80);

    const pings = sentSignals(signal).filter((item) => item.type === "ping");
    assert.ok(pings.length >= 3, `ready 后应持续发送 ping，实际 ${pings.length} 次`);
    assert.ok(pings.every((ping) => ping.version === 1));
    // 心跳不能影响 offer/answer 的单次语义。
    assert.equal(countSent(signal, "offer"), 1);
    assert.equal(countSent(signal, "answer"), 0);

    const before = connection.getSnapshot();
    signal.receiveText(JSON.stringify({ version: 1, type: "pong" }));
    await flush();

    const after = connection.getSnapshot();
    assert.equal(after.generation, before.generation, "pong 不能发布新 generation");
    assert.equal(after.services, before.services, "pong 不能替换 RTC services");
    assert.equal(after.status, "connected");
    assert.notEqual(after.services, fallbackServices);
    assert.equal(signal.readyState, FakeWebSocket.OPEN);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("协商阶段收到 pong 被拒绝，不当作 answer", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootWebRtc();
    connection = harness.connection;
    const { fallbackServices, signal } = harness;
    signal.open();
    await flush();
    const peer = FakePeerConnection.instances[0];
    assert.ok(peer);
    peer.completeIce();
    await flush();
    assert.equal(countSent(signal, "offer"), 1);

    signal.receiveText(JSON.stringify({ version: 1, type: "pong" }));
    await flush();

    assert.equal(peer.remoteDescription, null, "pong 不能被当作 answer 应用");
    assert.equal(peer.connectionState, "closed");
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().services, fallbackServices);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC ready 后收到对端 ping 被拒绝并回退，不回复 pong", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootReadyRtc({ signalingHeartbeatMs: 50 });
    connection = harness.connection;
    const { fallbackServices, peer, signal } = harness;

    signal.receiveText(JSON.stringify({ version: 1, type: "ping" }));
    await flush();

    assert.equal(peer.connectionState, "closed");
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().services, fallbackServices);
    assert.equal(countSent(signal, "pong"), 0);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("RTC ready 后 dispose 停止信令心跳，不再发送 ping", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootReadyRtc({ signalingHeartbeatMs: 10 });
    connection = harness.connection;
    const { signal } = harness;
    await waitFor(35);
    assert.ok(countSent(signal, "ping") >= 2);

    connection.dispose();
    const sentAtDispose = signal.sent.length;
    await waitFor(40);
    assert.equal(signal.sent.length, sentAtDispose, "dispose 后不能残留心跳计时器");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("心跳发送抛错立即回退 WSS，并停止后续 ping", async () => {
  const restore = installFakeWebSocket();
  let connection: Awaited<ReturnType<typeof connectViaWebRtcManaged>> | null = null;
  try {
    const harness = await bootReadyRtc({ signalingHeartbeatMs: 10 });
    connection = harness.connection;
    const { fallbackServices, peer, signal } = harness;
    signal.failSend = true;
    await waitFor(35);

    assert.equal(peer.connectionState, "closed");
    assert.equal(signal.readyState, FakeWebSocket.CLOSED);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().services, fallbackServices);

    const sentAfterFailure = signal.sent.length;
    await waitFor(30);
    assert.equal(signal.sent.length, sentAfterFailure, "失败后不能继续发送 ping");
  } finally {
    connection?.dispose();
    restore();
  }
});
