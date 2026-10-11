import type { ICredentialService } from "#src/credential/credential.js";

// 智谱剥离：zai/bigmodel userinfo 识别已删除，OAuth 账号体系下线后
// 不再按业务 token 识别当前 OAuth 凭据请求，仅保留 ZCode JWT 判定。
// 删除原因见 docs/specs/zhipu-special-removal.md。

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  return false;
}
