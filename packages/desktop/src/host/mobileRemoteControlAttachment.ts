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
  /**
   * 是否计入 connectedClients。
   *
   * WebRTC DataChannel 与对应 fallback 属于同一条逻辑连接，
   * 升级后不能再把客户端数量翻倍。
   */
  readonly counted: boolean;
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

export interface MobileAttachmentOptions {
  /**
   * 是否计入 connectedClients，默认 true。
   *
   * WebRTC DataChannel 与对应 fallback WSS 属于同一条逻辑连接，
   * 升级后不能再把客户端数量翻倍。
   */
  counted?: boolean;
}

export interface MobileAttachmentRegistry {
  /** 接入一条手机连接；没有可用服务时直接断开这条 socket。 */
  attach(socket: ISocket, options?: MobileAttachmentOptions): void;
  /** 当前连接数。 */
  readonly size: number;
  /** 释放全部连接（关停远控时用）。 */
  disposeAll(): void;
}

export function createMobileAttachmentRegistry(
  options: MobileAttachmentRegistryOptions,
): MobileAttachmentRegistry {
  const attachments = new Set<MobileAttachment>();

  /**
   * 逻辑连接数只由 counted 附件派生，不从附件集合总数推断。
   *
   * 修复前 `size` / `onSizeChanged` 直接用 attachments.size，RTC 附件
   * （counted=false）也被算进去：第二条 fallback 加入时会把已有 RTC 计入，
   * 断开任一 RTC 又会让计数错误下降。这里保持单一事实来源，不引入额外计数器。
   */
  const countedSize = (): number => {
    let size = 0;
    for (const attachment of attachments) {
      if (attachment.counted) size += 1;
    }
    return size;
  };

  const attach = (socket: ISocket, attachOptions: MobileAttachmentOptions = {}): void => {
    const counted = attachOptions.counted ?? true;
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
    let closeSubscription: { dispose(): void } = { dispose() {} };
    const attachment: MobileAttachment = {
      counted,
      dispose() {
        if (closed) return;
        closed = true;
        attachments.delete(attachment);
        // 先摘掉自己的 socket 订阅，避免 socket.dispose() 递归回到这里。
        closeSubscription.dispose();
        // SocketProtocol 持有 socket.onData 订阅；只断开 socket 不会释放它。
        protocol.dispose();
        // ChannelServer 持有 protocol.onMessage 订阅与在途请求。
        rawServer.dispose();
        // stop() 主动断开手机时 socket 还在；onClose 触发时它已经关了，dispose 幂等。
        socket.dispose();
        disposeOverrides();
        if (counted) {
          options.onSizeChanged(countedSize());
        }
      },
    };
    attachments.add(attachment);
    closeSubscription = socket.onClose(() => {
      attachment.dispose();
    });
    if (counted) {
      const size = countedSize();
      options.onSizeChanged(size);
      options.logAttached(size);
    }
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
      // 对外只暴露逻辑连接数；RTC 附件不计入。
      return countedSize();
    },
  };
}
