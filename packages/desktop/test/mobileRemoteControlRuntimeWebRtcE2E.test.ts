/**
 * 手机远控 WebRTC 直连的端到端集成测试（真实 runtime / HTTP / WS / werift）。
 *
 * 覆盖链路：
 * - 真实 `createMobileRemoteControlRuntime` 起 HTTP + Cookie 鉴权；
 * - `ws` 作为浏览器 WebSocket（携带 Cookie/Origin），先建立 /ws fallback；
 * - 经真实 /ws/rtc 端点完成一次带 inline candidate 的 offer/answer（非 trickle）；
 * - Host 与浏览器两侧都用 werift 真实 peer，DataChannel 后走
 *   createDataChannelSocket -> SocketProtocol -> ChannelServer/ChannelClient；
 * - 在 DataChannel 上做双向大 payload RPC；
 * - 主动断开 RTC 后回到仍存活的 fallback；
 * - stop/resetToken 后旧 RTC 通道不能再调用。
 *
 * 所有 socket 由本测试自己创建并在 finally 回收，不启动 Electron/浏览器，也不访问外部网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createDataChannelSocket,
  ProxyChannel,
  type IChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  connectViaWebRtcManaged,
  type RtcDataChannelSocketFactory,
  type RtcPeerConnectionFactory,
  type RtcPeerConnectionLike,
  type WebSocketConnection,
  type WebSocketConnectionOptions,
} from "@zcode/client";
import { ICliProxyQuotaService, ServiceCollection, type IServiceAccessor } from "@zcode/services";
import { createMemoryMobileRemoteControlStateStore } from "@zcode/services/node";
import { RTCPeerConnection } from "werift";
import WsWebSocket from "ws";
import { createMobileRemoteControlRuntime } from "../src/host/mobileRemoteControlService.js";

const TOKEN_COOKIE = "zcode_lite_token";
const RTC_ID = "e7a1c7d2-6f7d-4b7e-9d2a-1f0c3b5a7d91";
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let webRoot: string;

interface SignalCapture {
  signalUrls: string[];
  offers: string[];
  answers: string[];
  pongs: unknown[];
  errors: unknown[];
}

interface EchoService {
  echo(bytes: Uint8Array): Promise<Uint8Array>;
}

interface ClientHarness {
  connection: WebSocketConnection;
  fallbackServices: IServiceAccessor;
  peers: RTCPeerConnection[];
  signals: SignalCapture;
  rtcSocket(): ISocket | undefined;
  signalSocket(): WsWebSocket | undefined;
  bytesToHost(): number;
  bytesToBrowser(): number;
}

function pattern(length: number): Uint8Array {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = index % 251;
  }
  return result;
}

function parseSignal(raw: unknown): { type?: string; sdp?: string } | null {
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else if (ArrayBuffer.isView(raw)) {
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  if (text === null) return null;
  try {
    return JSON.parse(text) as { type?: string; sdp?: string };
  } catch {
    return null;
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  message: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 300ms 只是让“stop 后旧调用必须失败”的失败路径快速暴露，不会把成功等成超时。 */
async function expectRejects(promise: Promise<unknown>, message: string): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000).unref()),
  ]);
  assert.equal(outcome, "rejected", message);
}

function tokenOf(status: { accessUrl?: string }): string {
  assert.ok(status.accessUrl, "accessUrl missing");
  const token = new URL(status.accessUrl).searchParams.get("token");
  assert.ok(token, "token missing");
  return token;
}

function portOf(status: { port?: number }): number {
  assert.ok(status.port, "port missing");
  return status.port;
}

/** 每个测试连接都复用 quota channel 名，这样 client 的 RemoteServiceAccess 能直接建代理。 */
function registerEchoService(server: IChannelServer): void {
  server.registerChannel(
    ICliProxyQuotaService.channelName,
    ProxyChannel.fromService(echoService as unknown as Record<string, unknown>),
  );
}

const echoService: EchoService = {
  async echo(bytes) {
    // 复制一次，确保响应确实由 Host 序列化后重新下发。
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
  },
};

