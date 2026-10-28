import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ProviderTemplatePicker } from "../src/settings/model-provider-section/ProviderTemplatePicker.js";

// Beta 提示与去 Beta（docs/specs/provider-template-quota-tag.md）：
// 选择器标题下方固定显示 Beta 风险提示；minimax-token-plan 卡片保留 quota Tag
// 但不再挂 Beta 胶囊（2026-10-28 从 supportsTemplateBetaTag 白名单移除）。

function renderPicker(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderTemplatePicker, {
          templates: [
            {
              templateId: "minimax-token-plan",
              templateNameMap: { "zh-CN": "MiniMax Token Plan" },
              config: {},
            },
          ] as never,
          creating: false,
          onBack: () => undefined,
          onCreateFromTemplate: () => Promise.resolve(),
          onCreateCustom: () => Promise.resolve(),
        }),
      ),
    ),
  );
}

test("选择器顶部固定显示 Beta 风险提示", () => {
  const markup = renderPicker();

  assert.match(markup, /data-testid="model-provider-template-beta-hint"/);
  assert.match(markup, /标记为 Beta 的供应商未经过充分测试，并有封号风险。/);
});

test("minimax-token-plan 卡片保留额度 Tag、不再挂 Beta 胶囊", () => {
  const markup = renderPicker();

  assert.match(markup, /已适配额度显示/);
  assert.doesNotMatch(markup, />Beta<\/span>/);
});
