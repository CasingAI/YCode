import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";
import type { WorkspaceShellPrimaryView } from "@/app-shell/types.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import { logger } from "@/logger.js";
import { isWebUrlSyncEnabled } from "@/lib/webUrlSyncControl.js";
import {
  installWebBeforeUnloadGuard,
  invalidatePendingWebNavigation,
  runWebNavigation,
} from "@/lib/webNavigationGuard.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSectionIntent,
  type SettingsPluginTabTarget,
  type SettingsUsageTabTarget,
} from "@/lib/settingsNavigation.js";
import {
  buildWebRouteLocation,
  parseWebRoute,
  webRouteEquals,
  type WebRoute,
} from "@/lib/webRoute.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import type { AutomationsNavigationTarget } from "./useWorkspaceTaskNavigation.js";
import type { WorkspaceMainView } from "./types.js";

export interface WebUrlSyncParams {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  workspaceMainView: WorkspaceMainView;
  shellPrimaryView?: WorkspaceShellPrimaryView;
  webRoutePosition?: Extract<WebRoute, { kind: "settings" | "plugin-store" }>;
  routePositionReplaceRequested?: boolean;
  onRoutePositionReplaceConsumed?: () => void;
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  onNavigateToTask: () => void;
  onNavigateToAutomations: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore: (pluginId?: string) => void;
  onNavigationPositionChange: (
    route: WebRoute,
    options?: { replace?: boolean },
  ) => void;
  resolveTaskWorkspace: (
    taskId: string,
  ) => Promise<{ workspacePath: string; workspaceIdentity?: string } | null>;
}

interface PendingTaskRoute {
  route: WebRoute;
  base: WebRoute;
}

interface ManagedHistoryState {
  __zcodeWebRouteEntry?: number;
}

const HISTORY_ENTRY_KEY = "__zcodeWebRouteEntry";

function getHistoryEntryId(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const id = (state as ManagedHistoryState)[HISTORY_ENTRY_KEY];
  return typeof id === "number" && Number.isInteger(id) ? id : undefined;
}

