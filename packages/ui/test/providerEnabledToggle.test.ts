import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ProviderEnabledToggle } from "../src/settings/model-provider-section/ProviderEnabledToggle.js";

function renderToggle({ enabled, saving = false }: { enabled: boolean; saving?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ProviderEnabledToggle, {
        enabled,
        saving,
        onCheckedChange: () => undefined,
      }),
    ),
  );
}

test("Provider enabled 开关只渲染一个控件并反映启用状态", () => {
  const markup = renderToggle({ enabled: true });

  assert.equal(markup.match(/data-testid="model-provider-enabled-switch"/g)?.length, 1);
  assert.match(markup, /aria-label="禁用供应商"/);
});

test("Provider enabled 开关在保存期间保持可见但不可操作", () => {
  const markup = renderToggle({ enabled: false, saving: true });

  assert.equal(markup.match(/data-testid="model-provider-enabled-switch"/g)?.length, 1);
  assert.match(markup, /aria-label="启用供应商"/);
  assert.match(markup, /disabled=""/);
});
