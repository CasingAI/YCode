import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// 资源管理器入口按宿主能力渲染（底栏「更多」杂项菜单与帮助菜单都走这条规则）。
// ui 包测试为源码断言式（无组件渲染/jsdom），这里锁定入口的可见性边界与命令接线。

const chromeMenuSource = readFileSync(
  new URL("../src/app-shell/WorkspaceShellChromeMenu.tsx", import.meta.url),
  "utf8",
);
const helpMenuSource = readFileSync(
  new URL("../src/WorkspaceHelpMenuButton.tsx", import.meta.url),
  "utf8",
);

const RESOURCE_MANAGER_TEST_ID = "data-testid={TID_WORKSPACE_SHELL_CHROME_RESOURCE_MANAGER}";

test("底栏入口按宿主能力渲染，不再按客户端类型判断", () => {
  assert.match(
    chromeMenuSource,
    /const canOpenResourceManager = typeof platform\.openResourceManager === "function";/,
    "入口可见性必须由平台能力决定",
  );
  assert.match(chromeMenuSource, /\{canOpenResourceManager \? \(/, "入口必须位于能力判定分支内");
  assert.ok(
    chromeMenuSource.includes(RESOURCE_MANAGER_TEST_ID),
    "资源管理器入口必须带稳定测试标识",
  );
});

test("帮助菜单入口同样按宿主能力渲染", () => {
  assert.match(
    helpMenuSource,
    /const canOpenResourceManager = typeof platform\.openResourceManager === "function";/,
    "入口可见性必须由平台能力决定",
  );
  assert.match(helpMenuSource, /\{canOpenResourceManager \? \(/, "入口必须位于能力判定分支内");
});

test("菜单统一调用平台能力，不再各自拼接桌面命令或 IPC 通道", () => {
  for (const source of [chromeMenuSource, helpMenuSource]) {
    assert.match(source, /platform\.openResourceManager\?\.\(\)/, "入口必须走平台能力");
    assert.doesNotMatch(
      source,
      /DesktopCommandIds\.OpenResourceManager/,
      "菜单不得直接拼接桌面命令",
    );
    assert.doesNotMatch(
      source,
      /PlatformChannels\.OpenResourceManager/,
      "菜单不得绕过平台能力直连 IPC 通道",
    );
  }
});

test("资源管理器文案在两种语言下都存在", () => {
  assert.equal(zhCN["sidebar.settings.resourceManager"], "资源管理器");
  assert.equal(enUS["sidebar.settings.resourceManager"], "Resource manager");
});
