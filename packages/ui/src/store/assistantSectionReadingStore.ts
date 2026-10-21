export type AssistantSectionReadingMode = "continuous" | "paged" | "full";

export interface AssistantSectionScrollRequest {
  requestId: number;
  rowId: number;
  sectionId: string;
  version: string;
  /** 展开全文时恢复原章节在 Timeline 视口中的相对位置。 */
  anchorOffset?: number;
}

export interface AssistantSectionReadingState {
  mode: AssistantSectionReadingMode;
  activeSectionId: string | null;
  version: string;
  pendingScroll: AssistantSectionScrollRequest | null;
}

interface ReadingScope {
  revision: number;
  rows: Map<string, AssistantSectionReadingState>;
  presentedRows: Set<string>;
  rowRevisions: Map<string, number>;
  rowListeners: Map<string, Set<() => void>>;
  listeners: Set<() => void>;
  nextRequestId: number;
}

const scopes = new Map<string, ReadingScope>();

function getScope(scopeKey: string, create = false): ReadingScope | undefined {
  const current = scopes.get(scopeKey);
  if (current || !create) return current;
  const next: ReadingScope = {
    revision: 0,
    rows: new Map(),
    presentedRows: new Set(),
    rowRevisions: new Map(),
    rowListeners: new Map(),
    listeners: new Set(),
    nextRequestId: 1,
  };
  scopes.set(scopeKey, next);
  return next;
}

function notify(scope: ReadingScope, rowKey?: string, notifyScope = true): void {
  if (notifyScope) {
    scope.revision += 1;
    for (const listener of scope.listeners) listener();
  }
  if (rowKey !== undefined) {
    const revision = scope.rowRevisions.get(rowKey) ?? 0;
    scope.rowRevisions.set(rowKey, revision + 1);
    for (const listener of scope.rowListeners.get(rowKey) ?? []) listener();
  }
}

export function createAssistantSectionReadingScopeKey(options: {
  viewId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId?: string | null;
}): string {
  return JSON.stringify([
    options.viewId,
    options.workspaceIdentity?.trim() || options.workspacePath,
    options.remoteSessionId ?? "",
    options.sessionId ?? "draft",
  ]);
}

export function createAssistantSectionReadingRowKey(options: {
  turnId: string;
  rowId: number;
  entityId?: string;
}): string {
  return JSON.stringify([options.turnId, options.rowId, options.entityId ?? ""]);
}

export function subscribeAssistantSectionReadingScope(
  scopeKey: string,
  listener: () => void,
): () => void {
  const scope = getScope(scopeKey, true)!;
  scope.listeners.add(listener);
  return () => {
    scope.listeners.delete(listener);
    if (
      scope.listeners.size === 0 &&
      scope.rowListeners.size === 0 &&
      scope.rows.size === 0 &&
      scope.presentedRows.size === 0
    ) {
      scopes.delete(scopeKey);
    }
  };
}

export function subscribeAssistantSectionReadingRow(
  scopeKey: string,
  rowKey: string,
  listener: () => void,
): () => void {
  const scope = getScope(scopeKey, true)!;
  const listeners = scope.rowListeners.get(rowKey) ?? new Set<() => void>();
  listeners.add(listener);
  scope.rowListeners.set(rowKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) scope.rowListeners.delete(rowKey);
    if (
      scope.listeners.size === 0 &&
      scope.rowListeners.size === 0 &&
      scope.rows.size === 0 &&
      scope.presentedRows.size === 0
    ) {
      scopes.delete(scopeKey);
    }
  };
}

export function getAssistantSectionReadingRevision(scopeKey: string): number {
  return getScope(scopeKey)?.revision ?? 0;
}

export function getAssistantSectionReadingRowRevision(scopeKey: string, rowKey: string): number {
  return getScope(scopeKey)?.rowRevisions.get(rowKey) ?? 0;
}

export function getAssistantSectionReadingPendingNavigation(
  scopeKey: string,
): { rowKey: string; request: AssistantSectionScrollRequest } | undefined {
  const scope = getScope(scopeKey);
  let pending: { rowKey: string; request: AssistantSectionScrollRequest } | undefined;
  for (const [rowKey, state] of scope?.rows ?? []) {
    const request = state.pendingScroll;
    if (!request || (pending && pending.request.requestId > request.requestId)) continue;
    pending = { rowKey, request };
  }
  return pending;
}

export function getAssistantSectionReadingState(
  scopeKey: string,
  rowKey: string,
): AssistantSectionReadingState | undefined {
  return getScope(scopeKey)?.rows.get(rowKey);
}

export function wasAssistantSectionRowPresented(scopeKey: string, rowKey: string): boolean {
  return getScope(scopeKey)?.presentedRows.has(rowKey) === true;
}

export function markAssistantSectionRowPresented(scopeKey: string, rowKey: string): void {
  const scope = getScope(scopeKey, true)!;
  if (scope.presentedRows.has(rowKey)) return;
  scope.presentedRows.add(rowKey);
  notify(scope, rowKey, false);
}

