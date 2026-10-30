/**
 * Command Code（CommandCode.ai）套餐额度相关的类型与判定。
 *
 * 套餐制供应商：月度美元额度 + 5 小时/7 天滚动窗口限速，模型覆盖 DeepSeek/GLM/
 * Kimi/Claude/GPT 等（Provider API `https://api.commandcode.ai/provider/v1`）。
 * host 进程 `GET https://api.commandcode.ai/alpha/billing/credits`（Bearer key）
 * 单次读回余额与双窗口；该端点为官方 CLI 内部接口、无文档兼容承诺，链路挂 Beta。
 * 产品规则见 docs/specs/commandcode-quota.md。
 */

export type CommandCodeQuotaWindowKey = "five-hour" | "weekly";

export interface CommandCodeQuotaWindow {
  key: CommandCodeQuotaWindowKey;
  /** 窗口内已用金额（美元，远端 used 原样）。 */
  used: number;
  /** 窗口上限金额（美元，远端 cap 原样）；解析层保证 > 0。 */
  cap: number;
  /** 已用百分比 0–100（used/cap×100 钳制）。 */
  usagePercent: number;
  /** 远端 exceeded 原样：true 表示已触顶，展示端标注「已用尽」。 */
  exceeded: boolean;
  /** 由 resetAt 毫秒时间戳换算的 ISO 重置时间；解析不到时为 null。 */
  resetAt: string | null;
}

/** 余额三项；null 表示远端未上报该字段——不得当作 0 展示。 */
export interface CommandCodeQuotaCredits {
  monthly: number | null;
  purchased: number | null;
  free: number | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：provider 未配置 API Key，不发请求；
 * - credential-stale：key 被官方拒绝（401/403）；
 * - unavailable：网络失败、非 2xx、响应无法解析、没有任何可用窗口
 *   （不得当作 0% 展示）。
 */
export type CommandCodeQuotaErrorKind = "not-configured" | "credential-stale" | "unavailable";

export interface CommandCodeQuotaSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** 额度窗口（five-hour + weekly，最多两条）；为空表示无数据（配 error）。 */
  windows: CommandCodeQuotaWindow[];
  /** 余额三项；三项全 null 表示远端未上报 credits（不渲染余额行，不算错误）。 */
  credits: CommandCodeQuotaCredits | null;
  error: CommandCodeQuotaErrorKind | null;
  /** 面向日志的可读补充信息，绝不包含 API Key。 */
  errorMessage: string | null;
}

/** Command Code 订阅制模板 id（`config/provider/zcode-builtin.json`）。 */
export function isCommandCodeProviderTemplateId(templateId: string | null | undefined): boolean {
  return templateId === "commandcode";
}
