import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkspaceSidebarMoreMenu } from "../src/WorkspaceSidebar/WorkspaceSidebarMoreMenu.js";

/**
 * 自动化与插件市场收进「更多」下拉后的选中态回归。
 *
 * 覆盖范围只到静态可渲染的部分：触发器本身。菜单项在 Radix portal 里且默认关闭，
 * 服务端静态渲染不会输出，因此菜单项的 checked 与 onSelect 只能靠 spec
 * `docs/specs/sidebar-more-menu.md` 的手动验收场景覆盖——本仓库没有 DOM 测试环境。
 */
function renderMoreMenu({
  automationsActive = false,
  pluginStoreActive = false,
}: {
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceSidebarMoreMenu, {
        automationsActive,
        pluginStoreActive,
        onOpenAutomations: () => undefined,
        onOpenPluginStore: () => undefined,
      }),
    ),
  );
}

test("侧边栏「更多」触发器渲染为菜单触发器", () => {
  const markup = renderMoreMenu();

  assert.equal(markup.match(/data-testid="sidebar-more-menu"/g)?.length, 1);
  // 触发器必须真的声明自己是菜单入口，折叠后自动化与插件市场全靠它可达。
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /更多/);
});

test("两个功能都不活跃时「更多」不带选中态", () => {
  const markup = renderMoreMenu({ automationsActive: false, pluginStoreActive: false });

  assert.doesNotMatch(markup, /bg-selected/);
});

test("自动化活跃时「更多」带选中态", () => {
  const markup = renderMoreMenu({ automationsActive: true, pluginStoreActive: false });

  assert.match(markup, /bg-selected/);
});

test("插件市场活跃时「更多」带选中态", () => {
  const markup = renderMoreMenu({ automationsActive: false, pluginStoreActive: true });

  assert.match(markup, /bg-selected/);
});

test("折叠后两个入口不再占据一级导航行", () => {
  const markup = renderMoreMenu({ automationsActive: true, pluginStoreActive: true });

  // 菜单未展开时它们不在 DOM 里；这条锁住「不再是一级平铺按钮」这个回归方向。
  assert.doesNotMatch(markup, /data-testid="automations-open"/);
  assert.doesNotMatch(markup, /data-testid="plugin-store-sidebar-open"/);
});
