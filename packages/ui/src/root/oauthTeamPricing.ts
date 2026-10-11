import type { IServiceAccessor } from "@zcode/services";
import type { EnterpriseCodingPlanPricingProduct, ProviderFamilyDomain } from "@zcode/shared";

type EnterprisePricingProductsResult =
  | { status: "success"; productList: EnterpriseCodingPlanPricingProduct[] }
  | { status: "error" };

// 智谱剥离：Team 定价查询已下线，一律返回空（见 docs/specs/zhipu-special-removal.md）。
export async function getEnterprisePricingProducts(
  _services: IServiceAccessor,
  _domain: ProviderFamilyDomain,
): Promise<EnterprisePricingProductsResult> {
  return { status: "success", productList: [] };
}

export async function getEnterprisePricingProductsOrEmpty(
  _services: IServiceAccessor,
  _domain: ProviderFamilyDomain,
): Promise<EnterpriseCodingPlanPricingProduct[]> {
  return [];
}
