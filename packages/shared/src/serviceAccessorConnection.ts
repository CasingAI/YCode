/**
 * 稳定 service facade 的 renderer-local connection port。
 *
 * 该端口只用于同一页面内识别底层 RPC attachment 换代，不序列化、不进入 wire
 * protocol。普通 service 对象没有此端口，调用方应把自己的对象视为固定 attachment。
 */
export const SERVICE_ACCESSOR_CONNECTION = Symbol("zcode.serviceAccessor.connection");

export interface ServiceAccessorConnection {
  /** 当前底层 service attachment；连接断开或尚未建立时为 null。 */
  getAttachment(): object | null;
  /** 订阅新的非空 attachment 就绪事件。 */
  subscribe(listener: () => void): () => void;
}

type ServiceAccessorConnectionCarrier = {
  readonly [SERVICE_ACCESSOR_CONNECTION]?: ServiceAccessorConnection;
};

export function getServiceAccessorConnection(
  service: object,
): ServiceAccessorConnection | undefined {
  return (service as ServiceAccessorConnectionCarrier)[SERVICE_ACCESSOR_CONNECTION];
}

const COMMAND_NOT_SENT = "__zcodeCommandNotSent";

/**
 * 标记「命令在到达 transport 之前就被拒绝」：此时服务端必然没有收到，账本应结算为
 * 未发送，而不是留下无法收口的 unknown 提示。标记只写在 renderer 进程内的 Error 上，
 * 不可枚举、不序列化、不进入 wire protocol。
 */
export function markCommandNotSent<E extends Error>(error: E): E {
  Object.defineProperty(error, COMMAND_NOT_SENT, { configurable: true, value: true });
  return error;
}

export function isCommandNotSentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as unknown as Record<string, unknown>)[COMMAND_NOT_SENT] === true
  );
}
