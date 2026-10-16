import {
  dismissSessionStorageWarning,
  isSessionStorageWarningDismissed,
  scanSessionStorageUsage,
} from "@zcode/adapters";
import type { SessionId } from "@zcode/contracts";
import type { V4ConversationSessionStorageResult } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

function collectSubagentDescendantIds(
  rootSessionId: string,
  childLinks: readonly { sessionId: string; parentSessionId: string }[],
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const link of childLinks) {
    const children = childrenByParent.get(link.parentSessionId) ?? [];
    children.push(link.sessionId);
    childrenByParent.set(link.parentSessionId, children);
  }

  const visited = new Set([rootSessionId]);
  const pending = [rootSessionId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      pending.push(childId);
    }
  }
  return [...visited];
}

export function createSessionStorageWarningHost(context: ZCodeProtocolAgentServerContext) {
  const resolveSessionIds = async (sessionId: string): Promise<string[]> => {
    const live = context.sessions.get(sessionId);
    const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
    if (!live && !stored) throw new Error("fault.session.notFound");

    const children = context.deps.sessionStore
      ? await context.deps.sessionStore.listSessions({
          includeArchived: true,
          taskTypes: ["subagent_child"],
        })
      : [];
    const links = children.flatMap((session) =>
      session.parentID && session.taskType === "subagent_child"
        ? [{ sessionId: String(session.id), parentSessionId: String(session.parentID) }]
        : [],
    );
    for (const record of context.sessions.values()) {
      if (record.taskType === "subagent_child" && record.parentSessionId) {
        links.push({
          sessionId: String(record.app.sessionId),
          parentSessionId: String(record.parentSessionId),
        });
      }
    }
    return collectSubagentDescendantIds(sessionId, links);
  };

  return {
    readSessionStorageUsage: async (
      sessionId: string,
    ): Promise<V4ConversationSessionStorageResult> => {
      const sessionIds = await resolveSessionIds(sessionId);
      const roots = context.deps.sessionStorageRoots;
      const stateRoot = context.deps.sessionStorageWarningStateRoot;
      if (!roots || roots.length === 0 || !stateRoot) {
        throw new Error("fault.sessionStorage.unavailable");
      }
      const scan = await scanSessionStorageUsage({ storageRoots: roots, sessionIds });
      const dismissed = await isSessionStorageWarningDismissed(stateRoot, sessionId);
      return { sessionId, ...scan, dismissed };
    },
    dismissSessionStorageWarning: async (sessionId: string): Promise<void> => {
      await resolveSessionIds(sessionId);
      const stateRoot = context.deps.sessionStorageWarningStateRoot;
      if (!stateRoot) throw new Error("fault.sessionStorage.unavailable");
      await dismissSessionStorageWarning(stateRoot, sessionId);
    },
  };
}
