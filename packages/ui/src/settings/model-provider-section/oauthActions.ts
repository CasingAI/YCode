import type { IPlatformService } from "@zcode/shared";
import {
  reportAppTelemetryEvent,
  resolvePresetModelProviderTelemetryLabel,
} from "@/lib/appTelemetry.js";

// 智谱剥离：预置订阅上报保留签名兼容旧引用，presetId 改为普通字符串
//（见 docs/specs/zhipu-special-removal.md）。
export async function reportPresetSubscriptionSuccess(params: {
  platform: IPlatformService;
  presetId: string;
}) {
  await reportAppTelemetryEvent(
    params.platform,
    {
      elementName: "add_model_success",
      eventRegion: "app_setting",
      eventType: "ck",
      eventExtraDetail: {
        login_default: "1",
        model_provider: resolvePresetModelProviderTelemetryLabel(params.presetId),
      },
    },
    "ModelProviderSection",
  );
}
