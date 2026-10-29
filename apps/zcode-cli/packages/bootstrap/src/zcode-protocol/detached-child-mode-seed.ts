import {
  SESSION_ENTRY_EXECUTION_STATE,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { resolvePersistedExecutionMode, type ExecutionPermissionMode } from "@zcode/shared";

export type DetachedChildModeSeedStore = Pick<SessionStorePort, "getSession" | "sessionEntries">;

/** runner 预建 child 不写权限列；与 runtime 恢复共用执行状态条目，缺失时才读旧权限列。 */
export async function resolveDetachedChildModeSeed(
  store: DetachedChildModeSeedStore,
  sessionId: SessionId,
): Promise<ExecutionPermissionMode | undefined> {
  const entries = await store.sessionEntries?.({
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
  });
  const entryMode = resolvePersistedExecutionMode(entries?.at(-1)?.data);
  if (entryMode !== undefined) return entryMode;

  const childSession = await store.getSession(sessionId);
  return resolvePersistedExecutionMode(childSession?.permission?.mode);
}
