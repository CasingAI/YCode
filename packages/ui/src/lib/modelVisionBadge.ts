import type { ProviderConfigObject } from "@zcode/provider";

/** 产品展示例外：智谱模板自建 provider 的 GLM-5.3 图片输入是服务端桥接，不能把桥接标为原生视觉。 */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  if (supportsImage !== true) return false;
  // 智谱剥离：账号体系下线后只保留模板 personal Key 链路（见 docs/specs/zhipu-special-removal.md）。
  // 桥接例外改按 zhipu-coding-plan-api-key 模板 Key 判定，不再读已删除的 zhipu-account mode。
  const hideGlm53Vision = access?.type === "zhipu-coding-plan-api-key";
  // 只控制徽标，不改能力事实、附件校验或精确模型身份；Flash 和其他型号不受影响。
  return !(hideGlm53Vision && modelId.toLowerCase() === "glm-5.3");
}