export function useWebUrlSync(params: WebUrlSyncParams): boolean {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    workspaceMainView,
    shellPrimaryView,
    webRoutePosition,
    routePositionReplaceRequested = false,
    onRoutePositionReplaceConsumed,
    openAutomationId,
    openAutomationTab,
    onNavigateToTask,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    onNavigationPositionChange,
    resolveTaskWorkspace,
  } = params;

  const enabled = isWebUrlSyncEnabled();
  const activePrimaryView = useTabStore((state) =>
    resolveWorkspaceShellPrimaryView(
      state.tabs.find((candidate) => candidate.id === state.activeTabId),
    ),
  );
  const primaryView = shellPrimaryView ?? activePrimaryView;
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const openFilesTab = useTabStore((state) => state.openFilesTab);
  const openBotsTab = useTabStore((state) => state.openBotsTab);
  const activeBotId = useBotRosterStore((state) => state.activeBotId);
  const setActiveBot = useBotRosterStore((state) => state.setActiveBot);
  const ensureWorkspaceTab = useTabStore((state) => state.ensureWorkspaceTab);
  const activateTab = useTabStore((state) => state.activateTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);

  const [pendingTaskRoute, setPendingTaskRoute] =
    useState<PendingTaskRoute | null>(null);
  const coldStartRouteRef = useRef<WebRoute | undefined>(undefined);
  const routeRequestIdRef = useRef(0);
  const historyEntrySequenceRef = useRef(0);
  const currentHistoryEntryRef = useRef<number | undefined>(undefined);
  const previousHistoryEntryRef = useRef<number | undefined>(undefined);
  const restoringHistoryRef = useRef(false);
  const applyingPopStateRef = useRef(false);
  const applyingPopRouteRef = useRef<WebRoute | null>(null);
  const replacePositionRef = useRef(false);
  replacePositionRef.current = routePositionReplaceRequested;
  const replaceConsumedRef = useRef(onRoutePositionReplaceConsumed);
  replaceConsumedRef.current = onRoutePositionReplaceConsumed;
  const restoreTargetEntryIdRef = useRef<number | undefined>(undefined);
  const knownPreviousEntryRef = useRef(new Map<number, number>());
  const knownNextEntryRef = useRef(new Map<number, number>());

  const stateRoute = useMemo<WebRoute>(() => {
    if (primaryView === "settings") {
      return webRoutePosition?.kind === "settings"
        ? webRoutePosition
        : { kind: "settings" };
    }
    if (primaryView === "files") return { kind: "files" };
    if (primaryView === "bots")
      return activeBotId
        ? { kind: "bots", botId: activeBotId }
        : { kind: "bots" };
    if (workspaceMainView === "automations") {
      return {
        kind: "automations",
        ...(openAutomationId ? { automationId: openAutomationId } : {}),
        ...(openAutomationTab ? { automationTab: openAutomationTab } : {}),
      };
    }
    if (workspaceMainView === "plugin-store") {
      return webRoutePosition?.kind === "plugin-store"
        ? webRoutePosition
        : { kind: "plugin-store" };
    }
    return activeTaskId
      ? { kind: "task", taskId: activeTaskId }
      : { kind: "home" };
  }, [
    primaryView,
    workspaceMainView,
    openAutomationId,
    openAutomationTab,
    activeTaskId,
    activeBotId,
    webRoutePosition,
  ]);

  const currentRouteRef = useRef(stateRoute);
  currentRouteRef.current = stateRoute;
  const stateRouteRef = useRef(stateRoute);
  stateRouteRef.current = stateRoute;
  const currentHistoryEntryRefLatest = currentHistoryEntryRef;

  const replaceLocationWithStateRoute = useCallback(() => {
    const { pathname, search } = buildWebRouteLocation(stateRouteRef.current);
    const entryId =
      currentHistoryEntryRefLatest.current ?? ++historyEntrySequenceRef.current;
    currentHistoryEntryRefLatest.current = entryId;
    window.history.replaceState(
      { [HISTORY_ENTRY_KEY]: entryId },
      "",
      `${pathname}${search}`,
    );
  }, [currentHistoryEntryRefLatest]);

  const inferHistoryDelta = useCallback(
    (targetEntryId?: number, originEntryId?: number) => {
      if (targetEntryId === undefined || originEntryId === undefined)
        return undefined;
      if (knownPreviousEntryRef.current.get(originEntryId) === targetEntryId)
        return -1;
      if (knownNextEntryRef.current.get(originEntryId) === targetEntryId)
        return 1;
      return undefined;
    },
    [],
  );

  const applyRoute = useCallback(
    (route: WebRoute) => {
      const requestId = ++routeRequestIdRef.current;

      if (route.kind === "settings") {
        setPendingTaskRoute(null);
        setPendingSettingsSectionIntent(route.section ?? "general", {
          ...(route.usageTab
            ? { usageTab: route.usageTab as SettingsUsageTabTarget }
            : {}),
          ...(route.pluginTab
            ? { pluginTab: route.pluginTab as SettingsPluginTabTarget }
            : {}),
          ...(route.providerId ? { modelProviderId: route.providerId } : {}),
        });
        onNavigationPositionChange(route);
        openSettingsTab();
        return;
      }

      if (route.kind === "files") {
        setPendingTaskRoute(null);
        openFilesTab();
        return;
      }

      if (route.kind === "bots") {
        setPendingTaskRoute(null);
        openBotsTab();
        if (route.botId) setActiveBot(route.botId);
        return;
      }

      const ensureWorkspaceTabActive = () => {
        if (primaryView !== "tasks") {
          activateTabByPath(
            workspaceAbsPath,
            workspaceIdentity ? { workspaceIdentity } : undefined,
          );
        }
      };

      if (route.kind === "home") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToTask();
        useZCodeSessionStore
          .getState()
          .startDraft(workspaceAbsPath, undefined, workspaceIdentity);
        return;
      }

      if (route.kind === "plugin-store") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToPluginStore(route.pluginId);
        return;
      }

      if (route.kind === "automations") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToAutomations({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(route.automationId ? { automationId: route.automationId } : {}),
          ...(route.automationTab
            ? { automationTab: route.automationTab }
            : {}),
        });
        return;
      }

      if (route.taskId === activeTaskId) {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToTask();
        return;
      }

      const base = stateRouteRef.current;
      setPendingTaskRoute({ route, base });
      void resolveTaskWorkspace(route.taskId)
        .then((target) => {
          if (requestId !== routeRequestIdRef.current) return;
          setPendingTaskRoute(null);
          if (!webRouteEquals(stateRouteRef.current, base)) return;
          if (!target) {
            logger.warn("[web-url-sync] 深链任务无法解析为 workspace", {
              taskId: route.taskId,
            });
            replaceLocationWithStateRoute();
            return;
          }

          const sameWorkspace =
            target.workspacePath === workspaceAbsPath &&
            (target.workspaceIdentity ?? undefined) ===
              (workspaceIdentity ?? undefined);
          if (sameWorkspace) {
            ensureWorkspaceTabActive();
            onNavigateToTask();
          } else {
            const tabId = ensureWorkspaceTab(
              target.workspacePath,
              target.workspaceIdentity
                ? { workspaceIdentity: target.workspaceIdentity }
                : undefined,
            );
            activateTab(tabId);
          }
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(
              target.workspacePath,
              route.taskId,
              target.workspaceIdentity,
            );
        })
        .catch((error) => {
          if (requestId !== routeRequestIdRef.current) return;
          setPendingTaskRoute(null);
          if (!webRouteEquals(stateRouteRef.current, base)) return;
          logger.error("[web-url-sync] 深链任务定位失败", {
            taskId: route.taskId,
            error,
          });
          replaceLocationWithStateRoute();
        });
    },
    [
      activateTab,
      activateTabByPath,
      activeTaskId,
      ensureWorkspaceTab,
      openFilesTab,
      openBotsTab,
      primaryView,
      setActiveBot,
      onNavigateToAutomations,
      onNavigateToPluginStore,
      onNavigateToTask,
      onNavigationPositionChange,
      openSettingsTab,
      replaceLocationWithStateRoute,
      resolveTaskWorkspace,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  const initializedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    return installWebBeforeUnloadGuard();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const pending = coldStartRouteRef.current;
    if (!pending) return;
    if (webRouteEquals(stateRoute, pending)) {
      coldStartRouteRef.current = undefined;
      return;
    }
    if (
      pending.kind === stateRoute.kind &&
      pending.kind !== "home" &&
      pending.kind !== "task"
    ) {
      if (
        pending.kind === "bots" &&
        pending.botId &&
        pending.botId !== activeBotId
      ) {
        setActiveBot(pending.botId);
      }
      if (pending.kind === "settings" || pending.kind === "plugin-store") {
        onNavigationPositionChange(pending);
      }
      coldStartRouteRef.current = undefined;
      return;
    }
    if (stateRoute.kind !== "home") {
      coldStartRouteRef.current = undefined;
      return;
    }
    applyRoute(pending);
  }, [
    activeBotId,
    applyRoute,
    enabled,
    onNavigationPositionChange,
    setActiveBot,
    stateRoute,
  ]);

  useEffect(() => {
    if (!enabled) return;
    const initialRoute = parseWebRoute(
      window.location.pathname,
      window.location.search,
    );
    const existingId = getHistoryEntryId(window.history.state);
    if (!initializedRef.current) {
      initializedRef.current = true;
      const id = existingId ?? ++historyEntrySequenceRef.current;
      historyEntrySequenceRef.current = Math.max(
        historyEntrySequenceRef.current,
        id,
      );
      currentHistoryEntryRef.current = id;
      if (existingId === undefined) {
        window.history.replaceState(
          { [HISTORY_ENTRY_KEY]: id },
          "",
          window.location.href,
        );
      }
      if (
        initialRoute &&
        initialRoute.kind !== "task" &&
        initialRoute.kind !== "home" &&
        !webRouteEquals(initialRoute, currentRouteRef.current)
      ) {
        coldStartRouteRef.current = initialRoute;
        applyRoute(initialRoute);
      }
      return;
    }

    if (restoringHistoryRef.current) return;
    const currentRoute = pendingTaskRoute?.route ?? stateRoute;
    if (applyingPopStateRef.current) {
      const target = applyingPopRouteRef.current;
      if (target && webRouteEquals(currentRoute, target)) {
        applyingPopStateRef.current = false;
        applyingPopRouteRef.current = null;
      } else {
        return;
      }
    }
    const { pathname, search } = buildWebRouteLocation(currentRoute);
    if (
      pathname === window.location.pathname &&
      search === window.location.search
    ) {
      if (replacePositionRef.current) {
        const id =
          currentHistoryEntryRef.current ?? ++historyEntrySequenceRef.current;
        currentHistoryEntryRef.current = id;
        window.history.replaceState(
          { [HISTORY_ENTRY_KEY]: id },
          "",
          `${pathname}${search}`,
        );
        replacePositionRef.current = false;
        replaceConsumedRef.current?.();
      }
      return;
    }
    const nextId = ++historyEntrySequenceRef.current;
    const currentId = currentHistoryEntryRef.current;
    if (currentId !== undefined) {
      knownPreviousEntryRef.current.set(nextId, currentId);
      knownNextEntryRef.current.set(currentId, nextId);
    }
    currentHistoryEntryRef.current = nextId;
    const method = replacePositionRef.current ? "replaceState" : "pushState";
    window.history[method](
      { [HISTORY_ENTRY_KEY]: nextId },
      "",
      `${pathname}${search}`,
    );
    if (replacePositionRef.current) {
      replacePositionRef.current = false;
      replaceConsumedRef.current?.();
    }
  }, [applyRoute, currentRouteRef, enabled, pendingTaskRoute, stateRoute]);

  useEffect(() => {
    if (!enabled) return;
    const handlePopState = (event: PopStateEvent) => {
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        currentHistoryEntryRef.current =
          getHistoryEntryId(event.state) ?? restoreTargetEntryIdRef.current;
        restoreTargetEntryIdRef.current = undefined;
        return;
      }
      const route = parseWebRoute(
        window.location.pathname,
        window.location.search,
      );
      if (!route) {
        const targetEntryId = getHistoryEntryId(event.state);
        const originEntryId = currentHistoryEntryRef.current;
        const delta = inferHistoryDelta(targetEntryId, originEntryId);
        if (delta !== undefined && originEntryId !== undefined) {
          restoringHistoryRef.current = true;
          restoreTargetEntryIdRef.current = originEntryId;
          window.history.go(delta);
        } else {
          replaceLocationWithStateRoute();
        }
        return;
      }
      const targetEntryId = getHistoryEntryId(event.state);
      const originEntryId = currentHistoryEntryRef.current;
      if (targetEntryId !== undefined) {
        historyEntrySequenceRef.current = Math.max(
          historyEntrySequenceRef.current,
          targetEntryId,
        );
      }
      if (webRouteEquals(route, currentRouteRef.current)) {
        if (
          originEntryId !== undefined &&
          targetEntryId !== undefined &&
          originEntryId !== targetEntryId
        ) {
          const [earlierEntryId, laterEntryId] =
            originEntryId < targetEntryId
              ? [originEntryId, targetEntryId]
              : [targetEntryId, originEntryId];
          knownPreviousEntryRef.current.set(laterEntryId, earlierEntryId);
          knownNextEntryRef.current.set(earlierEntryId, laterEntryId);
        }
        previousHistoryEntryRef.current = originEntryId;
        currentHistoryEntryRef.current = targetEntryId ?? originEntryId;
        return;
      }
      const requestId = ++routeRequestIdRef.current;
      invalidatePendingWebNavigation();
      void runWebNavigation(() => {
        if (requestId !== routeRequestIdRef.current) return;
        applyingPopStateRef.current = true;
        applyingPopRouteRef.current = route;
        previousHistoryEntryRef.current = originEntryId;
        currentHistoryEntryRef.current = targetEntryId;
        applyRoute(route);
      }).then((allowed) => {
        if (requestId !== routeRequestIdRef.current) return;
        if (allowed) return;
        const delta = inferHistoryDelta(targetEntryId, originEntryId);
        if (delta === undefined) {
          // 目标不相邻或 entry 未被本 hook 管理，不能把自有 ID 差值当成浏览器步数。
          // 用当前 owner 的真实位置恢复同一 entry，保证 UI 与地址一致且不造新记录。
          replaceLocationWithStateRoute();
          return;
        }
        restoringHistoryRef.current = true;
        restoreTargetEntryIdRef.current = originEntryId;
        window.history.go(delta);
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyRoute, enabled, inferHistoryDelta, replaceLocationWithStateRoute]);

  return enabled;
}
