import { z } from "zod";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoRecordingEnabled: z.boolean().default(true),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    dynamicWorkflowEnabled: z.boolean().default(false),
    automationEnabled: z.boolean().default(false),
    // 网络搜索 Provider 策略（docs/specs/web-search-provider-capability.md）。
    // order 走 optional：undefined 表示用户从未整理过排序，由消费方按固定优先级派生。
    webSearchEnabled: z.boolean().default(true),
    webSearchProviderOrder: z.array(z.string()).optional(),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
