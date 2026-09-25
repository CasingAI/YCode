import { zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Dynamic Workflow 会话工具开关。判定权在 Host：
 * Host 读取 AppSettings 用户设置并通过 workspace policy 显式同步，CLI 只保存结论。
 * 与 off-peak-tool-policy.ts 同构：CLI 进程按 workspace 隔离；
 * createRecord 对 legacy create/resume、v4 createSession 与 v4 冷恢复
 * （subscribe → resumePersistedSession，没有 host 参数通道）统一读取。
 * 只影响之后创建/恢复的 record；已活跃 record 的工具面不回收。
 */
export async function updateDynamicWorkflowPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
