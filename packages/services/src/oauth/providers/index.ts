import type { ApiClient } from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providerAdapter.js";

/** 根据运行时配置创建可用 provider adapter */
// 智谱剥离：zai/bigmodel OAuth adapter 已删除，OAuth 框架保留，
// 当前无可用登录入口，返回空列表。删除原因见 docs/specs/zhipu-special-removal.md。
export function createOAuthProviderAdapters(
  _config: { providers: unknown[] },
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }
  return [];
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
