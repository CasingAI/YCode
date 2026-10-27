/**
 * Web 当前连接信息的纯类型。
 *
 * 由连接 owner 发布；只描述已经发布的 services 所使用的数据通道，不包含
 * ICE 地址、SDP、重试次数或连接代次。`endpoint` 仅允许 ws:/wss: origin。
 */
export interface WebConnectionInfo {
  readonly transport: "websocket" | "webrtc" | null;
  readonly directState: "disabled" | "waiting" | "connecting" | "connected" | "fallback";
  readonly endpoint: string | null;
}
