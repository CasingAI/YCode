import { useMemo, useRef } from "react";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import { shallow } from "zustand/vanilla/shallow";

import {
  projectPendingGuideQueue,
  type PendingGuideQueueProjection,
} from "./pendingGuideProjection.js";

export interface DerivedInputScope {
  workspaceIdentity?: string;
  workspacePath: string;
  remoteSessionId?: string | null;
  sessionId?: string | null;
}

/** 作用域按字段比较，不拼接分隔符，避免特殊字符造成身份歧义。 */
export function isSameDerivedInputScope(
  left: DerivedInputScope,
  right: DerivedInputScope,
): boolean {
  return (
    (left.workspaceIdentity?.trim() || left.workspacePath) ===
      (right.workspaceIdentity?.trim() || right.workspacePath) &&
    (left.remoteSessionId ?? "") === (right.remoteSessionId ?? "") &&
    (left.sessionId ?? "") === (right.sessionId ?? "")
  );
}

export interface KnownSessionIdSources {
  sessionScopeReady: boolean;
  sessionIndexScopeCount: number;
  hydratingEndpointCount: number;
  archivedLoading: boolean;
  sessionIndexItems: readonly unknown[];
  taskMetaByEntityKey: Readonly<Record<string, unknown>>;
  archivedItems: readonly unknown[];
  sessionId?: string | null;
}

function readTaskId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const taskId = (value as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

/** 来源并集与就绪规则保持原语义；所有来源未就绪时返回 undefined（fail-open）。 */
export function buildKnownSessionIdSet(
  sources: KnownSessionIdSources,
): ReadonlySet<string> | undefined {
  if (!sources.sessionScopeReady || sources.sessionIndexScopeCount === 0) return undefined;
  if (sources.hydratingEndpointCount > 0 && sources.archivedLoading) return undefined;
  const ids = new Set<string>();
  for (const item of sources.sessionIndexItems) {
    const taskId = readTaskId(item);
    if (taskId) ids.add(taskId);
  }
  for (const meta of Object.values(sources.taskMetaByEntityKey)) {
    const taskId = readTaskId(meta);
    if (taskId) ids.add(taskId);
  }
  for (const item of sources.archivedItems) {
    const taskId = readTaskId(item);
    if (taskId) ids.add(taskId);
  }
  if (typeof sources.sessionId === "string" && sources.sessionId.trim()) {
    ids.add(sources.sessionId.trim());
  }
  return ids.size > 0 ? ids : undefined;
}

export interface KnownSessionIdSetEntry {
  scope: DerivedInputScope;
  ids: ReadonlySet<string> | undefined;
}

export function stabilizeKnownSessionIdSet(
  previous: KnownSessionIdSetEntry | null,
  scope: DerivedInputScope,
  next: ReadonlySet<string> | undefined,
): KnownSessionIdSetEntry {
  if (previous && isSameDerivedInputScope(previous.scope, scope)) {
    return shallow(previous.ids, next) ? previous : { scope, ids: next };
  }
  // 作用域变化时即使调用方复用同一个 next 集合，也要返回新引用，不能跨作用域串用。
  return { scope, ids: previous && next === previous.ids && next ? new Set(next) : next };
}

export interface PendingGuideProjectionEntry {
  scope: DerivedInputScope;
  queue: QueueState;
  projection: PendingGuideQueueProjection;
}

function samePendingGuideItems(
  left: readonly { queueItemId: string }[],
  right: readonly { queueItemId: string }[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function stabilizePendingGuideProjection(
  previous: PendingGuideProjectionEntry | null,
  scope: DerivedInputScope,
  queue: QueueState,
): PendingGuideProjectionEntry {
  if (previous && isSameDerivedInputScope(previous.scope, scope) && previous.queue === queue) {
    return previous;
  }
  const projection = projectPendingGuideQueue(queue);
  if (
    previous &&
    isSameDerivedInputScope(previous.scope, scope) &&
    samePendingGuideItems(previous.projection.pendingGuides, projection.pendingGuides)
  ) {
    return {
      scope,
      queue,
      projection: {
        pendingGuides: previous.projection.pendingGuides,
        // visibleQueue 始终来自当前权威 queue，不冻结旧队列。
        visibleQueue: projection.visibleQueue,
      },
    };
  }
  return { scope, queue, projection };
}

export function useStableKnownSessionIdSet(
  scope: DerivedInputScope,
  next: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  const { workspaceIdentity, workspacePath, remoteSessionId, sessionId } = scope;
  const previousRef = useRef<KnownSessionIdSetEntry | null>(null);
  return useMemo(() => {
    const currentScope = { workspaceIdentity, workspacePath, remoteSessionId, sessionId };
    const entry = stabilizeKnownSessionIdSet(previousRef.current, currentScope, next);
    previousRef.current = entry;
    return entry.ids;
  }, [workspaceIdentity, workspacePath, remoteSessionId, sessionId, next]);
}

export function useStablePendingGuideProjection(
  scope: DerivedInputScope,
  queue: QueueState | null | undefined,
): PendingGuideQueueProjection | null {
  const { workspaceIdentity, workspacePath, remoteSessionId, sessionId } = scope;
  const previousRef = useRef<PendingGuideProjectionEntry | null>(null);
  return useMemo(() => {
    if (!queue) {
      previousRef.current = null;
      return null;
    }
    const currentScope = { workspaceIdentity, workspacePath, remoteSessionId, sessionId };
    const entry = stabilizePendingGuideProjection(previousRef.current, currentScope, queue);
    previousRef.current = entry;
    return entry.projection;
  }, [workspaceIdentity, workspacePath, remoteSessionId, sessionId, queue]);
}
