// 把若干 workspace scope 的 sessions-index 会话聚合成 ZCodeTaskMeta[]（响应式），
// 作为侧栏各列表的实时 activity/detail 输入；持久行集合由 tasks-index 提供。
// 多消费者共享：同一 endpoint+workspace 的订阅经 sessionsIndexRegistry 引用计数复用（地基）。
// scope 携带 endpoint 维度与该 endpoint 的 agentService（resolveWorkspaceServices 产物），
// remote shard（web/手机远控/SSH workspace）经 @zcode/rpc proxy 走同一条 sessions-index 链路。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { measureRendererPerformance } from "@/lib/rendererPerformanceDiagnostics.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import {
  buildTaskListItemIdentityKey,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";
import {
  mapSessionsIndexScopeMetas,
  type ScopeMetasCacheEntry,
} from "@/v4/workspaceSessionsIndexMetas.js";
import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  buildSessionsIndexEntryKey,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import {
  WorkspaceSessionsIndexSubscriptionSet,
  type WorkspaceSessionsIndexBinding,
} from "@/v4/workspaceSessionsIndexSubscriptionSet.js";

export interface WorkspaceSessionsIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度（remote shard 的 remoteSessionId）；缺省 = 本机 __base__。 */
  endpointKey?: string;
  /** scope 所属 endpoint 的 agent service（resolveWorkspaceServices 产物）；缺省 = base services。 */
  agentService?: SessionsIndexAgentService;
}

interface WorkspaceSessionsIndexItemsResult {
  /** 聚合会话 meta（running 置顶；其余按 updatedAt 降序；tick 驱动重算，引用稳定）。 */
  items: ZCodeTaskMeta[];
  /**
   * 每个 endpoint + workspace scope 的只读代次。包含 service binding 与 store 的
   * logEpoch/seq，供异步 tasks-index membership join 精确拒绝旧 activity 快照。
   */
  sourceRevisionByScopeKey: Readonly<Record<string, string>>;
  /**
   * 已订阅但尚未收到首个 snapshot 的 endpoint（"__base__" 或 remoteSessionId）。
   * 消费者用它维持 loading/syncing 提示，避免远端首帧未到时把列表当成空。
   */
  hydratingEndpointKeys: string[];
}

/** workspace 复用键 = services resolveWorkspaceKey 口径（identity ?? path）。 */
function workspaceKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

function entryKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return buildSessionsIndexEntryKey({
    workspaceKey: workspaceKeyOf(scope),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  });
}

export function buildWorkspaceSessionsIndexSourceKey(
  scope: Pick<WorkspaceSessionsIndexScope, "workspacePath" | "workspaceIdentity" | "endpointKey">,
): string {
  return entryKeyOf(scope);
}

function toRegistryScope(scope: WorkspaceSessionsIndexScope): SessionsIndexScope {
  return {
    workspaceKey: workspaceKeyOf(scope),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  };
}

function buildScopeBindingKey(
  scope: WorkspaceSessionsIndexScope,
  agentService: SessionsIndexAgentService,
): string {
  return `${buildSessionsIndexEntryKey(toRegistryScope(scope), agentService)}\0path:${scope.workspacePath}`;
}

/** store 尚未持有任何 snapshot（connecting/首帧未到）；error 不算 hydrating（避免永久 loading）。 */
function isHydratingStore(store: SessionsIndexStore): boolean {
  return (
    store.getState().workspaceId === null &&
    (store.getStatus() === "idle" || store.getStatus() === "connecting")
  );
}

/**
 * 订阅给定 workspace scope 的 sessions-index，聚合出 ZCodeTaskMeta[]（running 置顶，其余按 updatedAt 降序）。
 * 生命周期：scope 集合变化时按引用计数 acquire/release 共享 store；任一 store 变化即重算。
 * sessions-index 帧经 CLI 合并窗口约束（activity-only 不再逐事件直发）；
 * 本 hook 的重算成本按 scope 代次 + summary 引用分层缓存，
 * 长会话高频活动不再触发全量重映射（docs/specs/sessions-index-activity-flush-coalescing.md）。
 */
