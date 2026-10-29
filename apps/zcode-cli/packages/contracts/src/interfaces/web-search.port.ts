// WebSearch Port - 网络搜索 Provider 体系执行端口
//
// docs/specs/web-search-provider-capability.md：WebSearch 工具的后端不再依赖模型原生
// web_search server tool，而是按用户排序激活的供应商独立搜索 API 执行。core 的工具
// handler 只经本端口访问搜索能力；端点/Key 事实由宿主（bootstrap）从进程级 Provider
// Registry 解析，策略（开关+排序）由宿主从 Host 同步的 appRuntimePreferences 读取。

import type { WebSearchEndpointDescriptor, McpProxyMode } from "@zcode/shared";
import type { WebSearchInput, WebSearchOutput } from "../tools/websearch.js";

/** 已解析的激活搜索源：一次解析全部事实，执行期不再回查。 */
export interface ActiveWebSearchProvider {
  providerId: string;
  templateId: string;
  endpoint: WebSearchEndpointDescriptor;
  apiKey: string;
  /** provider 实例的出口代理模式；执行器按它解析 proxy-aware fetch。 */
  proxyMode?: McpProxyMode;
}

export interface WebSearchPort {
  /**
   * 解析当前激活的搜索源。返回 undefined 表示 WebSearch 不可用
   * （总开关关闭 / 无候选 / 激活项无法解析），调用方不得暴露工具。
   * 实现必须廉价且同步可重入：getTools 每次 Filters 都会调用。
   */
  resolveActiveProvider(): ActiveWebSearchProvider | undefined;
  /**
   * 用激活搜索源执行一次搜索。实现方负责超时、错误分类与结果归一化；
   * 失败以 Error 抛出（可恢复），由 core 包装为工具失败。
   */
  search(
    input: WebSearchInput,
    provider: ActiveWebSearchProvider,
    options: { abortSignal?: AbortSignal },
  ): Promise<WebSearchOutput>;
}
