// useWorkspaceSessionsIndexItems 的纯聚合核心：sessions-index store → 侧栏实时 meta。
// 成本分层（docs/specs/sessions-index-activity-flush-coalescing.md）：
//   scope 级：store 代次（logEpoch/seq/status）不变 → 整份 metas 引用复用，零重算；
//   会话级：代次变化时逐条按 summary 引用判等，仅重映射引用变化的会话。
// 状态所有者仍是 store；本模块只持有派生缓存，任一代次失配即整层重建。
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSummaryToTaskMeta } from "@/v4/mapSessionSummaryToTaskMeta.js";
import type { TaskListMetaWithActivity } from "@/v4/taskListRowActivity.js";

/** store 读口的最小结构面（真实 SessionsIndexStore 的子集，纯函数测试可注入桩）。 */
export interface SessionsIndexStoreLike {
  getSessions(): readonly SessionSummary[];
}

/** scope 的映射输入：workspace 字段进 meta；identity 参与 previous 回退键。 */
export interface SessionsIndexScopeMapping {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 一个 scope 的派生缓存：store 实例 + 代次串双命中才复用。 */
export interface ScopeMetasCacheEntry {
  store: SessionsIndexStoreLike;
  storeRevision: string;
  metas: TaskListMetaWithActivity[];
  byId: Map<string, { summary: SessionSummary; meta: TaskListMetaWithActivity }>;
}

/** 与旧聚合路径同一口径的 previous 回退键（跨 tick 保住 titleOverridden/unreadAt 等旧值）。 */
function previousFallbackKey(mapping: SessionsIndexScopeMapping, sessionId: string): string {
  return `${mapping.workspaceIdentity?.trim() || mapping.workspacePath}::${sessionId}`;
}

/**
 * 派生某个 scope 的实时 metas 并更新缓存。
 *
 * - `cached` 命中（同 store 实例 + 同代次串）时原样返回，metas 引用不变；
 * - 失配时逐条判等：summary 引用相同 → 复用旧 meta；否则带 previous 重映射。
 *   `previousByKey` 是跨 tick 的旧 meta 表（键 `identity||path::taskId`），
 *   冷缓存（store 重订/断档重置）时仍能保住手动标题、未读等旧字段。
 */
export function mapSessionsIndexScopeMetas(
  store: SessionsIndexStoreLike,
  storeRevision: string,
  mapping: SessionsIndexScopeMapping,
  cached: ScopeMetasCacheEntry | undefined,
  previousByKey?: ReadonlyMap<string, ZCodeTaskMeta>,
): ScopeMetasCacheEntry {
  if (cached && cached.store === store && cached.storeRevision === storeRevision) {
    return cached;
  }
  const sessions = store.getSessions();
  const byId = new Map<string, { summary: SessionSummary; meta: TaskListMetaWithActivity }>();
  const metas: TaskListMetaWithActivity[] = [];
  for (const summary of sessions) {
    const cachedEntry = cached?.byId.get(summary.sessionId);
    const previous =
      cachedEntry?.summary === summary
        ? cachedEntry.meta
        : mapSessionSummaryToTaskMeta(summary, {
            workspacePath: mapping.workspacePath,
            ...(mapping.workspaceIdentity ? { workspaceIdentity: mapping.workspaceIdentity } : {}),
            previous:
              cachedEntry?.meta ??
              previousByKey?.get(previousFallbackKey(mapping, summary.sessionId)),
          });
    // 以当次 store 列表重建 byId：会话被 remove 后缓存条目随之淘汰，无残留。
    byId.set(summary.sessionId, { summary, meta: previous });
    metas.push(previous);
  }
  return { store, storeRevision, metas, byId };
}
