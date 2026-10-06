/**
 * 构造当前 workspace 的 sessions-index 订阅 scope。
 *
 * 口径必须与 `useWorkspaceTaskLists` 的 `sessionsIndexScopes` 完全一致，否则同一
 * endpoint+workspace 会被 `sessionsIndexRegistry` 登记成两条 entry：多建 store、多发一条
 * subscribe；若两条 entry 的 workspaceKey 相同而 agentService 不同，还可能把侧栏正在使用的
 * 本机 `__base__` entry 挤掉。
 *
 * 泛型化 agentService 是为了让本模块不 import 任何运行时符号——它承载唯一的失效风险，
 * 必须能被 node --test 单独覆盖。
 */
export interface SessionsIndexScopeShape<TAgentService> {
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度（远端 shard 的 remoteSessionId）；缺省 = 本机 `__base__`。 */
  endpointKey?: string;
  agentService: TAgentService;
}

export interface BuildSessionsIndexScopesParams<TAgentService> {
  workspacePath: string;
  workspaceIdentity?: string;
  /** workspace attachment 已解析到真实远端 session；本机与远端就绪态为 null。 */
  resolvedRemoteSessionId: string | null;
  /**
   * 远端 attachment 是否就绪（`connectionKind !== "remote-waiting"`）。
   *
   * remote-waiting 时 `useWorkspaceServicesResolution` 给的是断连代理 services，而
   * `useWorkspaceTaskLists` 在同一状态下整条 config 直接 skip、不进 scopes。若这里仍构造
   * scope，就会拿断连代理在 `__base__` key 上新建一条 entry——既订阅失败，又可能挤掉同
   * workspaceKey 的本机 entry。
   */
  targetReady: boolean;
  agentService: TAgentService;
}

export function buildSessionsIndexScopes<TAgentService>(
  params: BuildSessionsIndexScopesParams<TAgentService>,
): Array<SessionsIndexScopeShape<TAgentService>> {
  if (!params.targetReady) {
    return [];
  }

  return [
    {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      // 省略规则对齐 useWorkspaceTaskLists 的 shardKey：`remoteSessionId ?? "__base__"`，
      // 本机不带 endpointKey，远端 shard 才带。
      ...(params.resolvedRemoteSessionId ? { endpointKey: params.resolvedRemoteSessionId } : {}),
      agentService: params.agentService,
    },
  ];
}
