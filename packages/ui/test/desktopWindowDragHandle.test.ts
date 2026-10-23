import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import { DesktopTopOverlay } from "../src/DesktopTopOverlay.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";

function renderOverlay(overrides: Partial<ComponentProps<typeof DesktopTopOverlay>> = {}): string {
  const platform = {} as IPlatformService;
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform },
        createElement(
          TooltipProvider,
          null,
          createElement(DesktopTopOverlay, {
            workspaceAbsPath: "/workspace",
            isDesktop: true,
            isMacDesktop: false,
            isWindowsDesktop: true,
            isSidebarVisible: false,
            updateReadyVersion: null,
            updateState: null,
            toggleSidebarShortcutLabel: "",
            newTaskShortcutLabel: "",
            appLogoUrl: "data:image/png;base64,",
            platform,
            onToggleSidebar: () => {},
            onCreateTask: () => {},
            ...overrides,
          }),
        ),
      ),
    ),
  );
}

test("Desktop仅显式启用时在左上按钮之后提供20px小块窗口拖动区", () => {
  for (const platform of [
    { isWindowsDesktop: true, isMacDesktop: false },
    { isWindowsDesktop: false, isMacDesktop: false },
    { isWindowsDesktop: false, isMacDesktop: true, isMacFullscreen: false },
    { isWindowsDesktop: false, isMacDesktop: true, isMacFullscreen: true },
  ]) {
    assert.doesNotMatch(renderOverlay(platform), /data-workspace-window-drag-handle/);
    const html = renderOverlay({ ...platform, showWindowDragHandle: true });
    const handles = html.match(/<div\b[^>]*data-workspace-window-drag-handle=""[^>]*>/g) ?? [];
    assert.equal(handles.length, 1);
    const handle = handles[0]!;
    assert.match(handle, /aria-hidden="true"/);
    assert.match(handle, /\bh-7\b/);
    assert.match(handle, /\bw-5\b/);
    assert.match(handle, /shrink-0/);
    assert.match(handle, /pointer-events-auto/);
    assert.match(handle, /\[app-region:drag\]/);
    assert.ok(html.lastIndexOf("<button") < html.indexOf(handle));
    assert.equal((html.match(/\[app-region:drag\]/g) ?? []).length, 1);
    assert.match(html, /<div data-workspace-caption-actions=""[^>]*\[app-region:no-drag\][^>]*>/);
  }
});

test("Web即使收到启用标志也不声明窗口拖动区", () => {
  for (const isMacDesktop of [true, false]) {
    const html = renderOverlay({
      isDesktop: false,
      isWindowsDesktop: false,
      isMacDesktop,
      showWindowDragHandle: true,
    });
    assert.doesNotMatch(html, /data-workspace-window-drag-handle|\[app-region:drag\]/);
  }
});

test("小块拖动区与按钮并列，外壳只在Desktop文件页侧栏收起时启用", async () => {
  const [overlay, shell] = await Promise.all([
    readFile(new URL("../src/DesktopTopOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(
    overlay,
    /<DesktopTopBarActions[\s\S]*?\/>\s*\{isDesktop && showWindowDragHandle \? \(/,
  );
  assert.match(
    shell,
    /showWindowDragHandle=\{\s*Boolean\(isDesktop\) &&\s*shellPrimaryView === "files" &&\s*!isSidebarPanelVisible\s*\}/,
  );
  assert.doesNotMatch(shell, /useWorkspaceFilesCaptionLeadingInset/);
});
