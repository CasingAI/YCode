import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export interface ProviderOrderView {
  readonly providerIds: readonly string[];
  /** 显式分组顺序；缺省表示未拖动过分组，由导航层按 canonical 兜底。 */
  readonly groupIds?: readonly string[];
}

export function sortModelProvidersForDisplay<
  T extends Pick<ProviderSettingsFormProvider, "providerId">,
>(providers: readonly T[], displayOrder?: ProviderOrderView | null): T[] {
  const orderIndexById = new Map(
    (displayOrder?.providerIds ?? []).map((providerId, index) => [providerId, index]),
  );

  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const leftOrder = orderIndexById.get(left.provider.providerId);
      const rightOrder = orderIndexById.get(right.provider.providerId);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        return (
          (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER) ||
          left.index - right.index
        );
      }

      return left.index - right.index;
    })
    .map(({ provider }) => provider);
}
