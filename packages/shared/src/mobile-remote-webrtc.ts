import { z } from "zod";

/**
 * WebRTC 信令协议版本。
 *
 * 信令只走已鉴权 WSS，版本用于拒绝不同代协议，避免新旧字段被宽松解析。
 */
export const WEB_RTC_SIGNAL_VERSION = 1 as const;

/** 单条 SDP 的上限，防止信令通道被超长载荷占用。 */
const MAX_SDP_LENGTH = 256 * 1024;

/**
 * 每次直连尝试的临时关联 ID。
 *
 * 只用于把 fallback WebSocket 与 `/ws/rtc` 信令连接关联起来，不是独立凭据，
 * 因此必须是密码学随机 UUID，且不写入浏览器存储。
 */
export const webRtcIdSchema = z.string().uuid();

export const webRtcSignalErrorCodeSchema = z.enum([
  "invalid-signal",
  "unavailable",
  "busy",
  "negotiation-failed",
]);

/**
 * offer/answer 只携带一次完整 SDP；错误码是有限枚举，不暴露底层异常文本。
 * ping/pong 用于信令链路保活：公网隧道会按空闲时间掐断连接，双方需周期性互发。
 * 所有分支都使用 strict，未知字段直接拒绝，防止后续字段被静默忽略。
 */
export const webRtcSignalSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(WEB_RTC_SIGNAL_VERSION),
      type: z.literal("offer"),
      sdp: z.string().max(MAX_SDP_LENGTH),
    })
    .strict(),
  z
    .object({
      version: z.literal(WEB_RTC_SIGNAL_VERSION),
      type: z.literal("answer"),
      sdp: z.string().max(MAX_SDP_LENGTH),
    })
    .strict(),
  z
    .object({
      version: z.literal(WEB_RTC_SIGNAL_VERSION),
      type: z.literal("error"),
      code: webRtcSignalErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(WEB_RTC_SIGNAL_VERSION),
      type: z.literal("ping"),
    })
    .strict(),
  z
    .object({
      version: z.literal(WEB_RTC_SIGNAL_VERSION),
      type: z.literal("pong"),
    })
    .strict(),
]);

export type WebRtcSignal = z.infer<typeof webRtcSignalSchema>;
