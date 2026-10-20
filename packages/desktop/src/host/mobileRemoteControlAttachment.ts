/**
 * 手机连接（附件）的注册表 —— 桌面 Host 进程内。
 *
 * 一条手机 WebSocket = 一个独立的 ChannelServer，与 renderer attachment 平级：
 * 同一份 activeServices，只是 transport 换成 WS。
 *
 * 独立成文件是因为它有自己的生命周期：连接数变化要回报给远控状态，
 * 而关停时必须逐条释放附件（关监听不会断开已建立的连接）。
 */
import {
  ChannelServer,
  LoggingChannelServer,
  SocketProtocol,
  type IChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { ServiceCollection } from "@zcode/services";

interface MobileAttachment {
  dispose(): void;
}

export interface MobileAttachmentRegistryOptions {
  /** 当前活跃服务集合；Host 尚未初始化完成时返回 null。 */
  getServices: () => ServiceCollection | null;
  /** 把活跃服务暴露到这条手机连接上，返回释放函数。 */
  exposeServices: (server: IChannelServer, services: ServiceCollection) => () => void;
  /** 与 renderer attachment 同一条 RPC 日志通道。 */
  logRpc: (message: string) => void;
  /** 连接数变化时回调（含首次接入与断开）。 */
  onSizeChanged: (size: number) => void;
  /** 接入日志。 */
  logAttached: (size: number) => void;
}

export interface MobileAttachmentRegistry {
  /** 接入一条手机连接；没有可用服务时直接断开这条 socket。 */
  attach(socket: ISocket): void;
  /** 当前连接数。 */
  readonly size: number;
  /** 释放全部连接（关停远控时用）。 */
  disposeAll(): void;
}

export function createMobileAttachmentRegistry(
  options: MobileAttachmentRegistryOptions,
): MobileAttachmentRegistry {
  const attachments = new Set<MobileAttachment>();

  const attach = (socket: ISocket): void => {
    const services = options.getServices();
    if (!services) {
      socket.dispose();
      return;
    }
    const protocol = new SocketProtocol(socket);
    const rawServer = new ChannelServer(protocol, "host");
    const server = new LoggingChannelServer(rawServer, options.logRpc);
    const disposeOverrides = options.exposeServices(server, services);
    let closed = false;
    const attachment: MobileAttachment = {
      dispose() {
        if (closed) return;
        closed = true;
        attachments.delete(attachment);
        // stop() 主动断开手机时 socket 还在；onClose 触发时它已经关了，dispose 幂等。
        socket.dispose();
        rawServer.dispose();
        disposeOverrides();
      },
    };
    attachments.add(attachment);
    socket.onClose(() => {
      attachment.dispose();
      options.onSizeChanged(attachments.size);
    });
    options.onSizeChanged(attachments.size);
    options.logAttached(attachments.size);
  };

  const disposeAll = (): void => {
    // 复制一份再遍历：dispose() 会把自己从集合里删掉。
    for (const attachment of Array.from(attachments)) {
      attachment.dispose();
    }
    attachments.clear();
  };

  return {
    attach,
    disposeAll,
    get size() {
      return attachments.size;
    },
  };
}