export function useWorkspaceSessionsIndexItems(
  scopes: WorkspaceSessionsIndexScope[],
): WorkspaceSessionsIndexItemsResult {
  const baseServices = useBaseWorkspaceServices();
  const baseAgentService = baseServices.zcodeAgentService;

  // scope 签名稳定化，避免每渲染重算协调；effect/memo 通过 ref 读取内容等价的最新 scopes。
  // endpointKey、workspacePath 或 agentService generation 变化都会换签名。
  const signature = useMemo(
    () =>
      scopes
        .map((scope) => {
          const agentService = scope.agentService ?? baseAgentService;
          return agentService
            ? buildScopeBindingKey(scope, agentService)
            : `${entryKeyOf(scope)} ${scope.workspacePath} service-unavailable`;
        })
        .sort()
        .join("|"),
    [scopes, baseAgentService],
  );
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;

  // tick：任一 store 变化 +1，驱动聚合 memo 重算。
  const [tick, setTick] = useState(0);
  const bumpTick = useCallback(() => setTick((n) => n + 1), []);
  const subscriptionSetRef = useRef<WorkspaceSessionsIndexSubscriptionSet | null>(null);
  if (subscriptionSetRef.current === null) {
    subscriptionSetRef.current = new WorkspaceSessionsIndexSubscriptionSet(bumpTick);
  }
  const subscriptionSet = subscriptionSetRef.current;

  useEffect(() => {
    const bindings: WorkspaceSessionsIndexBinding[] = [];
    for (const scope of scopesRef.current) {
      // 防御：测试/降级环境可能没有 zcodeAgentService（sessions-index 传输面），此时不订阅该 scope。
      const agentService = scope.agentService ?? baseAgentService;
      if (!agentService) {
        continue;
      }
      bindings.push({ scope: toRegistryScope(scope), agentService });
    }
    subscriptionSet.reconcile(bindings);
    // signature 覆盖 scopes、endpoint、workspacePath 与 service generation 变化；
    // reconcile 只 acquire/release 真正发生变化的绑定。
  }, [signature, baseAgentService, subscriptionSet]);

  useEffect(
    () => () => {
      subscriptionSet.dispose();
    },
    [subscriptionSet],
  );

  // 从各 store 聚合会话 → ZCodeTaskMeta + hydration 状态（tick 驱动重算，引用稳定）。
  // per-scope 派生缓存：binding 变化/重订阅换代时由 store 实例 + 代次串自动失效，
  // scope 撤销后按当次 touched 集合淘汰，防止旧 store 引用驻留。
  const scopeCacheRef = useRef(new Map<string, ScopeMetasCacheEntry>());
  const previousItemsRef = useRef<ZCodeTaskMeta[]>([]);
  const previousHydratingRef = useRef<string[]>([]);
  return useMemo(
    () =>
      measureRendererPerformance("sessions-index.items", () => {
        const metas: ZCodeTaskMeta[] = [];
        const hydratingEndpointKeys = new Set<string>();
        const sourceRevisionByScopeKey: Record<string, string> = {};
        const previousByKey = new Map(
          previousItemsRef.current.map((meta) => [buildTaskListItemIdentityKey(meta), meta]),
        );
        const touchedBindingKeys = new Set<string>();
        for (const scope of scopesRef.current) {
          const sourceKey = entryKeyOf(scope);
          const agentService = scope.agentService ?? baseAgentService;
          const bindingRevision = agentService
            ? buildScopeBindingKey(scope, agentService)
            : `${sourceKey} service-unavailable`;
          touchedBindingKeys.add(bindingRevision);
          const store = subscriptionSet.getStore({
            workspaceKey: workspaceKeyOf(scope),
            ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
          });
          if (!store) {
            sourceRevisionByScopeKey[sourceKey] = `${bindingRevision}:missing`;
            continue;
          }
          const storeState = store.getState();
          const storeRevision = `${storeState.logEpoch ?? "none"}:${storeState.seq}:${store.getStatus()}`;
          sourceRevisionByScopeKey[sourceKey] = `${bindingRevision}:${storeRevision}`;
          if (isHydratingStore(store)) {
            hydratingEndpointKeys.add(scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT);
          }
          // 成本分层：代次不变复用整份 metas；变化时仅重映射引用变化的 summary。
          const entry = mapSessionsIndexScopeMetas(
            store,
            storeRevision,
            {
              workspacePath: scope.workspacePath,
              ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            },
            scopeCacheRef.current.get(bindingRevision),
            previousByKey,
          );
          scopeCacheRef.current.set(bindingRevision, entry);
          metas.push(...entry.metas);
        }
        for (const key of scopeCacheRef.current.keys()) {
          if (!touchedBindingKeys.has(key)) scopeCacheRef.current.delete(key);
        }
        metas.sort((a, b) => compareZCodeTaskListItems(a, b, "updated"));
        // 引用稳定化语义保持：等价条目复用旧对象；整表等价复用旧数组，
        // 让依赖数组身份的 effect 全部短路。逐条判等在引用相等处短路，
        // 高频活动 tick 的深比较只落在真正变化的会话上。
        const items = stabilizeTaskListItems(previousItemsRef.current, metas);
        previousItemsRef.current = items;
        const nextHydrating = [...hydratingEndpointKeys].sort();
        const hydrating =
          nextHydrating.length === previousHydratingRef.current.length &&
          nextHydrating.every((key, index) => key === previousHydratingRef.current[index])
            ? previousHydratingRef.current
            : nextHydrating;
        previousHydratingRef.current = hydrating;
        return {
          items,
          sourceRevisionByScopeKey,
          hydratingEndpointKeys: hydrating,
        };
      }),
    [signature, subscriptionSet, tick],
  );
}
