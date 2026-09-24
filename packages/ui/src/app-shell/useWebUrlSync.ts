import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";
import { isWebUrlSyncEnabled } from "@/lib/webUrlSyncControl.js";
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
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  onNavigateToTask: () => void;
  onNavigateToAutomations: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore: () => void;
  resolveTaskWorkspace: (
    taskId: string,
  ) => Promise<{ workspacePath: string; workspaceIdentity?: string } | null>;
}

/**
 * task 深链要先反查 workspace 才能落地，反查期间应用状态还没跟上地址栏。
 * pendingRoute 把这段窗口投影成目标路由，避免中途把旧会话 push 进 history；
 * base 是发起解析时的应用路由，一旦它变化就说明用户已经导航到别处，
 * 投影立刻交回应用状态，地址栏不再被 pending 挡住。
 */
interface PendingTaskRoute {
  route: WebRoute;
  base: WebRoute;
}

export function useWebUrlSync(params: WebUrlSyncParams): boolean {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    workspaceMainView,
    openAutomationId,
    openAutomationTab,
    onNavigateToTask,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    resolveTaskWorkspace,
  } = params;

  const enabled = isWebUrlSyncEnabled();
  const isSettingsTabActive = useTabStore((state) => {
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return tab ? isSettingsTab(tab) : false;
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const ensureWorkspaceTab = useTabStore((state) => state.ensureWorkspaceTab);
  const activateTab = useTabStore((state) => state.activateTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);

  const [pendingTaskRoute, setPendingTaskRoute] = useState<PendingTaskRoute | null>(null);
  // 每次 applyRoute 自增：反查是异步的，回来时只有最后一次导航有权写应用状态。
  const routeRequestIdRef = useRef(0);

  const stateRoute = useMemo<WebRoute>(() => {
    if (isSettingsTabActive) {
      return { kind: "settings" };
    }
    if (workspaceMainView === "automations") {
      return {
        kind: "automations",
        ...(openAutomationId ? { automationId: openAutomationId } : {}),
        ...(openAutomationTab ? { automationTab: openAutomationTab } : {}),
      };
    }
    if (workspaceMainView === "plugin-store") {
      return { kind: "plugin-store" };
    }
    return activeTaskId ? { kind: "task", taskId: activeTaskId } : { kind: "home" };
  }, [isSettingsTabActive, workspaceMainView, openAutomationId, openAutomationTab, activeTaskId]);

  const currentRoute =
    pendingTaskRoute && webRouteEquals(stateRoute, pendingTaskRoute.base)
      ? pendingTaskRoute.route
      : stateRoute;

  const currentRouteRef = useRef(currentRoute);
  currentRouteRef.current = currentRoute;
  const stateRouteRef = useRef(stateRoute);
  stateRouteRef.current = stateRoute;

  /** 深链打不开时把地址栏纠正回真实视图，且不新增 history 条目。 */
  const replaceLocationWithStateRoute = useCallback(() => {
    const { pathname, search } = buildWebRouteLocation(stateRouteRef.current);
    window.history.replaceState(null, "", `${pathname}${search}`);
  }, []);

  const applyRoute = useCallback(
    (route: WebRoute) => {
      const requestId = ++routeRequestIdRef.current;

      if (route.kind === "settings") {
        setPendingTaskRoute(null);
        openSettingsTab();
        return;
      }

      // settings 是独立 tab，其余页面都属于 workspace：先把活动 tab 收回 workspace。
      const ensureWorkspaceTabActive = () => {
        if (!isSettingsTabActive) {
          return;
        }
        activateTabByPath(workspaceAbsPath, workspaceIdentity ? { workspaceIdentity } : undefined);
      };

      if (route.kind === "home") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToTask();
        useZCodeSessionStore.getState().startDraft(workspaceAbsPath, undefined, workspaceIdentity);
        return;
      }

      if (route.kind === "plugin-store") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToPluginStore();
        return;
      }

      if (route.kind === "automations") {
        setPendingTaskRoute(null);
        ensureWorkspaceTabActive();
        onNavigateToAutomations({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(route.automationId ? { automationId: route.automationId } : {}),
          ...(route.automationTab ? { automationTab: route.automationTab } : {}),
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
          if (requestId !== routeRequestIdRef.current) {
            return;
          }
          setPendingTaskRoute(null);
          if (!webRouteEquals(stateRouteRef.current, base)) {
            return;
          }
          if (!target) {
            logger.warn("[web-url-sync] 深链任务无法解析为 workspace", { taskId: route.taskId });
            replaceLocationWithStateRoute();
            return;
          }

          const sameWorkspace =
            target.workspacePath === workspaceAbsPath &&
            (target.workspaceIdentity ?? undefined) === (workspaceIdentity ?? undefined);
          if (sameWorkspace) {
            ensureWorkspaceTabActive();
            onNavigateToTask();
          } else {
            // 深链可以指向任何 workspace，不能只在已打开的 tab 里找：目标没开过
            // 就新建并激活，否则 URL 停在一个打不开的会话上。
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
            .setActiveTaskId(target.workspacePath, route.taskId, target.workspaceIdentity);
        })
        .catch((error) => {
          if (requestId !== routeRequestIdRef.current) {
            return;
          }
          setPendingTaskRoute(null);
          if (!webRouteEquals(stateRouteRef.current, base)) {
            return;
          }
          logger.error("[web-url-sync] 深链任务定位失败", { taskId: route.taskId, error });
          replaceLocationWithStateRoute();
        });
    },
    [
      activateTab,
      activateTabByPath,
      activeTaskId,
      ensureWorkspaceTab,
      isSettingsTabActive,
      onNavigateToAutomations,
      onNavigateToPluginStore,
      onNavigateToTask,
      openSettingsTab,
      replaceLocationWithStateRoute,
      resolveTaskWorkspace,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  const initializedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      // 冷启动时地址栏是可信输入。task 目标由 Root 的 initialTaskId 负责落地
      // （它在本 effect 之前就已拿到解析结果），这里不重复应用；home 本身就是
      // 初始状态。剩下的视图是 App 局部状态，只能在这里按 URL 初始化。
      const initialRoute = parseWebRoute(window.location.pathname, window.location.search);
      if (
        initialRoute &&
        initialRoute.kind !== "task" &&
        initialRoute.kind !== "home" &&
        !webRouteEquals(initialRoute, currentRouteRef.current)
      ) {
        applyRoute(initialRoute);
      }
      return;
    }

    const { pathname, search } = buildWebRouteLocation(currentRoute);
    if (pathname === window.location.pathname && search === window.location.search) {
      return;
    }

    window.history.pushState(null, "", `${pathname}${search}`);
  }, [applyRoute, currentRoute, enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handlePopState = () => {
      const route = parseWebRoute(window.location.pathname, window.location.search);
      // 分享页、OAuth 回调等不是本模块的页面，交给各自的整页加载路径处理。
      if (!route || webRouteEquals(route, currentRouteRef.current)) {
        return;
      }
      applyRoute(route);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [applyRoute, enabled]);

  return enabled;
}
