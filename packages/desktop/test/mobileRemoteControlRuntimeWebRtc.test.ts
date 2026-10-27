import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { Emitter, type DataChannelTransport } from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";
import type { MobileRemoteControlStatus } from "@zcode/services";
import { createMemoryMobileRemoteControlStateStore } from "@zcode/services/node";
import { createMobileRemoteControlRuntime } from "../src/host/mobileRemoteControlService.js";
import type { WebRtcPeer, WebRtcPeerCallbacks } from "../src/host/mobileRemoteControlWebRtcPeer.js";

const TOKEN_COOKIE = "zcode_lite_token";
const RTC_ID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let webRoot: string;

interface PeerRecord {
  peer: WebRtcPeer;
  callbacks: WebRtcPeerCallbacks;
  closed: boolean;
  offers: string[];
}

interface TransportRecord {
  transport: DataChannelTransport;
  closeCalls: number;
}

function createFakePeerFactory() {
  const peers: PeerRecord[] = [];
  const factory = async (callbacks: WebRtcPeerCallbacks): Promise<WebRtcPeer> => {
    const record: PeerRecord = {
      callbacks,
      closed: false,
      offers: [],
      peer: {
        async acceptOffer(sdp: string) {
          record.offers.push(sdp);
          return "v=0\r\ns=answer\r\n";
        },
        close() {
          record.closed = true;
        },
      },
    };
    peers.push(record);
    return record.peer;
  };
  return { factory, peers };
}

function createRuntime(factory: ReturnType<typeof createFakePeerFactory>["factory"]) {
  return createMobileRemoteControlRuntime({
    getServices: () => new ServiceCollection(),
    resolveWebRoot: () => webRoot,
    exposeServices: () => () => undefined,
    logger: silentLogger,
    logRpc: () => undefined,
    stateStore: createMemoryMobileRemoteControlStateStore(),
    resolveTunnelBinaryPath: () => undefined,
    webRtcPeerFactory: factory,
  });
}

function tokenOf(accessUrl: string | undefined): string {
  assert.ok(accessUrl);
  const token = new URL(accessUrl).searchParams.get("token");
  assert.ok(token);
  return token;
}

