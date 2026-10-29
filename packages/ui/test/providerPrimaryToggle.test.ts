import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SectionPrimaryToggle } from "../src/settings/model-provider-section/SectionPrimaryToggle.js";
import {
  PROVIDER_DISPLAY_MODES,
  ProviderDisplayModeSelect,
  isProviderDisplayMode,
  resolveProviderDisplayModeLabel,
} from "../src/settings/model-provider-section/ProviderDisplayModeSelect.js";

// SectionPrimaryToggle（docs/specs/model-group.md）只服务模型组整节二元开关，label/hint 必填；
// ProviderDisplayModeSelect（docs/specs/provider-primary.md）承接供应商三态展示权重。

function renderSectionToggle({
  primary,
  saving = false,
}: {
  primary: boolean;
  saving?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SectionPrimaryToggle, {
        primary,
        saving,
        onCheckedChange: () => undefined,
        label: "模型组设为 Primary",
        hint: "打开后模型组整节在模型选择器一级展开，不收进二级菜单",
      }),
    ),
  );
}

test("整节 Primary 开关渲染必填 label/hint 并反映状态", () => {
  const markup = renderSectionToggle({ primary: true });

  assert.equal(markup.match(/data-testid="model-groups-primary-switch"/g)?.length, 1);
  assert.match(markup, /aria-label="模型组设为 Primary"/);
  assert.match(markup, /打开后模型组整节在模型选择器一级展开，不收进二级菜单/);
});

test("整节 Primary 开关在保存期间保持可见但不可操作", () => {
  const markup = renderSectionToggle({ primary: false, saving: true });

  assert.equal(markup.match(/data-testid="model-groups-primary-switch"/g)?.length, 1);
  assert.match(markup, /disabled=""/);
});

function renderDisplayWeightSelect({
  mode,
  saving = false,
}: {
  mode: "expanded" | "submenu" | "other";
  saving?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ProviderDisplayModeSelect, {
        mode,
        saving,
        onModeChange: () => undefined,
      }),
    ),
  );
}

test("展示权重选择器渲染行文案与触发器（radix 静态渲染不展开选项列表）", () => {
  const markup = renderDisplayWeightSelect({ mode: "submenu" });

  assert.match(markup, /data-testid="model-provider-display-weight-select"/);
  assert.match(markup, /模型展示权重/);
  assert.match(markup, /控制该供应商的模型在选择器中的层级：一级展开、二级菜单或收进「其他」/);
});

test("展示权重候选恰为三态且三档中文文案齐备", () => {
  assert.deepEqual([...PROVIDER_DISPLAY_MODES], ["expanded", "submenu", "other"]);
  // radix Select 静态渲染不含值文本，三档文案直接对 label 解析函数断言。
  const stubIntl = { formatMessage: (descriptor: { id: string }) => descriptor.id };
  assert.equal(
    resolveProviderDisplayModeLabel(stubIntl, "expanded"),
    "settings.modelProvider.displayWeight.expanded",
  );
  assert.equal(
    resolveProviderDisplayModeLabel(stubIntl, "submenu"),
    "settings.modelProvider.displayWeight.submenu",
  );
  assert.equal(
    resolveProviderDisplayModeLabel(stubIntl, "other"),
    "settings.modelProvider.displayWeight.other",
  );
});

test("onModeChange 候选值守卫：只放行合法三态", () => {
  for (const mode of PROVIDER_DISPLAY_MODES) {
    assert.equal(isProviderDisplayMode(mode), true);
  }
  assert.equal(isProviderDisplayMode("primary"), false);
  assert.equal(isProviderDisplayMode(""), false);
});

test("展示权重选择器在保存期间禁用", () => {
  const markup = renderDisplayWeightSelect({ mode: "other", saving: true });

  assert.match(markup, /data-testid="model-provider-display-weight-select"/);
  assert.match(markup, /disabled=""/);
});
