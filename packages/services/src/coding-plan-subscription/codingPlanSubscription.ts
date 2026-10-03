import type {
  CodingPlanStaticTeamProductsConfig,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  ForceUpdateConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** mock 演示强制通道：真实路径不下发，UI 使用 Host 的 Account support。 */
  readonly codingPlanActive?: boolean;
}

/**
 * 订阅服务的存活面：套餐状态展示（静态团队目录、Start Plan 权益预览、企业定价）
 * 与平台能力配置（闲时灰度、上下文预算、强更）。购买/支付/下单接口已随付费引导
 * 一并移除——App 对所有供应商一视同仁，不承担任何付费引导（见 docs/specs/coding-plan-purchase-removal.md）。
 */
export interface ICodingPlanSubscriptionService {
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  /** 闲时任务灰度配置：forceRefresh 供入口打开时补拉（绕过 1h 快照缓存）。 */
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);
