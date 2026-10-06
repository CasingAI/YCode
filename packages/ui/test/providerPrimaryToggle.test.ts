import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ProviderPrimaryToggle } from "../src/settings/model-provider-section/ProviderPrimaryToggle.js";

function renderToggle({ primary, saving = false }: { primary: boolean; saving?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ProviderPrimaryToggle, {
        primary,
        saving,
        onCheckedChange: () => undefined,
      }),
    ),
  );
}

test("Primary 开关只渲染一个控件并反映标记状态", () => {
  const markup = renderToggle({ primary: true });

  assert.equal(markup.match(/data-testid="model-provider-primary-switch"/g)?.length, 1);
  assert.match(markup, /aria-label="Primary 供应商"/);
  assert.match(markup, /在模型选择器中直接展开该供应商的模型，而不是放进二级菜单/);
});

test("Primary 开关在保存期间保持可见但不可操作", () => {
  const markup = renderToggle({ primary: false, saving: true });

  assert.equal(markup.match(/data-testid="model-provider-primary-switch"/g)?.length, 1);
  assert.match(markup, /disabled=""/);
});
