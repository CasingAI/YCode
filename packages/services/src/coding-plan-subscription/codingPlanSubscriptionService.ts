import type { ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import type { ModelSelectionView } from "@zcode/provider";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY } from "@zcode/shared";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
}

// 智谱剥离：zai/bigmodel Coding Plan 订阅 provider 已删除，
// 智谱账号体系下线后不再维护套餐权益、Team/Start Plan、企业定价等特殊逻辑。
// 服务保留接口兼容（跨包 UI/Client 仍引用描述符），方法返回空值占位，
// 删除原因见 docs/specs/zhipu-special-removal.md。
export function createCodingPlanSubscriptionService(
  _dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  return {
    getStaticTeamProducts: async () => ({}),
    getStartPlanPreview: async () => null,
    getOffPeakClientConfig: async (options) => ({
      enabled: false,
      modelSelectionView: { revision: 0, providers: Object.freeze([]) },
      ...(options?.forceRefresh !== undefined ? { codingPlanActive: false } : {}),
    }),
    getModelContextBudgetStrategy: async () => DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    getForceUpdateConfig: async () => null,
    getEnterprisePricing: async () => ({ productList: [] }),
  };
}