function createRuntime() {
  const services = new ServiceCollection();
  return createMobileRemoteControlRuntime({
    getServices: () => services,
    resolveWebRoot: () => webRoot,
    exposeServices: (server) => {
      registerEchoService(server);
      return () => undefined;
    },
    logger: silentLogger,
    logRpc: () => undefined,
    stateStore: createMemoryMobileRemoteControlStateStore(),
    resolveTunnelBinaryPath: () => undefined,
  });
}

/**
 * 浏览器等价 WebSocket：ws 负责实际连接，Cookie/Origin 由测试显式注入。
 *
 * `binaryType = "arraybuffer"` 是当前 client 信令解析的前置条件；真实浏览器默认
 * blob，这一缺口已单独上报，本测试不修改 client 源码。
 */
function createBrowserWebSocketFactory(
  token: string,
  port: number,
  signals: SignalCapture,
  onSignalSocket: (socket: WsWebSocket) => void,
): WebSocketConnectionOptions["webSocketFactory"] {
  const origin = `http://127.0.0.1:${port}`;
  return (url: string): WebSocket => {
    const socket = new WsWebSocket(url, {
      headers: { cookie: `${TOKEN_COOKIE}=${token}`, origin },
    });
    socket.binaryType = "arraybuffer";

    if (new URL(url).pathname === "/ws/rtc") {
      signals.signalUrls.push(url);
      onSignalSocket(socket);
      socket.addEventListener("message", (event) => {
        const signal = parseSignal(event.data);
        if (signal?.type === "answer" && signal.sdp) {
          signals.answers.push(signal.sdp);
        } else if (signal?.type === "pong") {
          signals.pongs.push(signal);
        } else if (signal?.type === "error") {
          signals.errors.push(signal);
        }
      });
      // 捕获浏览器发出的 offer，验证非 trickle：offer 必须已经带 candidate。
      const originalSend = socket.send.bind(socket);
      socket.send = ((data: unknown, options?: unknown, callback?: unknown) => {
        if (typeof data === "string") {
          const signal = parseSignal(data);
          if (signal?.type === "offer" && signal.sdp) signals.offers.push(signal.sdp);
        }
        return (originalSend as (data: unknown, options?: unknown, callback?: unknown) => void)(
          data,
          options,
          callback,
        );
      }) as typeof socket.send;
    }

    // ws 与浏览器 WebSocket 的结构兼容性由既有 client 测试覆盖，这里只做类型收口。
    return socket as unknown as WebSocket;
  };
}

/** 浏览器侧只用 loopback host candidate，不扫描局域网、不访问 STUN/TURN。 */
function createBrowserPeerFactory(peers: RTCPeerConnection[]): RtcPeerConnectionFactory {
  return () => {
    const peer = new RTCPeerConnection({
      iceServers: [],
      iceAdditionalHostAddresses: ["127.0.0.1"],
      iceUseIpv6: false,
    });
    peers.push(peer);
    return peer as unknown as RtcPeerConnectionLike;
  };
}

async function connectBrowser(port: number, token: string): Promise<ClientHarness> {
  const signals: SignalCapture = {
    signalUrls: [],
    offers: [],
    answers: [],
    pongs: [],
    errors: [],
  };
  const peers: RTCPeerConnection[] = [];
  let rtcSocket: ISocket | undefined;
  let signalSocket: WsWebSocket | undefined;
  let bytesToHost = 0;
  let bytesToBrowser = 0;

  const dataChannelSocketFactory: RtcDataChannelSocketFactory = (transport) => {
    const socket = createDataChannelSocket(transport);
    rtcSocket = socket;
    const write = socket.write.bind(socket);
    socket.write = (buffer) => {
      bytesToHost += buffer.byteLength;
      write(buffer);
    };
    socket.onData((buffer) => {
      bytesToBrowser += buffer.byteLength;
    });
    return socket;
  };

  const connection = await connectViaWebRtcManaged(`ws://127.0.0.1:${port}/ws`, {
    webSocketFactory: createBrowserWebSocketFactory(token, port, signals, (socket) => {
      signalSocket = socket;
    }),
    peerConnectionFactory: createBrowserPeerFactory(peers),
    dataChannelSocketFactory,
    rtcIdFactory: () => RTC_ID,
    cliProxyQuota: true,
    retryDelaysMs: [0],
    initializeTimeoutMs: 15_000,
    negotiationTimeoutMs: 20_000,
  });

  const initial = connection.getSnapshot();
  assert.equal(initial.status, "connected");
  assert.ok(initial.services, "fallback services missing");

  return {
    connection,
    fallbackServices: initial.services,
    peers,
    signals,
    rtcSocket: () => rtcSocket,
    signalSocket: () => signalSocket,
    bytesToHost: () => bytesToHost,
    bytesToBrowser: () => bytesToBrowser,
  };
}

