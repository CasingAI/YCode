import {
  collectTelemetryRendererContext,
  sanitizeTelemetryEventDetail,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

// 智谱剥离：account:* 内置身份与 family 判定已随 Zhipu 账号体系下线（见 docs/specs/zhipu-special-removal.md）。
// 遥测标签不再区分 z.ai/bigmodel 账号入口，原样返回 providerId，不影响上报链路。
export function resolveProviderTelemetryLabel(providerId: string): string {
  return providerId;
}

export function resolvePresetModelProviderTelemetryLabel(presetId: string): string {
  return resolveProviderTelemetryLabel(presetId);
}

type ReportTelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

export async function reportAppTelemetryEvent(
  platform: ReportTelemetryPlatform,
  payload: {
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  },
  scope: string,
): Promise<void> {
  try {
    const reportPayload = {
      context: collectTelemetryRendererContext(),
      ...payload,
      eventExtraDetail: sanitizeTelemetryEventDetail(payload.elementName, payload.eventExtraDetail),
    };

    // 修复原因：只在 Core 清洗会让原文先经过 IPC/本地日志；此处只记录清洗后的副本。
    // step 与消息同量级，调试输出使用 debug，不产生 info 落盘副本。
    if (payload.elementName === "message_completion" || payload.elementName === "agent_step") {
      logger.debug(`[${scope}] ${payload.elementName} payload:`, reportPayload);
    }

    await platform.reportTelemetryEvent(reportPayload);
  } catch {
    // 最终失败由 Desktop Main 的 TelemetryCore 统一记录脱敏告警；UI 只维持业务隔离，
    // 避免同一失败重复记录，或把 IPC 原始错误带入生产日志。
  }
}
