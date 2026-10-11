import type { ApiClient } from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import type { ZCodeAccountAccess } from "@zcode/shared";

interface TeamPlanRequestKeyDependencies {
  readonly apiClient: ApiClient;
  readonly credentialService?: Pick<ICredentialService, "load">;
  readonly access: Extract<ZCodeAccountAccess, { planKind: "team-coding-plan" }>;
}

// 智谱剥离：Team Plan runtime key 投影（customerInfo + 项目 Key 复制）
// 已随账号体系下线删除，始终返回 null。删除原因见 docs/specs/zhipu-special-removal.md。
// 保留导出供 desktop 远端装配引用。
export async function resolveAccountTeamPlanRuntimeApiKey(
  _params: TeamPlanRequestKeyDependencies,
): Promise<string | null> {
  return null;
}
