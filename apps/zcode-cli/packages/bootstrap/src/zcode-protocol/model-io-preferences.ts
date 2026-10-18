import { zcodeWorkspaceUpdateModelIoPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * ModelIO 写盘策略是 App 全局偏好，但每个 resident session 持有独立 adapter。
 * 因此协议层同时缓存偏好供未来 session 继承，并立即更新已有 session，避免新旧任务行为分裂。
 */
export async function updateModelIoPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateModelIoPreferencesParamsSchema, rawParams);
  const recordingEnabled = params.preferences.recordingEnabled;
  const fullRetentionEnabled = params.preferences.fullRetentionEnabled;
  context.appRuntimePreferences.modelIoRecordingEnabled = recordingEnabled;
  context.appRuntimePreferences.modelIoFullRetentionEnabled = fullRetentionEnabled;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    const setRecordingEnabled = record.app.setModelIoRecordingEnabled;
    const setFullRetentionEnabled = record.app.setModelIoFullRetentionEnabled;
    if (setRecordingEnabled || setFullRetentionEnabled) updatedSessionCount += 1;
    setRecordingEnabled?.(recordingEnabled);
    setFullRetentionEnabled?.(fullRetentionEnabled);
  }

  return {
    workspace: params.workspace,
    recordingEnabled,
    fullRetentionEnabled,
    updatedSessionCount,
  };
}
