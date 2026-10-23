import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FilesWorkbenchWindowControls } from "../src/files-workbench/FilesWorkbenchWindowControls.js";

function renderControls(options = { isDesktop: true, isMacDesktop: false, isActiveView: true }) {
  return renderToStaticMarkup(
    createElement(
      PlatformProvider,
      { platform: {} as IPlatformService },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(FilesWorkbenchWindowControls, options),
      ),
    ),
  );
}

test("活跃Windows/Linux文件页复用最小化、最大化和关闭三个窗控", () => {
  const markup = renderControls();
  for (const id of ["minimize", "maximize", "close"]) {
    assert.match(markup, new RegExp(`data-testid="window-control-${id}"`));
  }
  assert.equal(markup.match(/<button/g)?.length, 3);
});

test("窗控绝对定位不增加flow标题行，只有实际按钮区域可命中", () => {
  const markup = renderControls();
  const rootTag = markup.slice(0, markup.indexOf(">") + 1);
  for (const className of ["absolute", "top-0", "right-0", "z-20", "h-12", "pointer-events-none"]) {
    assert.match(rootTag, new RegExp(className));
  }
  assert.match(
    markup,
    /<div data-files-workbench-window-controls=""[^>]*pointer-events-auto[^>]*app-region:no-drag[^>]*>/,
  );
  const hitTargetTag = markup.match(/<div data-files-workbench-window-controls=""[^>]*>/)?.[0];
  assert.doesNotMatch(hitTargetTag ?? "", /h-12/);
  assert.doesNotMatch(markup, /data-files-workbench-titlebar|\[app-region:drag\]/);
});

test("Mac、Web、隐藏保活均不挂载自绘窗控", () => {
  for (const isDesktop of [true, false]) {
    for (const isMacDesktop of [true, false]) {
      for (const isActiveView of [true, false]) {
        if (isDesktop && !isMacDesktop && isActiveView) continue;
        // 无需Platform/intl：不满足平台及活跃条件时，实际窗控子树必须完全不挂载。
        assert.equal(
          renderToStaticMarkup(
            createElement(FilesWorkbenchWindowControls, {
              isDesktop,
              isMacDesktop,
              isActiveView,
            }),
          ),
          "",
        );
      }
    }
  }
});
