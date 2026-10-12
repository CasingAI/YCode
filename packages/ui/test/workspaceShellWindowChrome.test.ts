import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellSplitPanelFrameClassName,
  resolveWorkspaceShellWindowChromeClass,
} from "../src/app-shell/workspaceShellWindowChrome.js";

const desktopChromeBase = {
  isWindowsMaximized: false,
  supportsNativeRoundedCorners: null as boolean | null,
};

// 网页铺满视口，不能套桌面内嵌卡片的四周圆角；否则外壳底色从四角漏出，
// 收起态顶栏还会因 1px 描边比展开态浮层多缩一截，开关键整组往右跳。
test("网页工作区面板圆角为 0", () => {
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isDesktop: false,
      isMacDesktop: false,
      isWindowsDesktop: false,
    }),
    0,
  );
});

test("网页缺省 isDesktop 必须先收成布尔，否则会误画 12px 圆角", () => {
  // 远控页「看起来完全没改」的根因：Root 不传 isDesktop 时值是 undefined。
  assert.equal(resolveWorkspaceShellPanelRadiusPx({ isDesktop: undefined }), 12);
  assert.equal(resolveWorkspaceShellPanelRadiusPx({ isDesktop: Boolean(undefined) }), 0);
  assert.equal(
    resolveWorkspaceShellSplitPanelFrameClassName({
      ...desktopChromeBase,
      isDesktop: Boolean(undefined),
      isPairedWithSiblingPanel: true,
    }),
    "",
  );
});

test("网页工作区不画卡片圆角和描边", () => {
  assert.equal(
    resolveWorkspaceShellWindowChromeClass({
      ...desktopChromeBase,
      isDesktop: false,
      isMacDesktop: false,
      isWindowsDesktop: false,
      isLinuxDesktop: false,
    }),
    "",
  );
  assert.equal(
    resolveWorkspaceShellSplitPanelFrameClassName({
      ...desktopChromeBase,
      isDesktop: false,
      isPairedWithSiblingPanel: true,
    }),
    "",
  );
});

test("未标明网页时仍走桌面默认圆角，避免 onboarding 视觉板被带成直角", () => {
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isMacDesktop: false,
      isWindowsDesktop: false,
    }),
    12,
  );
});

test("桌面平台圆角保持原规则", () => {
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isDesktop: true,
      isWindowsDesktop: true,
    }),
    5,
  );
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isDesktop: true,
      isMacDesktop: true,
      macOSMajorVersion: 15,
    }),
    6,
  );
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isDesktop: true,
      isMacDesktop: true,
      macOSMajorVersion: 26,
    }),
    12,
  );
  assert.equal(
    resolveWorkspaceShellPanelRadiusPx({
      isDesktop: true,
      isLinuxDesktop: true,
    }),
    12,
  );
});

test("桌面分栏成对时仍画卡片外框", () => {
  assert.equal(
    resolveWorkspaceShellSplitPanelFrameClassName({
      ...desktopChromeBase,
      isDesktop: true,
      isMacDesktop: true,
      isPairedWithSiblingPanel: true,
    }),
    "rounded-[var(--workspace-panel-radius)] border border-border",
  );
  assert.equal(
    resolveWorkspaceShellWindowChromeClass({
      ...desktopChromeBase,
      isDesktop: true,
      isLinuxDesktop: true,
    }),
    "rounded-xl border border-border",
  );
});
