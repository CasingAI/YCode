// 每个底层 RPC attachment 对应一个 handshake；稳定 facade 跨 WebSocket generation
// 仍必须切换缓存键，否则新 attachment 会复用旧代 handshakeRequired 状态。
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getServiceAccessorConnection, markCommandNotSent } from "@zcode/shared";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();

function attachmentKey(service: AgentV4HandshakeService): object {
  const connection = getServiceAccessorConnection(service);
  if (!connection) return service;
  const attachment = connection.getAttachment();
  if (attachment) return attachment;
  // 断线期在握手阶段就被拒绝：命令从未上行，账本应结算为未发送而不是 unknown。
  const error = new Error("fault.connection.closed");
  error.name = "ConnectionClosed";
  throw markCommandNotSent(error);
}

export async function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = attachmentKey(service);
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
      // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities: { workspaceHookReviewUi: true },
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
