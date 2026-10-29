import { zcodeWorkspaceUpdateWebSearchPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 网络搜索 Provider 策略（docs/specs/web-search-provider-capability.md）。
 * 判定权在 Host：Host 读取 AppSettings 的 webSearchEnabled/webSearchProviderOrder
 * 并通过 workspace policy 显式同步，CLI 只保存结论。与 dynamic-workflow-policy.ts 同构。
 * 只影响之后创建/恢复的会话：app 创建边界对策略做快照（createSessionPolicyWebSearchPort），
 * 已活跃会话的工具面与激活搜索源不随本 handler 的写入实时翻转。
 */
export async function updateWebSearchPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateWebSearchPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.webSearchEnabled = params.enabled;
  context.appRuntimePreferences.webSearchProviderOrder = params.providers
    ? [...params.providers]
    : undefined;
  return {
    workspace: params.workspace,
    enabled: params.enabled,
    ...(params.providers ? { providers: [...params.providers] } : {}),
  };
}
