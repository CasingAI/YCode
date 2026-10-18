import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebRouteLocation,
  parseWebRoute,
  webRouteEquals,
  type WebRoute,
} from "../src/lib/webRoute.js";

test("根路径解析为 home，尾部斜杠等价", () => {
  assert.deepEqual(parseWebRoute("/"), { kind: "home" });
  assert.deepEqual(parseWebRoute(""), { kind: "home" });
  assert.deepEqual(parseWebRoute("/task/sess_1/"), { kind: "task", taskId: "sess_1" });
});

test("会话深链只解析 taskId，不携带 workspace", () => {
  assert.deepEqual(parseWebRoute("/task/sess_abc-123"), { kind: "task", taskId: "sess_abc-123" });
  const route = parseWebRoute("/task/share-import-1");
  assert.equal(route?.kind, "task");
  assert.equal("workspacePath" in (route as object), false);
});

test("非法百分号编码返回 null 而不是抛错", () => {
  assert.equal(parseWebRoute("/task/%E0%A4%A"), null);
  assert.equal(parseWebRoute("/automations/%E0%A4%A"), null);
});

test("自动化主视图与详情视图", () => {
  assert.deepEqual(parseWebRoute("/automations"), { kind: "automations" });
  assert.deepEqual(parseWebRoute("/automations/auto-1"), {
    kind: "automations",
    automationId: "auto-1",
  });
});

test("自动化子标签只接受合法枚举", () => {
  assert.deepEqual(parseWebRoute("/automations", "?tab=idle"), {
    kind: "automations",
    automationTab: "idle",
  });
  assert.deepEqual(parseWebRoute("/automations/auto-1", "?tab=workflow"), {
    kind: "automations",
    automationId: "auto-1",
    automationTab: "workflow",
  });
  assert.equal(parseWebRoute("/automations", "?tab=bogus"), null);
});

test("插件商店、设置、文件是独立路径", () => {
  assert.deepEqual(parseWebRoute("/plugins"), { kind: "plugin-store" });
  assert.deepEqual(parseWebRoute("/plugins/example%40market"), {
    kind: "plugin-store",
    pluginId: "example@market",
  });
  assert.deepEqual(parseWebRoute("/settings"), { kind: "settings" });
  assert.deepEqual(parseWebRoute("/files"), { kind: "files" });
});

test("未托管路径返回 null，交给分享页/OAuth/API 等既有分支", () => {
  assert.equal(parseWebRoute("/share/cb-1"), null);
  assert.equal(parseWebRoute("/cn/share/cb-1"), null);
  // OAuth 回调的精确路径必须原样落回既有分支，不能被 /share 前缀误接管。
  assert.equal(parseWebRoute("/share/callback?code=abc"), null);
  assert.equal(parseWebRoute("/cn/share/callback?code=abc"), null);
  assert.equal(parseWebRoute("/api/server-info"), null);
  assert.equal(parseWebRoute("/ws"), null);
  assert.equal(parseWebRoute("/settings//"), null);
});

test("首屏凭据 query 不改变页面路由的解析结果", () => {
  assert.deepEqual(parseWebRoute("/task/sess_abc", "?token=secret"), {
    kind: "task",
    taskId: "sess_abc",
  });
  assert.deepEqual(parseWebRoute("/settings", "?token=secret&other=1"), { kind: "settings" });
  assert.deepEqual(parseWebRoute("/automations", "?tab=idle&token=secret"), {
    kind: "automations",
    automationTab: "idle",
  });
});

test("尾斜杠归一化后，缺少 id 的路径退化为首页而不是非法深链", () => {
  assert.deepEqual(parseWebRoute("/task/"), { kind: "home" });
  assert.deepEqual(parseWebRoute("/automations/"), { kind: "automations" });
});