async function waitForStatus(
  runtime: { service: { getStatus(): Promise<MobileRemoteControlStatus> } },
  predicate: (status: MobileRemoteControlStatus) => boolean,
  timeoutMs = 5000,
): Promise<MobileRemoteControlStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await runtime.service.getStatus();
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for status, last=${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  message: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Handshake {
  status: number;
  socket?: WebSocket;
}

function handshake(url: string, headers: Record<string, string>): Promise<Handshake> {
  return new Promise<Handshake>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve({ status: 101, socket }));
    socket.once("unexpected-response", (_request, response) => {
      socket.terminate();
      resolve({ status: response.statusCode ?? 0 });
    });
    socket.once("error", () => {
      // 与 unexpected-response 二选一，错误本身不改变断言。
    });
    setTimeout(() => reject(new Error(`handshake timed out: ${url}`)), 5000).unref();
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

function fakeTransport(): TransportRecord {
  const record: TransportRecord = {
    closeCalls: 0,
    transport: undefined as unknown as DataChannelTransport,
  };
  const onMessage = new Emitter<Uint8Array>();
  const onClose = new Emitter<void>();
  const onError = new Emitter<void>();
  const onBuffered = new Emitter<void>();
  record.transport = {
    readyState: "open",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send() {},
    close() {
      record.closeCalls += 1;
      onClose.fire();
    },
    onMessage: onMessage.event,
    onClose: onClose.event,
    onError: onError.event,
    onBufferedAmountLow: onBuffered.event,
  };
  return record;
}

async function startPair(runtime: ReturnType<typeof createRuntime>) {
  const status = await runtime.service.start();
  assert.equal(status.state, "running");
  const token = tokenOf(status.accessUrl);
  const port = status.port;
  assert.ok(port);

  const fallback = await handshake(`ws://127.0.0.1:${port}/ws?rtcId=${RTC_ID}`, {
    cookie: `${TOKEN_COOKIE}=${token}`,
  });
  assert.equal(fallback.status, 101);
  assert.ok(fallback.socket);
  await waitForStatus(runtime, (current) => current.connectedClients === 1);
  const signaling = await handshake(`ws://127.0.0.1:${port}/ws/rtc?rtcId=${RTC_ID}`, {
    cookie: `${TOKEN_COOKIE}=${token}`,
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(signaling.status, 101);
  assert.ok(signaling.socket);

  const answers: string[] = [];
  signaling.socket.on("message", (raw) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const signal = JSON.parse(text) as { type?: string; sdp?: string };
    if (signal.type === "answer" && signal.sdp) answers.push(signal.sdp);
  });
  return {
    status: await runtime.service.getStatus(),
    token,
    port,
    fallback: fallback.socket,
    signaling: signaling.socket,
    answers,
  };
}

before(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-webrtc-root-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>mobile</title>");
});

after(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

describe("mobile remote control WebRTC 集成", () => {
  it("capability、同 Origin 信令、offer-answer 与不计数的 RTC attachment", async () => {
    const harness = createFakePeerFactory();
    const runtime = createRuntime(harness.factory);
    let fallback: WebSocket | undefined;
    let signaling: WebSocket | undefined;
    try {
      const started = await runtime.service.start();
      assert.equal(started.state, "running");
      const token = tokenOf(started.accessUrl);
      const port = started.port;
      assert.ok(port);

      const info = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
        headers: { cookie: `${TOKEN_COOKIE}=${token}` },
      });
      assert.equal(info.status, 200);
      const body = (await info.json()) as { capabilities?: { webRtcDirect?: boolean } };
      assert.equal(body.capabilities?.webRtcDirect, true);

      // 鉴权与 Origin 门禁在实际运行时也生效。
      const anonymous = await handshake(`ws://127.0.0.1:${port}/ws/rtc?rtcId=${RTC_ID}`, {
        origin: `http://127.0.0.1:${port}`,
      });
      assert.equal(anonymous.status, 401);
      const crossOrigin = await handshake(`ws://127.0.0.1:${port}/ws/rtc?rtcId=${RTC_ID}`, {
        cookie: `${TOKEN_COOKIE}=${token}`,
        origin: "http://evil.example.com",
      });
      assert.equal(crossOrigin.status, 403);
      const missingOrigin = await handshake(`ws://127.0.0.1:${port}/ws/rtc?rtcId=${RTC_ID}`, {
        cookie: `${TOKEN_COOKIE}=${token}`,
      });
      assert.equal(missingOrigin.status, 403);

      const pair = await startPair(runtime);
      fallback = pair.fallback;
      signaling = pair.signaling;
      assert.equal(pair.status.connectedClients, 1);

      signaling.send(JSON.stringify({ version: 1, type: "offer", sdp: "v=0\r\ns=offer\r\n" }));
      const answer = await waitFor(() => pair.answers[0], "answer");
      assert.match(answer, /s=answer/);
      assert.equal(harness.peers.length, 1);

      // 真实 DataChannel 升级后 connectedClients 不能翻倍。
      const transport = fakeTransport();
      harness.peers[0]?.callbacks.onDataChannel(transport.transport);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stillOne = await runtime.service.getStatus();
      assert.equal(stillOne.connectedClients, 1);

      const stopped = await runtime.service.stop();
      assert.equal(stopped.connectedClients, 0);
      assert.equal(harness.peers[0]?.closed, true);
      assert.equal(transport.closeCalls, 1);
      await closed(signaling);
    } finally {
      fallback?.terminate();
      signaling?.terminate();
      runtime.dispose();
    }
  });

  it("resetToken 会作废旧 peer 与信令", async () => {
    const harness = createFakePeerFactory();
    const runtime = createRuntime(harness.factory);
    let pair: Awaited<ReturnType<typeof startPair>> | undefined;
    try {
      pair = await startPair(runtime);
      pair.signaling.send(JSON.stringify({ version: 1, type: "offer", sdp: "v=0\r\ns=offer\r\n" }));
      await waitFor(() => pair?.answers[0], "answer");
      assert.equal(harness.peers[0]?.closed, false);

      await runtime.service.resetToken();
      assert.equal(harness.peers[0]?.closed, true);
      await closed(pair.signaling);
      // 新 token 下重新建立监听，旧 fallback 已断开。
      const status = await runtime.service.getStatus();
      assert.equal(status.state, "running");
      assert.notEqual(tokenOf(status.accessUrl), pair.token);
    } finally {
      pair?.fallback.terminate();
      pair?.signaling.terminate();
      runtime.dispose();
    }
  });
});
