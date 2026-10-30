/**
 * Web 当前连接信息的纯类型。
 *
 * 由连接 owner 发布；只描述已经发布的 services 所使用的数据通道，不包含
 * 服务地址、ICE 地址、SDP、重试次数或连接代次。
 */
export interface WebConnectionInfo {
  readonly transport: "websocket" | "webrtc" | null;
  readonly directState: "disabled" | "waiting" | "connecting" | "connected" | "fallback";
}

/**
 * 最近一次完整业务 RPC 样本的只读估算值。
 *
 * owner 只保留最近一次合法样本；缺失表示没有可用样本或样本已过期，
 * 不能当作 0 ms。
 */
export interface WebConnectionLatency {
  readonly networkRoundTripMs: number;
  readonly serverProcessingMs: number;
}