async function waitForRtcServices(client: ClientHarness): Promise<IServiceAccessor> {
  const services = await waitFor(() => {
    const snapshot = client.connection.getSnapshot();
    return snapshot.services && snapshot.services !== client.fallbackServices
      ? snapshot.services
      : undefined;
  }, "RTC services published after Initialize");
  assert.ok(client.rtcSocket(), "RTC DataChannel socket was not created");
  // Initialize 必须先由 Host 经 DataChannel 下发，client 才会发布这套 services。
  assert.ok(client.bytesToBrowser() > 0, "RTC Initialize frame missing");
  return services;
}

async function echoRoundTrip(services: object, payload: Uint8Array): Promise<Uint8Array> {
  const quota = (services as { cliProxyQuotaService?: EchoService }).cliProxyQuotaService;
  assert.ok(quota, "cliProxyQuotaService proxy missing");
  return quota.echo(payload);
}

async function closePeers(peers: readonly RTCPeerConnection[] | undefined): Promise<void> {
  if (!peers) return;
  await Promise.allSettled(peers.map((peer) => peer.close()));
}

before(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-webrtc-e2e-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>mobile</title>");
});

after(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

describe("mobile remote control WebRTC 端到端", () => {
  it(
    "WSS fallback 经 /ws/rtc 升级为 DataChannel RPC，断开后回退原 fallback",
    { timeout: 60_000 },
    async () => {
      const runtime = createRuntime();
      let client: ClientHarness | undefined;
      try {
        const started = await runtime.service.start();
        assert.equal(started.state, "running");
        const token = tokenOf(started);

        client = await connectBrowser(portOf(started), token);
        const rtcServices = await waitForRtcServices(client);

        // 信令：一次 offer、一次 answer，且两边都已内联 ICE candidate（非 trickle）。
        await waitFor(() => (client!.signals.answers.length > 0 ? true : undefined), "answer");
        assert.equal(client.signals.errors.length, 0);
        assert.equal(client.signals.offers.length, 1);
        assert.equal(client.signals.answers.length, 1);
        assert.match(client.signals.offers[0] ?? "", /a=candidate:/);
        assert.match(client.signals.answers[0] ?? "", /a=candidate:/);
        assert.deepEqual(client.signals.signalUrls, [
          `ws://127.0.0.1:${started.port}/ws/rtc?rtcId=${RTC_ID}`,
        ]);

        // RTC 升级后 connectedClients 仍只统计 fallback 这一条逻辑连接。
        assert.equal((await runtime.service.getStatus()).connectedClients, 1);

        // 真实信令链路保活：RTC ready 后每条 ping 都收到 pong，且不会重建协商。
        const signaling = client.signalSocket();
        assert.ok(signaling, "signaling socket missing");
        assert.equal(signaling.readyState, WsWebSocket.OPEN);
        const pongsBefore = client.signals.pongs.length;
        for (let index = 0; index < 3; index += 1) {
          signaling.send(JSON.stringify({ version: 1, type: "ping" }));
        }
        await waitFor(
          () => (client!.signals.pongs.length >= pongsBefore + 3 ? true : undefined),
          "pong replies for pings",
        );
        assert.equal(client.signals.errors.length, 0);
        assert.equal(client.signals.offers.length, 1);
        assert.equal(client.signals.answers.length, 1);
        assert.equal(signaling.readyState, WsWebSocket.OPEN);
        assert.equal(client.peers[0]?.connectionState, "connected");

        const payload = pattern(320 * 1024);
        const echoed = await echoRoundTrip(rtcServices, payload);
        assert.deepEqual(Buffer.from(echoed), Buffer.from(payload));
        assert.ok(
          client.bytesToHost() >= payload.byteLength,
          `request bytes not seen on DataChannel: ${client.bytesToHost()}`,
        );
        assert.ok(
          client.bytesToBrowser() >= payload.byteLength,
          `response bytes not seen on DataChannel: ${client.bytesToBrowser()}`,
        );

        // 模拟浏览器侧 RTC 断开：客户端必须回到原 fallback，且 fallback 仍可承载 RPC。
        const browserPeer = client.peers[0];
        assert.ok(browserPeer, "browser peer missing");
        await browserPeer.close();
        await waitFor(
          () =>
            client!.connection.getSnapshot().services === client!.fallbackServices
              ? true
              : undefined,
          "fallback services restored",
        );

        const fallbackPayload = pattern(96 * 1024);
        const fallbackEcho = await echoRoundTrip(client.fallbackServices, fallbackPayload);
        assert.deepEqual(Buffer.from(fallbackEcho), Buffer.from(fallbackPayload));
        assert.equal((await runtime.service.getStatus()).connectedClients, 1);
      } finally {
        client?.connection.dispose();
        await runtime.service.stop().catch(() => undefined);
        runtime.dispose();
        await closePeers(client?.peers);
      }
    },
  );

  it("stop 与 resetToken 后旧 RTC 通道都不能再调用", { timeout: 90_000 }, async () => {
    const runtime = createRuntime();
    let client: ClientHarness | undefined;
    try {
      const firstStatus = await runtime.service.start();
      assert.equal(firstStatus.state, "running");
      client = await connectBrowser(portOf(firstStatus), tokenOf(firstStatus));
      const firstRtcServices = await waitForRtcServices(client);
      const firstQuota = (firstRtcServices as { cliProxyQuotaService?: EchoService })
        .cliProxyQuotaService;
      assert.ok(firstQuota);
      const firstPayload = pattern(64 * 1024);
      assert.deepEqual(
        Buffer.from(await echoRoundTrip(firstRtcServices, firstPayload)),
        Buffer.from(firstPayload),
      );

      await runtime.service.stop();
      await expectRejects(firstQuota.echo(pattern(1024)), "stop 后旧 RTC 调用必须失败");
      await waitFor(
        () => (client!.peers[0]?.connectionState === "closed" ? true : undefined),
        "browser peer closed after stop",
      );
      client.connection.dispose();
      client = undefined;

      const secondStatus = await runtime.service.start();
      assert.equal(secondStatus.state, "running");
      client = await connectBrowser(portOf(secondStatus), tokenOf(secondStatus));
      const secondRtcServices = await waitForRtcServices(client);
      const secondQuota = (secondRtcServices as { cliProxyQuotaService?: EchoService })
        .cliProxyQuotaService;
      assert.ok(secondQuota);
      const secondPayload = pattern(48 * 1024);
      assert.deepEqual(
        Buffer.from(await echoRoundTrip(secondRtcServices, secondPayload)),
        Buffer.from(secondPayload),
      );

      const resetStatus = await runtime.service.resetToken();
      assert.equal(resetStatus.state, "running");
      assert.notEqual(tokenOf(resetStatus), tokenOf(secondStatus));
      await expectRejects(secondQuota.echo(pattern(1024)), "resetToken 后旧 RTC 调用必须失败");
      client.connection.dispose();
      client = undefined;
    } finally {
      client?.connection.dispose();
      await runtime.service.stop().catch(() => undefined);
      runtime.dispose();
      await closePeers(client?.peers);
    }
  });
});
