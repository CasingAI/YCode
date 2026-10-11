import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
// 智谱剥离：account:* 内置身份与 Start Plan 特例已删除，
// 全部 provider 按普通身份解析。删除原因见 docs/specs/zhipu-special-removal.md。
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
