import type { OAuthProviderId } from "@zcode/shared";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

// 智谱剥离：zai/bigmodel 派生 Coding Plan 凭据清理已删除，
// 智谱账号体系下线后 logout 仅触发账号刷新，不再按 family 删 key。
// 删除原因见 docs/specs/zhipu-special-removal.md。
export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider) => {
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}
