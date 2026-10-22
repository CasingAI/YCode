/**
 * 手机远控 attachment 的连接口径。
 *
 * clientMode 与 delivery profile 是两件事：
 * - clientMode 回答"这是不是本机桌面"（权限弹窗、本地终端、telemetry 只对本机桌面开放），
 *   手机远控必须留在 web-remote-replayable；
 * - delivery profile 决定会话行可见性与流式路径，手机要与桌面一致，因此显式声明 continuous。
 *
 * 过去两者被绑在一起（clientMode 一变，档位就跟着变），手机因此天然少看到
 * inputText / output.text / summaryText 的流式细节。解绑后手机拿 continuous，
 * 权限语义不受影响。
 */
import type { ZCodeAgentV4ClientMode } from "@zcode/services";
import type { DeliveryProfileName } from "@zcode/shared/zcode-protocol-v4";

export interface MobileRemoteControlConnectionContext {
  clientMode: ZCodeAgentV4ClientMode;
  deliveryProfile: DeliveryProfileName;
}

export const MOBILE_REMOTE_CONTROL_CONNECTION: MobileRemoteControlConnectionContext = {
  clientMode: "web-remote-replayable",
  deliveryProfile: "continuous",
};
