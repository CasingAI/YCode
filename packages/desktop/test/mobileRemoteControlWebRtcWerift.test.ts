import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { createDataChannelSocket, VSBuffer, type DataChannelTransport } from "@zcode/rpc";
import { createWeriftPeerFactory } from "../src/host/mobileRemoteControlWebRtcPeer.js";
import type { WebRtcPeer } from "../src/host/mobileRemoteControlWebRtcPeer.js";

/** 只使用 loopback host candidate，不访问外部 STUN/TURN，也不扫描局域网。 */
function loopbackPeer(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ["127.0.0.1"],
    iceUseIpv6: false,
  });
}

async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 10000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await Promise.race([
    pc.iceGatheringStateChange.watch((state) => state === "complete", timeoutMs),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ICE gathering timed out")), timeoutMs).unref(),
    ),
  ]);
}

async function waitFor<T>(
  read: () => T | undefined,
  message: string,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function toBuffer(data: string | Buffer): Buffer {
  return typeof data === "string" ? Buffer.from(data) : data;
}

/** 构造可校验顺序的字节序列。 */
function pattern(length: number): Uint8Array {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = index % 251;
  }
  return result;
}

type ChannelOptions = Parameters<RTCPeerConnection["createDataChannel"]>[1];

interface ChannelSpec {
  readonly label: string;
  readonly options?: ChannelOptions;
}

/** 建立 offer 并让 Host peer 接受，返回双方通道与 Host 侧回调记录。 */
async function negotiateChannels(specs: ChannelSpec[]) {
  const offerer = loopbackPeer();
  const channels = specs.map((spec) => offerer.createDataChannel(spec.label, spec.options));
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await waitForIceGathering(offerer);
  const offerSdp = offerer.localDescription?.sdp;
  assert.ok(offerSdp, "offer SDP missing");

  const deliveries: DataChannelTransport[] = [];
  const failures: Error[] = [];
  const serverPeer = await createWeriftPeerFactory()({
    onDataChannel(channel) {
      deliveries.push(channel);
    },
    onFailure(error) {
      failures.push(error);
    },
  });
  const answerSdp = await serverPeer.acceptOffer(offerSdp);
  await offerer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  return { offerer, channels, serverPeer, deliveries, failures };
}

