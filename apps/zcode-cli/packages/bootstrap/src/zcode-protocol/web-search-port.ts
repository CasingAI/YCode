// WebSearchPort 装配：把进程级 WebSearchExecutor 与策略偏好绑定成 core 可用的端口
// （docs/specs/web-search-provider-capability.md）。
// createPolicyWebSearchPort 是纯装配：解析时读取传入偏好视图的当前值。
// createSessionPolicyWebSearchPort 是会话边界：app 创建/恢复时对策略（开关+排序）做快照，
// 会话生命周期内恒定——与 dynamic-workflow / off-peak 策略同构（只影响之后创建/恢复的
// record，已活跃会话的工具面不回收）。过去把实时 context 直接绑进端口，开关/排序改动会
// 在已活跃会话热翻转工具面，违反同构语义，属设计 bug，此函数即修复边界。
// executor 缺席（异常装配路径）时 fail-closed 返回 undefined。

import type { ActiveWebSearchProvider, WebSearchPort } from "@zcode/contracts";
import type { WebSearchExecutor } from "@zcode/adapters/web-search";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export function createPolicyWebSearchPort(options: {
  executor?: WebSearchExecutor;
  context: Pick<ZCodeProtocolAgentServerContext, "appRuntimePreferences">;
}): WebSearchPort {
  const { executor, context } = options;
  return {
    resolveActiveProvider(): ActiveWebSearchProvider | undefined {
      if (!executor) return undefined;
      return executor.resolveActiveProvider({
        enabled: context.appRuntimePreferences.webSearchEnabled,
        order: context.appRuntimePreferences.webSearchProviderOrder,
      });
    },
    async search(input, provider, searchOptions) {
      if (!executor) {
        throw new Error("WebSearch executor 未装配，无法执行网络搜索");
      }
      return await executor.search(input, provider, {
        abortSignal: searchOptions.abortSignal,
      });
    },
  };
}

/**
 * 会话边界的策略快照绑定，app 创建/恢复时调用一次。
 * 之后 workspace policy 的开关/排序写入（updateWebSearchPolicy 只整体替换字段）不再进入
 * 本端口视图：已活跃会话的工具面与激活搜索源保持创建时状态，新会话才取新策略。
 */
export function createSessionPolicyWebSearchPort(options: {
  executor?: WebSearchExecutor;
  context: Pick<ZCodeProtocolAgentServerContext, "appRuntimePreferences">;
}): WebSearchPort {
  const snapshot = { ...options.context.appRuntimePreferences };
  if (Array.isArray(snapshot.webSearchProviderOrder)) {
    snapshot.webSearchProviderOrder = [...snapshot.webSearchProviderOrder];
  }
  return createPolicyWebSearchPort({
    executor: options.executor,
    context: { appRuntimePreferences: snapshot },
  });
}
