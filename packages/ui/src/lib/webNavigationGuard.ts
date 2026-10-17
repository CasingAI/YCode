import { isWebUrlSyncEnabled } from "./webUrlSyncControl.js";

export interface WebNavigationBlocker {
  isDirty: () => boolean;
  confirmLeave: () => Promise<boolean>;
}

const blockers = new Set<WebNavigationBlocker>();
const listeners = new Set<() => void>();
interface ActiveNavigationDecision {
  requestId: number;
  action: () => void;
  allowWhen: () => boolean;
  confirmedBlockers: Set<WebNavigationBlocker>;
  promise: Promise<boolean>;
}

let activeDecision: ActiveNavigationDecision | null = null;
let navigationRequestId = 0;
let approvedActionDepth = 0;

function notifyBlockersChanged(): void {
  for (const listener of listeners) listener();
}

export function registerWebNavigationBlocker(blocker: WebNavigationBlocker): () => void {
  blockers.add(blocker);
  notifyBlockersChanged();
  return () => {
    blockers.delete(blocker);
    notifyBlockersChanged();
  };
}

export function subscribeWebNavigationBlockers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasDirtyWebNavigationBlockers(): boolean {
  for (const blocker of blockers) {
    if (blocker.isDirty()) return true;
  }
  return false;
}

export function notifyWebNavigationBlockerStateChanged(): void {
  notifyBlockersChanged();
}

export function runWebNavigation(
  action: () => void,
  options: { allowWhen?: () => boolean } = {},
): Promise<boolean> {
  const requestId = ++navigationRequestId;
  const allowWhen = options.allowWhen ?? (() => true);
  if (!isWebUrlSyncEnabled() || approvedActionDepth > 0) {
    const allowed = allowWhen();
    if (allowed) action();
    return Promise.resolve(allowed);
  }

  if (activeDecision) {
    activeDecision.requestId = requestId;
    activeDecision.action = action;
    activeDecision.allowWhen = allowWhen;
    return activeDecision.promise;
  }

  if (!hasDirtyWebNavigationBlockers()) {
    const allowed = allowWhen();
    if (allowed) action();
    return Promise.resolve(allowed);
  }

  const decision: ActiveNavigationDecision = {
    requestId,
    action,
    allowWhen,
    confirmedBlockers: new Set(),
    promise: Promise.resolve(false),
  };
  activeDecision = decision;
  decision.promise = (async () => {
    try {
      while (true) {
        const currentRequestId = decision.requestId;
        const blocker = [...blockers].find(
          (candidate) => candidate.isDirty() && !decision.confirmedBlockers.has(candidate),
        );
        if (!blocker) {
          if (currentRequestId !== navigationRequestId) continue;
          break;
        }

        const confirmed = await blocker.confirmLeave();
        // 脏状态可能在弹窗期间被保存或卸载；此时确认结果不再代表当前仍需保护的页面。
        if (!blockers.has(blocker) || !blocker.isDirty()) continue;
        if (!confirmed) return false;
        decision.confirmedBlockers.add(blocker);
        if (decision.requestId !== currentRequestId || currentRequestId !== navigationRequestId) {
          continue;
        }
      }

      if (decision.requestId !== navigationRequestId) return false;
      if (!decision.allowWhen()) return false;
      approvedActionDepth += 1;
      try {
        decision.action();
      } finally {
        approvedActionDepth -= 1;
      }
      return true;
    } finally {
      if (activeDecision === decision) activeDecision = null;
    }
  })();
  return decision.promise;
}

export function invalidatePendingWebNavigation(): void {
  navigationRequestId += 1;
}

export function installWebBeforeUnloadGuard(): () => void {
  if (!isWebUrlSyncEnabled() || typeof window === "undefined") return () => {};
  let installed = false;
  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasDirtyWebNavigationBlockers()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const handleBlockerChange = () => {
    const shouldInstall = hasDirtyWebNavigationBlockers();
    if (shouldInstall === installed) return;
    installed = shouldInstall;
    if (shouldInstall) {
      window.addEventListener("beforeunload", handleBeforeUnload);
    } else {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    }
  };
  const unsubscribe = subscribeWebNavigationBlockers(handleBlockerChange);
  handleBlockerChange();
  return () => {
    unsubscribe();
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}
