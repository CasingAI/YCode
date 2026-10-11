// 会话引用反查：sessionId → (workspacePath, workspaceIdentity)
// （docs/specs/assistant-session-citation.md「跳转范围」）。
//
// 纯函数 + 注入 items：本模块不碰 store、索引 hook 与 DOM，可直接单测。
// 反查只在本地已加载的会话索引里做，不做跨 Host 查询、不新增协议。
export interface SessionCitationWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface SessionCitationWorkspaceCandidate {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 从已加载的会话索引 items 里找 sessionId 所属的工作区。
 * 同一 sessionId 在多个 authority 下重复时优先返回与当前工作区同 key 的那条；
 * 都不匹配时返回第一条；找不到返回 null（调用方回退当前工作区）。
 */
export function resolveSessionCitationWorkspace(
  items: readonly SessionCitationWorkspaceCandidate[],
  sessionId: string,
  current?: { workspacePath: string; workspaceIdentity?: string },
): SessionCitationWorkspace | null {
  const target = sessionId.trim();
  if (!target) return null;
  let fallback: SessionCitationWorkspace | null = null;
  for (const item of items) {
    if (item.taskId !== target) continue;
    const candidate: SessionCitationWorkspace = {
      workspacePath: item.workspacePath,
      ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    };
    if (!fallback) fallback = candidate;
    if (
      current &&
      item.workspacePath === current.workspacePath &&
      (item.workspaceIdentity ?? "") === (current.workspaceIdentity ?? "")
    ) {
      return candidate;
    }
  }
  return fallback;
}
