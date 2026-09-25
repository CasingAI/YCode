export type CodingPlanEntryInventoryStatus = "loading" | "error" | "ready";

export interface CodingPlanEntryInventoryStateInput {
  /** Provider Settings 是否仍在首次加载或重新加载。 */
  readonly settingsLoading: boolean;
  /** Provider Settings 是否加载失败。 */
  readonly settingsFailed: boolean;
  /** 当前账号事实身份（见 useCodingPlanEntryPlanList 的 identity）。 */
  readonly identity: string;
  readonly user: unknown;
  readonly generation: number;
  /** 上一次查询结果绑定的身份；null 表示还没查过。 */
  readonly cached: { user: unknown; identity: string; generation: number } | null;
  /** 本次查询的两个 family 团队商品是否都拿到结果。 */
  readonly teamsResolved: boolean;
  /** 缺快照或确认失败的套餐数量。 */
  readonly missingCount: number;
  readonly entitlementLoading: boolean;
}

/**
 * 购买入口状态决策。`identity` 变化才会重新查询并进入 loading；
 * 纯设置投影变化（revision、名称、模型、Provider enabled）保持 ready。
 */
export function resolveCodingPlanEntryInventoryStatus(
  input: CodingPlanEntryInventoryStateInput,
): CodingPlanEntryInventoryStatus {
  if (input.settingsFailed) {
    return "error";
  }
  const sameIdentity =
    input.cached !== null &&
    input.cached.user === input.user &&
    input.cached.identity === input.identity;
  const current = sameIdentity && input.cached.generation === input.generation;
  const usableTeams = sameIdentity && input.teamsResolved;
  const pending = input.settingsLoading || !current || input.entitlementLoading;
  const failed = !usableTeams || input.missingCount > 0;
  return pending ? "loading" : failed ? "error" : "ready";
}
