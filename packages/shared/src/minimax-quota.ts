/**
 * MiniMax Token Plan（api.minimaxi.com）套餐额度相关的类型与判定。
 *
 * MiniMax 在本仓库有两个模板：普通开放平台模板 `minimax`（平台 key，按量付费，
 * 无额度能力）与订阅制模板 `minimax-token-plan`（订阅 Key，查 Token Plan 配额）。
 * 两套 key 相互独立、不能混用（官方 FAQ 原话），因此额度能力只挂在新模板上。
 * host 进程 `GET https://api.minimaxi.com/v1/token_plan/remains` 读回剩余额度。
 * 产品规则见 docs/specs/minimax-quota.md。
 */

export type MiniMaxQuotaWindowKey = "interval" | "weekly";

export interface MiniMaxQuotaWindow {
  key: MiniMaxQuotaWindowKey;
  /**
   * 剩余百分比 0–100（远端 `*_remaining_percent` 原样，周窗口已叠加
   * `weekly_boost_permille` 并钳到 200）。展示端按 100 - remaining 换算成已用占比。
   */
  remainingPercent: number;
  /** 由 remains_time 换算的 ISO 重置时间；解析不到时为 null。 */
  resetAt: string | null;
  /**
   * 远端 status 原样：1=normal、2=exhausted、3=不在套餐内（该窗口不得渲染百分比）。
   * 枚举含义来自官方 CLI 源码推测，无官方文档出处，展示端只用 `=== 3` 判不在套餐。
   */
  status: number | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：provider 未配置订阅 Key，不发请求；
 * - credential-stale：订阅 Key 被官方拒绝（401/403）；
 * - unavailable：网络失败、非 2xx、响应无法解析、没有 general 桶或无可用窗口
 *   （不得当作 0% 展示）。
 */
export type MiniMaxQuotaErrorKind = "not-configured" | "credential-stale" | "unavailable";

export interface MiniMaxQuotaSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** 额度窗口（interval + weekly，最多两条）；为空表示无数据（配 error）。 */
  windows: MiniMaxQuotaWindow[];
  error: MiniMaxQuotaErrorKind | null;
  /** 面向日志的可读补充信息，绝不包含 API Key。 */
  errorMessage: string | null;
}

/** MiniMax Token Plan 订阅制模板 id（`config/provider/zcode-builtin.json`）。 */
export function isMiniMaxTokenPlanProviderTemplateId(
  templateId: string | null | undefined,
): boolean {
  return templateId === "minimax-token-plan";
}
