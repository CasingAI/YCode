/**
 * DeepSeek（api.deepseek.com）账户余额相关的类型与判定。
 *
 * DeepSeek 在本仓库是普通 api-key provider（builtin 模板 `deepseek`），不是订阅套餐：
 * 它没有「剩余额度 / 重置时间」这类周期用量口径，账户用量就是官方余额。因此本能力
 * 不新增凭据存储——查询用的就是 provider 自身已配置的 API key，
 * host 进程 `GET https://api.deepseek.com/user/balance` 读回余额。
 * 产品规则见 docs/specs/deepseek-balance.md。
 */

/** 单币种余额。三个金额都来自远端十进制字符串，解析失败时为 null。 */
export interface DeepSeekBalanceInfo {
  /** 远端原文，如 "CNY" / "USD"；未知币种也原样透出。 */
  currency: string;
  /** 账户总余额。 */
  totalBalance: number | null;
  /** 赠送余额。 */
  grantedBalance: number | null;
  /** 充值余额。 */
  toppedUpBalance: number | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：provider 未配置 API Key，不发请求；
 * - credential-stale：API Key 被官方拒绝（401/403）；
 * - unavailable：网络失败、非 2xx、响应无法解析或没有任何币种（不得当作 0 展示）。
 */
export type DeepSeekBalanceErrorKind = "not-configured" | "credential-stale" | "unavailable";

export interface DeepSeekBalanceSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /**
   * 官方是否认为余额足以调用 API。响应缺失该字段时为 null
   * （不猜：不展示「余额不足」，也不展示「可调用」）。
   */
  isAvailable: boolean | null;
  /** 余额条目，一个账号可能同时返回 CNY 与 USD；为空表示无数据（配 error）。 */
  balances: DeepSeekBalanceInfo[];
  error: DeepSeekBalanceErrorKind | null;
  /** 面向日志的可读补充信息，绝不包含 API Key。 */
  errorMessage: string | null;
}

/** DeepSeek builtin 模板 id（`config/provider/zcode-builtin.json`）。 */
export function isDeepSeekProviderTemplateId(templateId: string | null | undefined): boolean {
  return templateId === "deepseek";
}
