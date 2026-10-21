import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 底栏「更多」菜单不再有「连接」入口（见 docs/specs/workspace-shell-chrome-more.md）。
 *
 * 首启已经没有登录墙，杂项菜单里留一个点开即接管整屏的欢迎页入口没有实际用处；
 * 账号连接能力本身不删，改为走命令面板的「连接 / 登录」命令。
 *
 * ui 包测试为源码断言式（无 DOM 测试环境，菜单项在 Radix portal 里默认不渲染），
 * 这里锁定入口的删除方向与账号能力的保留位置。
 */

const chromeMenuSource = readFileSync(
  new URL("../src/app-shell/WorkspaceShellChromeMenu.tsx", import.meta.url),
  "utf8",
);
const quickPickCommandsSource = readFileSync(
  new URL("../src/quickpick/quickPickCommands.ts", import.meta.url),
  "utf8",
);
const rootSource = readFileSync(new URL("../src/Root.tsx", import.meta.url), "utf8");
const sharedTestIdsSource = readFileSync(
  new URL("../../shared/src/test-ids.ts", import.meta.url),
  "utf8",
);

test("「更多」菜单不再渲染「连接」入口", () => {
  assert.doesNotMatch(chromeMenuSource, /app\.login/, "菜单不得再引用连接入口文案");
  assert.doesNotMatch(
    chromeMenuSource,
    /TID_LOGIN_MENU_ITEM/,
    "菜单不得再保留连接入口的测试标识",
  );
  assert.doesNotMatch(chromeMenuSource, /LogInIcon/, "菜单不得再渲染登录图标");
});

test("菜单组件不再接收只为连接入口存在的属性", () => {
  assert.doesNotMatch(chromeMenuSource, /onLogin\??:/, "菜单不得再声明 onLogin 属性");
  assert.doesNotMatch(chromeMenuSource, /user\??: UserInfo/, "菜单不得再声明 user 属性");
});

test("连接入口的中英文文案与测试标识一并清理", () => {
  assert.equal("app.login" in zhCN, false);
  assert.equal("app.login" in enUS, false);
  assert.equal("sidebar.profile.notLoggedIn" in zhCN, false);
  assert.equal("sidebar.profile.notLoggedIn" in enUS, false);
  assert.doesNotMatch(sharedTestIdsSource, /TID_LOGIN_MENU_ITEM/);
});

test("账号连接能力仍由命令面板承担", () => {
  assert.match(
    quickPickCommandsSource,
    /id: "login"/,
    "命令面板必须保留「连接 / 登录」命令",
  );
  assert.match(
    rootSource,
    /setWelcomeScreenOpenReason\("manual-login"\)/,
    "手动连接账号的欢迎页来源必须保留",
  );
});