export function initializeAssistantSectionReading(options: {
  scopeKey: string;
  rowKey: string;
  rowId: number;
  version: string;
  firstSectionId: string;
}): AssistantSectionReadingState {
  const scope = getScope(options.scopeKey, true)!;
  const previous = scope.rows.get(options.rowKey);
  if (previous?.version === options.version) return previous;

  const next: AssistantSectionReadingState = previous
    ? {
        // 正文换代后作废章节和定位；已经连续阅读的回答继续连续显示，其它情况安全展开全文。
        mode: previous.mode === "continuous" ? "continuous" : "full",
        activeSectionId: null,
        version: options.version,
        pendingScroll: null,
      }
    : {
        mode: scope.presentedRows.has(options.rowKey) ? "continuous" : "paged",
        activeSectionId: scope.presentedRows.has(options.rowKey) ? null : options.firstSectionId,
        version: options.version,
        pendingScroll: null,
      };
  scope.rows.set(options.rowKey, next);
  notify(scope, options.rowKey, false);
  return next;
}

export function selectAssistantReadingSection(options: {
  scopeKey: string;
  rowKey: string;
  rowId: number;
  sectionId: string;
  version: string;
}): AssistantSectionReadingState {
  const scope = getScope(options.scopeKey, true)!;
  const next: AssistantSectionReadingState = {
    mode: "paged",
    activeSectionId: options.sectionId,
    version: options.version,
    pendingScroll: {
      requestId: scope.nextRequestId++,
      rowId: options.rowId,
      sectionId: options.sectionId,
      version: options.version,
    },
  };
  scope.rows.set(options.rowKey, next);
  notify(scope, options.rowKey);
  return next;
}

export function setAssistantReadingMode(options: {
  scopeKey: string;
  rowKey: string;
  rowId: number;
  mode: AssistantSectionReadingMode;
  activeSectionId?: string | null;
  version: string;
  anchorOffset?: number;
}): void {
  const scope = getScope(options.scopeKey, true)!;
  const previous = scope.rows.get(options.rowKey);
  const pendingScroll =
    options.mode === "full" && previous?.activeSectionId && options.anchorOffset !== undefined
      ? {
          requestId: scope.nextRequestId++,
          rowId: options.rowId,
          sectionId: previous.activeSectionId,
          version: options.version,
          anchorOffset: options.anchorOffset,
        }
      : null;
  scope.rows.set(options.rowKey, {
    mode: options.mode,
    activeSectionId: options.activeSectionId ?? previous?.activeSectionId ?? null,
    version: options.version,
    pendingScroll,
  });
  notify(
    scope,
    options.rowKey,
    (previous?.pendingScroll !== null && previous?.pendingScroll !== undefined) ||
      pendingScroll !== null,
  );
}

export function revealAssistantReadingRowForSearch(scopeKey: string, rowKey: string): boolean {
  const scope = getScope(scopeKey, true)!;
  const previous = scope?.rows.get(rowKey);
  if (previous?.mode === "full" || previous?.mode === "continuous") {
    return true;
  }
  scope.rows.set(
    rowKey,
    previous
      ? { ...previous, mode: "full", pendingScroll: null }
      : { mode: "full", activeSectionId: null, version: "", pendingScroll: null },
  );
  notify(scope, rowKey);
  return false;
}

export function cancelAssistantSectionNavigation(scopeKey: string): void {
  const scope = getScope(scopeKey);
  if (!scope) return;
  const changedRowKeys: string[] = [];
  for (const [rowKey, state] of scope.rows) {
    if (!state.pendingScroll) continue;
    scope.rows.set(rowKey, { ...state, pendingScroll: null });
    changedRowKeys.push(rowKey);
  }
  for (const rowKey of changedRowKeys) notify(scope, rowKey, false);
}

export function settleAssistantSectionNavigation(
  scopeKey: string,
  rowKey: string,
  requestId: number,
): void {
  const scope = getScope(scopeKey);
  const state = scope?.rows.get(rowKey);
  if (!scope || state?.pendingScroll?.requestId !== requestId) return;
  scope.rows.set(rowKey, { ...state, pendingScroll: null });
  notify(scope, rowKey, false);
}

export function setAssistantReadingScopeMode(
  scopeKey: string,
  mode: AssistantSectionReadingMode,
): void {
  const scope = getScope(scopeKey);
  if (!scope) return;
  let changed = false;
  let hadPendingScroll = false;
  const changedRowKeys: string[] = [];
  for (const [rowKey, state] of scope.rows) {
    if (state.mode === mode && state.pendingScroll === null) continue;
    scope.rows.set(rowKey, { ...state, mode, pendingScroll: null });
    changed = true;
    hadPendingScroll ||= state.pendingScroll !== null;
    changedRowKeys.push(rowKey);
  }
  if (changed) {
    if (hadPendingScroll) scope.revision += 1;
    for (const listener of hadPendingScroll ? scope.listeners : []) listener();
    for (const rowKey of changedRowKeys) notify(scope, rowKey, false);
  }
}

export function clearAssistantSectionReadingScope(scopeKey: string): void {
  const scope = getScope(scopeKey);
  if (!scope) return;
  scope.rows.clear();
  scope.presentedRows.clear();
  notify(scope);
  if (scope.listeners.size === 0 && scope.rowListeners.size === 0) scopes.delete(scopeKey);
}
