import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import { DesktopApplicationMenuButton } from "../src/app-shell/DesktopApplicationMenuButton.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

test("共享应用菜单按钮保持翻译、可访问标签与不可拖动命中区域", () => {
  const html = renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform: {} as IPlatformService },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(TooltipProvider, null, createElement(DesktopApplicationMenuButton)),
      ),
    ),
  );
  assert.match(html, /data-testid="desktop-top-nav-application-menu"/);
  assert.match(html, /aria-label="应用菜单"/);
  assert.match(html, /app-region:no-drag/);
});

test("无工作区文件外壳接收 macOS 标志并只在 Windows/Linux 提供共享入口", async () => {
  const [shell, root] = await Promise.all([
    readFile(new URL("../src/files-workbench/FilesEmptyShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/Root.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /isMacDesktop\?: boolean/);
  assert.match(shell, /isDesktop && !isMacDesktop[\s\S]*?<DesktopApplicationMenuButton/);
  assert.match(root, /<FilesEmptyShell[\s\S]*?isMacDesktop=\{isMacDesktop\}/);
});

test("无工作区文件外壳的菜单与窗口拖动区并列，Web不声明拖动区", async () => {
  const source = await readFile(
    new URL("../src/files-workbench/FilesEmptyShell.tsx", import.meta.url),
    "utf8",
  );
  const header = source.slice(source.indexOf("<aside"), source.indexOf("<FilesExplorerPane"));
  const rowClasses = header.match(/"([^"]*\bh-12\b[^"]*\[app-region:no-drag\][^"]*)"/)?.[1];
  assert.ok(rowClasses, "备用外壳应保留固定48px不可拖顶部行");
  assert.doesNotMatch(rowClasses, /\[app-region:drag\]/);
  assert.match(header, /<DesktopApplicationMenuButton \/> : null\}\s*<div\s+aria-hidden="true"/);
  const dragRegionClasses = header.match(
    /className=\{\s*isDesktop\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*\}/,
  );
  assert.ok(dragRegionClasses, "空白拖动区必须按宿主能力选择drag或no-drag");
  const desktopClasses = dragRegionClasses[1]!;
  const webClasses = dragRegionClasses[2]!;
  for (const classes of [desktopClasses, webClasses]) {
    assert.match(classes, /\bh-full\b/);
    assert.match(classes, /\bflex-1\b/);
  }
  assert.match(desktopClasses, /\[app-region:drag\]/);
  assert.match(webClasses, /\[app-region:no-drag\]/);
  assert.doesNotMatch(webClasses, /\[app-region:drag\]/);
});

test("无工作区文件区通过可伸展容器填满左栏之外的剩余宽高", async () => {
  const source = await readFile(
    new URL("../src/files-workbench/FilesEmptyShell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<div className="min-h-0 min-w-0 flex-1">\s*<FilesWorkbenchSurface[\s\S]*?isMacDesktop=\{Boolean\(isMacDesktop\)\}[\s\S]*?\/>(?:\s*)<\/div>/,
  );
  assert.match(source, /"flex h-full min-h-0 min-w-0"/);
});

test("仅窄屏Web隐藏空文件树并把既有导航移到底部，Desktop保持264px左栏", async () => {
  const source = await readFile(
    new URL("../src/files-workbench/FilesEmptyShell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /"flex h-full min-h-0 min-w-0",\s*!isDesktop && "max-md:flex-col"/);
  assert.match(
    source,
    /<aside\s+className=\{cn\(\s*"flex w-\[264px\] shrink-0 flex-col border-r border-border",\s*!isDesktop && "max-md:order-last max-md:w-full max-md:border-r-0"/,
  );
  assert.match(source, /"flex h-12[^\n]*\[app-region:no-drag\]",\s*!isDesktop && "max-md:hidden"/);
  assert.match(
    source,
    /<div className=\{cn\("min-h-0 flex-1", !isDesktop && "max-md:hidden"\)\}>\s*<FilesExplorerPane/,
  );
  assert.equal((source.match(/<WorkspaceShellPrimaryTabBar\b/g) ?? []).length, 1);
  assert.match(source, /<WorkspaceShellPrimaryTabBar[\s\S]*?tasksEnabled=\{false\}/);
  assert.ok(source.indexOf("<WorkspaceShellPrimaryTabBar") < source.indexOf("</aside>"));
  assert.doesNotMatch(source, /useState|<Drawer\b|<Sheet\b/);
});

test("独立设置页共享应用菜单入口，内嵌设置页不重复挂载", async () => {
  const source = await readFile(new URL("../src/SettingsPage.tsx", import.meta.url), "utf8");
  const standalone = source.indexOf("<DesktopWindowFrame");
  assert.ok(standalone > source.indexOf("if (isEmbedded) {"));
  assert.doesNotMatch(
    source.slice(source.indexOf("if (isEmbedded) {"), standalone),
    /<DesktopApplicationMenuButton/,
  );
  assert.match(
    source.slice(standalone),
    /isDesktop && !isMacDesktop[\s\S]*?left-12[\s\S]*?\[app-region:no-drag\][\s\S]*?<DesktopApplicationMenuButton/,
  );
});

test("共享按钮只通过平台合同执行既有 ShowApplicationMenu 命令", async () => {
  const source = await readFile(
    new URL("../src/app-shell/DesktopApplicationMenuButton.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /usePlatform\(\)/);
  assert.match(
    source,
    /onClick=\{\(\) => void platform\.executeDesktopCommand\(DesktopCommandIds\.ShowApplicationMenu\)\}/,
  );
});
