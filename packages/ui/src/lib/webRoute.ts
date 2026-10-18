import type { AutomationsNavigationTab } from "./taskNavigationHistory.js";
import {
  resolveSettingsSection,
  type SettingsSectionId,
} from "./settingsNavigation.js";

/**
 * Web 端的页面即路径：一个 WebRoute 唯一决定地址栏内容。
 *
 * workspace 刻意不进入 URL。task 的归属 workspace 是它的固有属性（用户也不能改），
 * 冷启动时由 taskId 反查；其余视图跟随「当前 workspace」。因此这里没有 workspace 槽位。
 */
export type SettingsUsageTab = "app" | "codingPlan" | `codingPlan:${string}`;
export type SettingsPluginTab = "plugins" | "mcps" | "skills" | "external";

export type WebRoute =
  | { kind: "home" }
  | { kind: "task"; taskId: string }
  | { kind: "automations"; automationId?: string; automationTab?: AutomationsNavigationTab }
  | { kind: "plugin-store"; pluginId?: string }
  | {
      kind: "settings";
      section?: SettingsSectionId;
      usageTab?: SettingsUsageTab;
      pluginTab?: SettingsPluginTab;
      providerId?: string;
    }
  | { kind: "files" };

const AUTOMATION_TABS: readonly AutomationsNavigationTab[] = ["scheduled", "delay", "idle", "workflow"];

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
    return parseSettings(undefined, params);
  }

  if (path.startsWith("/settings/")) {
    const sectionSegment = path.slice("/settings/".length);
    if (!sectionSegment || sectionSegment.includes("/")) return null;
    const decodedSection = safeDecode(sectionSegment);
    if (!decodedSection) return null;
    if (decodedSection === "plugins" || decodedSection === "mcp") {
      return parseSettings(
        "plugin",
        params,
        decodedSection === "mcp" ? "mcps" : "plugins",
      );
    }
    if (decodedSection === "skills") {
      return parseSettings("skill", params);
    }
    if (!isSettingsSection(decodedSection)) return null;
    const section = resolveSettingsSection(decodedSection, "general");
    return parseSettings(section, params);
  }

  if (path === "/files") {
    return { kind: "files" };
  }

  if (path === "/plugins") {
    return { kind: "plugin-store" };
  }

  if (path.startsWith("/plugins/")) {
    const pluginId = safeDecode(path.slice("/plugins/".length));
    return pluginId ? { kind: "plugin-store", pluginId } : null;
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

const SETTINGS_SECTIONS: readonly string[] = [
  "general",
  "appearance",
  "sounds",
  "migration",
  "network",
  "browser",
  "modelProvider",
  "modelGroups",
  "memory",
  "plugin",
  "mcp",
  "skill",
  "plugins",
  "usage",
  "storage",
  "subagents",
  "commands",
  "hooks",
  "workspaceFileSearch",
  "computerUse",
  "automations",
  "experimental",
  "shortcuts",
];
const USAGE_TABS = new Set(["app", "codingPlan"]);
const SETTINGS_PLUGIN_TABS: readonly SettingsPluginTab[] = ["plugins", "mcps", "skills", "external"];

function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.includes(value);
}

function parseSettings(
  section: SettingsSectionId | undefined,
  params: URLSearchParams,
  legacyPluginTab?: SettingsPluginTab,
): WebRoute | null {
  const rawTab = params.get("tab");
  const rawProvider = params.get("provider");
  if (section === "usage") {
    if (rawProvider !== null) return null;
    if (rawTab !== null && !USAGE_TABS.has(rawTab) && !/^codingPlan:.+$/.test(rawTab)) return null;
    return {
      kind: "settings",
      ...(section ? { section } : {}),
      ...(rawTab ? { usageTab: rawTab as SettingsUsageTab } : {}),
    };
  }
  if (section === "plugin") {
    if (rawProvider !== null) return null;
    if (rawTab !== null && !SETTINGS_PLUGIN_TABS.includes(rawTab as SettingsPluginTab)) return null;
    return {
      kind: "settings",
      section,
      ...((rawTab as SettingsPluginTab | null) ?? legacyPluginTab
        ? { pluginTab: (rawTab as SettingsPluginTab | null) ?? legacyPluginTab }
        : {}),
    };
  }
  if (section === "modelProvider") {
    if (rawTab !== null) return null;
    return {
      kind: "settings",
      section,
      ...(rawProvider ? { providerId: rawProvider } : {}),
    };
  }
  if (rawTab !== null || rawProvider !== null) return null;
  return { kind: "settings", ...(section ? { section } : {}) };
}

/** 路由序列化成可写入地址栏的 pathname + search。 */
export function buildWebRouteLocation(route: WebRoute): { pathname: string; search: string } {
  switch (route.kind) {
    case "home":
      return { pathname: "/", search: "" };
    case "task":
      return { pathname: `/task/${encodeURIComponent(route.taskId)}`, search: "" };
    case "plugin-store":
      return {
        pathname: route.pluginId ? `/plugins/${encodeURIComponent(route.pluginId)}` : "/plugins",
        search: "",
      };
    case "settings": {
      const section = route.section;
      const pathname = section ? `/settings/${encodeURIComponent(section)}` : "/settings";
      const params = new URLSearchParams();
      if (section === "usage" && route.usageTab) params.set("tab", route.usageTab);
      if (section === "plugin" && route.pluginTab) params.set("tab", route.pluginTab);
      if (section === "modelProvider" && route.providerId) {
        params.set("provider", route.providerId);
      }
      const search = params.size ? `?${params.toString()}` : "";
      return { pathname, search };
    }
    case "files":
      return { pathname: "/files", search: "" };
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

  if (left.kind === "home" || left.kind === "files") {
    return true;
  }

  if (left.kind === "plugin-store" && right.kind === "plugin-store") {
    return left.pluginId === right.pluginId;
  }

  if (left.kind === "settings" && right.kind === "settings") {
    return (
      left.section === right.section &&
      left.usageTab === right.usageTab &&
      left.pluginTab === right.pluginTab &&
      left.providerId === right.providerId
    );
  }

  if (left.kind === "task" && right.kind === "task") {
    return left.taskId === right.taskId;
  }

  if (left.kind === "automations" && right.kind === "automations") {
    return left.automationId === right.automationId && left.automationTab === right.automationTab;
  }

  return false;
}
