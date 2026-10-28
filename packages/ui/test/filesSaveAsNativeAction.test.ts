import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@zcode/shared";
import { FilesSaveAsNativeAction } from "../src/files-workbench/FilesSaveAsDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderAction(params: {
  available: boolean;
  pending: boolean;
  failed: boolean;
  locale?: Locale;
}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: params.locale ?? "zh-CN" },
      createElement(FilesSaveAsNativeAction, {
        available: params.available,
        pending: params.pending,
        failed: params.failed,
        onOpen: () => {},
      }),
    ),
  );
}

test("本机 Desktop 目标显示系统对话框按钮并使用当前语言", () => {
  const zh = renderAction({ available: true, pending: false, failed: false });
  assert.match(zh, /使用系统对话框/);
  assert.doesNotMatch(zh, /role="alert"/);

  const en = renderAction({
    available: true,
    pending: false,
    failed: false,
    locale: "en-US",
  });
  assert.match(en, /Use system dialog/);
  assert.doesNotMatch(en, /role="alert"/);
});

test("Web、旧 preload 或远程目标不显示按钮", () => {
  const markup = renderAction({ available: false, pending: false, failed: false });
  assert.equal(markup, "");
});

test("请求中禁用按钮，失败时显示本地化提示", () => {
  const pending = renderAction({ available: true, pending: true, failed: false });
  assert.match(pending, /<button[^>]*disabled=""/);

  const failedZh = renderAction({ available: true, pending: false, failed: true });
  assert.match(failedZh, /role="alert"/);
  assert.match(failedZh, /无法打开系统对话框，请重试。/);

  const failedEn = renderAction({
    available: true,
    pending: false,
    failed: true,
    locale: "en-US",
  });
  assert.match(failedEn, /Could not open the system dialog\. Try again\./);
});