describe("werift DataChannel 真实协商", () => {
  it("两个本机 peer 完成 offer-answer，并可靠有序传输大 payload", async () => {
    const offerer = loopbackPeer();
    const factory = createWeriftPeerFactory();
    let serverPeer: WebRtcPeer | undefined;
    let serverTransport: DataChannelTransport | undefined;
    let offererChannel: RTCDataChannel | undefined;
    let serverSocket: ReturnType<typeof createDataChannelSocket> | undefined;

    try {
      offererChannel = offerer.createDataChannel("zcode-rpc", { ordered: true });
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await waitForIceGathering(offerer);
      const offerSdp = offerer.localDescription?.sdp;
      assert.ok(offerSdp, "offer SDP missing");

      serverPeer = await factory({
        onDataChannel(channel) {
          serverTransport = channel;
        },
        onFailure() {
          // 测试里连接失败由后续断言/超时暴露。
        },
      });
      const answerSdp = await serverPeer.acceptOffer(offerSdp);
      assert.match(answerSdp, /v=0/);
      assert.match(answerSdp, /^a=setup:(active|passive)$/m);

      await offerer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await waitFor(
        () => (offererChannel?.readyState === "open" ? true : undefined),
        "offerer data channel open",
      );
      const transport = await waitFor(() => serverTransport, "server data channel");
      serverSocket = createDataChannelSocket(transport);

      // server -> browser：256 KiB，经 DataChannelSocket 16 KiB 分片发送。
      const outgoing = pattern(256 * 1024);
      const receivedByOfferer: Buffer[] = [];
      let offererBytes = 0;
      offererChannel.onmessage = (event) => {
        const chunk = toBuffer(event.data);
        receivedByOfferer.push(chunk);
        offererBytes += chunk.byteLength;
      };
      serverSocket.write(VSBuffer.wrap(outgoing));
      await waitFor(
        () => (offererBytes >= outgoing.byteLength ? true : undefined),
        "offerer received full payload",
      );
      const offererPayload = Buffer.concat(receivedByOfferer);
      assert.equal(offererPayload.byteLength, outgoing.byteLength);
      assert.deepEqual(offererPayload, Buffer.from(outgoing));

      // browser -> server：分多条消息发送，验证顺序与完整性。
      const incoming = pattern(192 * 1024);
      const receivedByServer: Uint8Array[] = [];
      let serverBytes = 0;
      serverSocket.onData((buffer) => {
        receivedByServer.push(buffer.buffer);
        serverBytes += buffer.byteLength;
      });
      const chunkSize = 8 * 1024;
      for (let offset = 0; offset < incoming.byteLength; offset += chunkSize) {
        offererChannel.send(Buffer.from(incoming.subarray(offset, offset + chunkSize)));
      }
      await waitFor(
        () => (serverBytes >= incoming.byteLength ? true : undefined),
        "server received full payload",
      );
      const serverPayload = Buffer.concat(receivedByServer.map((chunk) => Buffer.from(chunk)));
      assert.deepEqual(serverPayload, Buffer.from(incoming));
    } finally {
      serverSocket?.dispose();
      offererChannel?.close();
      serverPeer?.close();
      await offerer.close();
    }
  });

  it("拒绝非可靠有序 zcode-rpc 通道，合法主通道不受影响", async () => {
    const { offerer, channels, serverPeer, deliveries, failures } = await negotiateChannels([
      // 非本协议 label。
      { label: "extra", options: { ordered: true } },
      // 本协议 label，但不可靠有序。
      { label: "zcode-rpc", options: { ordered: false } },
      // 本协议 label，但带自定义子协议。
      { label: "zcode-rpc", options: { protocol: "other", ordered: true } },
      // 本协议 label，但部分可靠。
      { label: "zcode-rpc", options: { maxRetransmits: 3, ordered: true } },
      { label: "zcode-rpc", options: { maxPacketLifeTime: 100, ordered: true } },
      // 唯一合法主通道。
      { label: "zcode-rpc", options: { ordered: true } },
    ]);

    try {
      const mainTransport = await waitFor(() => deliveries[0], "main data channel");
      const mainChannel = channels.at(-1);
      assert.ok(mainChannel);
      await waitFor(
        () => (mainChannel.readyState === "open" ? true : undefined),
        "main data channel open",
      );

      // 非法通道在 Host 侧被就地关闭，不会影响主通道。
      const rejected = channels.slice(0, -1);
      await waitFor(
        () => (rejected.every((channel) => channel.readyState === "closed") ? true : undefined),
        "rejected channels closed",
      );

      assert.equal(deliveries.length, 1);
      assert.equal(failures.length, 0);

      const received: Uint8Array[] = [];
      mainTransport.onMessage((data) => received.push(data));
      mainChannel.send(Buffer.from("still-alive"));
      await waitFor(() => received[0], "main channel payload");
      assert.equal(Buffer.from(received[0] ?? []).toString(), "still-alive");
    } finally {
      serverPeer.close();
      for (const channel of channels) channel.close();
      await offerer.close();
    }
  });

  it("DataChannel 收到字符串帧触发 onError，不按 UTF-8 当作 RPC 字节", async () => {
    const { offerer, channels, serverPeer, deliveries } = await negotiateChannels([
      { label: "zcode-rpc", options: { ordered: true } },
    ]);

    try {
      const transport = await waitFor(() => deliveries[0], "server data channel");
      const messages: Uint8Array[] = [];
      let errors = 0;
      transport.onMessage((data) => messages.push(data));
      transport.onError(() => {
        errors += 1;
      });

      const channel = channels[0];
      assert.ok(channel);
      await waitFor(() => (channel.readyState === "open" ? true : undefined), "data channel open");
      channel.send("text-frame");

      await waitFor(() => (errors > 0 ? true : undefined), "transport error");
      // 文本帧被拒绝，绝不能进入 SocketProtocol。
      assert.equal(messages.length, 0);
    } finally {
      serverPeer.close();
      for (const channel of channels) channel.close();
      await offerer.close();
    }
  });
});
