/**
 * OpenRouter（openrouter.ai）账户余额相关的类型与判定。
 *
 * OpenRouter 在本仓库是普通 api-key provider（builtin 模板 `openrouter`），
 * 只有预付积分一种计费形态，没有订阅制套餐：它的用量就是账户积分余额。
 * host 进程 `GET https://openrouter.ai/api/v1/credits` 读回
 * `data.{total_credits, total_usage}`，剩余额度由 host 侧相减得出。
 * 产品规则见 docs/specs/openrouter-balance.md。
 */

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：provider 未配置 API Key，不发请求；
 * - credential-stale：API Key 被官方拒绝（401/403，含普通 key 被 management 门槛拒绝）；
 * - unavailable：网络失败、非 2xx、响应无法解析或金额缺失（不得当作 0 展示）。
 */
export type OpenRouterBalanceErrorKind = "not-configured" | "credential-stale" | "unavailable";

export interface OpenRouterBalanceSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** 累计充值积分（USD）；解析不出时为 null。 */
  totalCredits: number | null;
  /** 累计已用积分（USD）；解析不出时为 null。 */
  totalUsage: number | null;
  /** 剩余额度（USD）= total_credits - total_usage；任一缺失时为 null。 */
  remaining: number | null;
  error: OpenRouterBalanceErrorKind | null;
  /** 面向日志的可读补充信息，绝不包含 API Key。 */
  errorMessage: string | null;
}

/** OpenRouter builtin 模板 id（`config/provider/zcode-builtin.json`）。 */
export function isOpenRouterProviderTemplateId(templateId: string | null | undefined): boolean {
  return templateId === "openrouter";
}