test("设置子路由支持 legacy section 归一与 query 校验", () => {
  assert.deepEqual(parseWebRoute("/settings/plugins"), {
    kind: "settings",
    section: "plugin",
    pluginTab: "plugins",
  });
  assert.deepEqual(parseWebRoute("/settings/mcp"), {
    kind: "settings",
    section: "plugin",
    pluginTab: "mcps",
  });
  assert.deepEqual(parseWebRoute("/settings/skills"), {
    kind: "settings",
    section: "skill",
  });
  assert.deepEqual(parseWebRoute("/settings/usage", "?tab=codingPlan:source%3A1"), {
    kind: "settings",
    section: "usage",
    usageTab: "codingPlan:source:1",
  });
  assert.deepEqual(parseWebRoute("/settings/plugin", "?tab=external"), {
    kind: "settings",
    section: "plugin",
    pluginTab: "external",
  });
  assert.deepEqual(parseWebRoute("/settings/modelProvider", "?provider=id%2F1"), {
    kind: "settings",
    section: "modelProvider",
    providerId: "id/1",
  });
  assert.equal(parseWebRoute("/settings/plugin", "?tab=commands"), null);
  assert.equal(parseWebRoute("/settings/usage", "?provider=x"), null);
  assert.equal(parseWebRoute("/settings/modelProvider", "?tab=app"), null);
  assert.equal(parseWebRoute("/settings/computerUse"), {
    kind: "settings",
    section: "general",
  });
});

test("build 与 parse 往返一致", () => {
  const routes: WebRoute[] = [
    { kind: "home" },
    { kind: "task", taskId: "sess_abc" },
    { kind: "automations" },
    { kind: "automations", automationId: "auto 1" },
    { kind: "automations", automationTab: "scheduled" },
    { kind: "plugin-store" },
    { kind: "plugin-store", pluginId: "name@market" },
    { kind: "settings" },
    { kind: "settings", section: "plugin", pluginTab: "external" },
    { kind: "settings", section: "usage", usageTab: "codingPlan:source-1" },
    { kind: "settings", section: "modelProvider", providerId: "provider-1" },
    { kind: "files" },
  ];

  for (const route of routes) {
    const { pathname, search } = buildWebRouteLocation(route);
    assert.deepEqual(parseWebRoute(pathname, search), route, `${pathname}${search}`);
  }
});

test("需要转义的 ID 不会破坏路径分段", () => {
  const route: WebRoute = { kind: "task", taskId: "a/b?c#d" };
  const { pathname } = buildWebRouteLocation(route);
  assert.equal(pathname, "/task/a%2Fb%3Fc%23d");
  assert.deepEqual(parseWebRoute(pathname), route);

  const pluginRoute: WebRoute = { kind: "plugin-store", pluginId: "name/with space" };
  const pluginLocation = buildWebRouteLocation(pluginRoute);
  assert.equal(pluginLocation.pathname, "/plugins/name%2Fwith%20space");
  assert.deepEqual(parseWebRoute(pluginLocation.pathname), pluginRoute);
});

test("webRouteEquals 只认同 kind 且同目标", () => {
  assert.equal(
    webRouteEquals(
      { kind: "plugin-store", pluginId: "a" },
      { kind: "plugin-store", pluginId: "a" },
    ),
    true,
  );
  assert.equal(
    webRouteEquals(
      { kind: "settings", section: "plugin", pluginTab: "external" },
      { kind: "settings", section: "plugin", pluginTab: "plugins" },
    ),
    false,
  );
  assert.equal(webRouteEquals({ kind: "task", taskId: "a" }, { kind: "task", taskId: "a" }), true);
  assert.equal(webRouteEquals({ kind: "task", taskId: "a" }, { kind: "task", taskId: "b" }), false);
  assert.equal(webRouteEquals({ kind: "task", taskId: "a" }, { kind: "home" }), false);
  assert.equal(
    webRouteEquals(
      { kind: "automations", automationId: "x" },
      { kind: "automations", automationId: "x", automationTab: "idle" },
    ),
    false,
  );
  assert.equal(webRouteEquals({ kind: "home" }, { kind: "home" }), true);
});
