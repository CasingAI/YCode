import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// 底栏「更多」杂项菜单新增资源管理器入口（docs/specs/workspace-shell-chrome-more.md）。
// ui 包测试为源码断言式（无组件渲染/jsdom），这里锁定入口的可见性边界与命令接线。

const componentSource = readFileSync(
  new URL("../src/app-shell/WorkspaceShellChromeMenu.tsx", import.meta.url),
  "utf8",
);

const RESOURCE_MANAGER_TEST_ID = "data-testid={TID_WORKSPACE_SHELL_CHROME_RESOURCE_MANAGER}";

/** 找出 `{isDesktop ? (` 开始的 JSX 条件分支覆盖的源码区间。 */
function findConditionalBranch(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `源码必须包含 ${marker}`);

  const branchStart = source.lastIndexOf("{isDesktop ? (", markerIndex);
  assert.ok(branchStart >= 0, "资源管理器入口必须位于 isDesktop 条件分支内");

  let depth = 0;
  for (let index = branchStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(branchStart, index + 1);
      }
    }
  }
  throw new Error("isDesktop 条件分支没有闭合");
}

test("资源管理器入口只在桌面端渲染，并复用 OpenResourceManager 桌面命令", () => {
  const branch = findConditionalBranch(componentSource, RESOURCE_MANAGER_TEST_ID);

  assert.match(
    branch,
    /data-testid=\{TID_WORKSPACE_SHELL_CHROME_RESOURCE_MANAGER\}/,
    "资源管理器入口必须带稳定测试标识",
  );
  assert.match(
    componentSource,
    /executeDesktopCommand\(DesktopCommandIds\.OpenResourceManager\)/,
    "资源管理器入口必须复用既有桌面命令",
  );
  assert.doesNotMatch(
    componentSource,
    /PlatformChannels\.OpenResourceManager/,
    "菜单不得绕过桌面命令直连 IPC 通道",
  );
});

test("资源管理器文案在两种语言下都存在", () => {
  assert.equal(zhCN["sidebar.settings.resourceManager"], "资源管理器");
  assert.equal(enUS["sidebar.settings.resourceManager"], "Resource manager");
});
