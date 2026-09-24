import type { AutomationsNavigationTab } from "./taskNavigationHistory.js";

/**
 * Web 端的页面即路径：一个 WebRoute 唯一决定地址栏内容。
 *
 * workspace 刻意不进入 URL。task 的归属 workspace 是它的固有属性（用户也不能改），
 * 冷启动时由 taskId 反查；其余视图跟随「当前 workspace」。因此这里没有 workspace 槽位。
 */
export type WebRoute =
  | { kind: "home" }
  | { kind: "task"; taskId: string }
  | { kind: "automations"; automationId?: string; automationTab?: AutomationsNavigationTab }
  | { kind: "plugin-store" }
  | { kind: "settings" };

const AUTOMATION_TABS: readonly AutomationsNavigationTab[] = ["scheduled", "idle", "workflow"];

function isAutomationsNavigationTab(value: string | null): value is AutomationsNavigationTab {
  return value !== null && (AUTOMATION_TABS as readonly string[]).includes(value);
}

/** 非法百分号编码会抛 URIError，路由解析不能因此把整个应用打崩。 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * 解析 pathname/search 成路由。返回 null 表示「这条路径不由本模块处理」，
 * 调用方需要继续走自己的分支（分享页、OAuth 回调、API、WS 等）。
 */
export function parseWebRoute(pathname: string, search?: string): WebRoute | null {
  const path = stripTrailingSlash(pathname);
  const params = new URLSearchParams(search ?? "");

  if (path === "" || path === "/") {
    return { kind: "home" };
  }

  if (path === "/settings") {
    return { kind: "settings" };
  }

  if (path === "/plugins") {
    return { kind: "plugin-store" };
  }

  if (path === "/task") {
    return { kind: "home" };
  }

  if (path.startsWith("/task/")) {
    const taskId = safeDecode(path.slice("/task/".length));
    return taskId ? { kind: "task", taskId } : null;
  }

  if (path === "/automations") {
    return parseAutomations(null, params);
  }

  if (path.startsWith("/automations/")) {
    const automationId = safeDecode(path.slice("/automations/".length));
    if (!automationId) {
      return null;
    }
    return parseAutomations(automationId, params);
  }

  return null;
}

function parseAutomations(automationId: string | null, params: URLSearchParams): WebRoute | null {
  const rawTab = params.get("tab");
  if (rawTab !== null && !isAutomationsNavigationTab(rawTab)) {
    return null;
  }

  return {
    kind: "automations",
    ...(automationId ? { automationId } : {}),
    ...(rawTab ? { automationTab: rawTab } : {}),
  };
}

/** 路由序列化成可写入地址栏的 pathname + search。 */
export function buildWebRouteLocation(route: WebRoute): { pathname: string; search: string } {
  switch (route.kind) {
    case "home":
      return { pathname: "/", search: "" };
    case "task":
      return { pathname: `/task/${encodeURIComponent(route.taskId)}`, search: "" };
    case "plugin-store":
      return { pathname: "/plugins", search: "" };
    case "settings":
      return { pathname: "/settings", search: "" };
    case "automations": {
      const pathname = route.automationId
        ? `/automations/${encodeURIComponent(route.automationId)}`
        : "/automations";
      const search = route.automationTab ? `?tab=${encodeURIComponent(route.automationTab)}` : "";
      return { pathname, search };
    }
  }
}

export function webRouteEquals(left: WebRoute, right: WebRoute): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "home" || left.kind === "plugin-store" || left.kind === "settings") {
    return true;
  }

  if (left.kind === "task" && right.kind === "task") {
    return left.taskId === right.taskId;
  }

  if (left.kind === "automations" && right.kind === "automations") {
    return left.automationId === right.automationId && left.automationTab === right.automationTab;
  }

  return false;
}
