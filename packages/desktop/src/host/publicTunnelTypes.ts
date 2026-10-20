/**
 * 公网隧道在桌面 Host 侧的共享类型。
 *
 * 两个 launcher（cloudflared / localtunnel）产出的句柄形状必须一致，
 * 控制器才能按 Provider 分派而不关心具体实现；日志接口同理——
 * Host 的 logger 本来就是这三个方法，多造一份类型只会让调用处多一次转换。
 */

/** 隧道日志接口：与 Host logger 结构兼容。 */
export interface PublicTunnelLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** 隧道句柄。 */
export interface PublicTunnelHandle {
  /** 公网根地址（不含 token）。 */
  url: string;
  /** 主动终止隧道并清理资源；幂等。 */
  stop: () => Promise<void>;
}
