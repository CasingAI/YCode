import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService, Locale } from "@zcode/shared";
import { DesktopTopBarActions } from "../src/app-shell/DesktopTopBarActions.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";

function renderActions(
  overrides: Partial<ComponentProps<typeof DesktopTopBarActions>>,
  locale: Locale = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        PlatformProvider,
        { platform: {} as IPlatformService },
        createElement(
          TooltipProvider,
          null,
          createElement(DesktopTopBarActions, {
            usesLogoToggle: false,
            isSidebarVisible: false,
            toggleSidebarTitle: "侧栏",
            toggleSidebarShortcutLabel: "",
            toggleButtonTestId: "sidebar-toggle",
            newTaskTitle: "新建任务",
            newTaskShortcutLabel: "",
            newTaskButtonTestId: "new-task",
            platform: {} as IPlatformService,
            updateReadyVersion: null,
            updateState: null,
            isMacDesktop: false,
            isWindowsDesktop: false,
            onToggleSidebar: () => {},
            onCreateTask: () => {},
            ...overrides,
          }),
        ),
      ),
    ),
  );
}

test("Windows/Linux 自绘标题栏始终在侧栏按钮之后提供独立应用菜单按钮", () => {
  for (const isWindowsDesktop of [true, false]) {
    for (const isSidebarVisible of [true, false]) {
      const html = renderActions({ usesLogoToggle: true, isWindowsDesktop, isSidebarVisible });
      assert.match(html, /data-testid="desktop-top-nav-application-menu"/);
      assert.match(html, /aria-label="应用菜单"/);
      assert.ok(
        html.indexOf('data-testid="sidebar-toggle"') <
          html.indexOf('data-testid="desktop-top-nav-application-menu"'),
      );
      assert.match(html, /app-region:no-drag/);
    }
  }
});

test("macOS 与 Web 不显示宿主应用菜单按钮", () => {
  for (const isMacDesktop of [true, false]) {
    const html = renderActions({ usesLogoToggle: false, isMacDesktop });
    assert.doesNotMatch(html, /desktop-top-nav-application-menu/);
  }
});

test("应用菜单按钮复用应用菜单的中英文翻译", () => {
  const html = renderActions({ usesLogoToggle: true, isWindowsDesktop: true }, "en-US");
  assert.match(html, /aria-label="Application menu"/);
});
