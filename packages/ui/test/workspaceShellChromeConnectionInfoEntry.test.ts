import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/** 只校验菜单接线，不作为浏览器交互验证。 */

const chromeMenuSource = readFileSync(
  new URL("../src/app-shell/WorkspaceShellChromeMenu.tsx", import.meta.url),
  "utf8",
);
const sharedTestIdsSource = readFileSync(
  new URL("../../shared/src/test-ids.ts", import.meta.url),
  "utf8",
);

test("连接信息读取现有连接 context，不依赖远控管理服务", () => {
  assert.match(
    chromeMenuSource,
    /useServiceConnection\(\)/,
    "菜单必须通过既有 ServiceProvider 读取连接信息",
  );
  assert.doesNotMatch(
    chromeMenuSource,
    /mobileRemoteControlService/,
    "连接信息不能依赖远控管理服务",
  );
});

test("入口仅在 Web 且存在 connectionInfo 时渲染，并避免塞进远控分支", () => {
  assert.match(
    chromeMenuSource,
    /const showWebConnectionInfo = !isDesktop && connectionInfo !== undefined;/,
    "入口可见性必须由 isDesktop 与 connectionInfo 共同决定",
  );
  assert.match(chromeMenuSource, /\{showWebConnectionInfo \? \(/, "入口必须位于独立分支内");
  const remoteBranch = chromeMenuSource.match(/remote\.available \? \(([\s\S]*?)\)\s*:\s*null/);
  assert.ok(remoteBranch, "远控分支必须保持原样");
  assert.doesNotMatch(
    remoteBranch[1],
    /TID_WEB_CONNECTION_INFO_TRIGGER/,
    "连接信息不能塞进 remote.available 分支（Web 没有远控管理服务）",
  );
});

test("连接信息位于语言项之前，并带稳定测试标识", () => {
  const entryIndex = chromeMenuSource.indexOf("data-testid={TID_WEB_CONNECTION_INFO_TRIGGER}");
  const localeIndex = chromeMenuSource.indexOf("settings.locale");
  assert.ok(entryIndex >= 0, "菜单必须渲染连接信息入口");
  assert.ok(localeIndex >= 0, "菜单必须保留语言子菜单");
  assert.ok(entryIndex < localeIndex, "连接信息必须排在语言项之前");
  assert.match(sharedTestIdsSource, /TID_WEB_CONNECTION_INFO_TRIGGER/);
});

test("点击只打开本地 Dialog，不导航也不切换主视图", () => {
  assert.match(
    chromeMenuSource,
    /onSelect=\{\(\) => setWebConnectionInfoDialogOpen\(true\)\}/,
    "点击菜单项只能打开本地弹窗",
  );
  assert.match(
    chromeMenuSource,
    /<WebConnectionInfoDialog\s+open=\{webConnectionInfoDialogOpen\}\s+onOpenChange=\{setWebConnectionInfoDialogOpen\}/,
    "弹窗开合必须回到既有 onOpenChange",
  );
  assert.doesNotMatch(
    chromeMenuSource,
    /setWebConnectionInfoDialogOpen[\s\S]{0,120}(tabStore|navigate|setPrimaryView|setMenuOpen\(false\))/,
    "打开连接信息不得导航、改主视图或收起抽屉",
  );
});

test("中英文都提供入口与四类状态文案", () => {
  const ids = [
    "webConnectionInfo.title",
    "webConnectionInfo.status",
    "webConnectionInfo.transport",
    "webConnectionInfo.direct",
  ];
  for (const id of ids) {
    assert.ok(id in zhCN, `zh-CN 缺少文案：${id}`);
    assert.ok(id in enUS, `en-US 缺少文案：${id}`);
  }
  assert.equal(zhCN["webConnectionInfo.title"], "连接信息");
  assert.equal(enUS["webConnectionInfo.title"], "Connection info");
});
