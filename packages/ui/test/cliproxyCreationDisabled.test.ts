import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ProviderTemplatePicker } from "../src/settings/model-provider-section/ProviderTemplatePicker.js";

// Web/移动端边界（docs/specs/plugin-cli-proxy-binary.md）：
// cliproxy 分组卡片在禁用位为真时 disabled 并附「请在桌面端添加」提示；
// 其它分组与桌面端（禁用位为 false）行为不变。

function cliproxyTemplate(templateId: string) {
  return {
    templateId,
    templateNameMap: { "zh-CN": "Codex 代理" },
    config: {},
  };
}

function renderPicker(cliProxyCreationDisabled: boolean): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderTemplatePicker, {
          templates: [
            cliproxyTemplate("cliproxy-codex"),
            { templateId: "openai", templateNameMap: { "zh-CN": "OpenAI" }, config: {} },
          ] as never,
          creating: false,
          cliProxyCreationDisabled,
          onBack: () => undefined,
          onCreateFromTemplate: () => Promise.resolve(),
          onCreateCustom: () => Promise.resolve(),
        }),
      ),
    ),
  );
}

test("web/远端：cliproxy 卡片禁用并显示桌面端提示", () => {
  const markup = renderPicker(true);

  assert.match(markup, /请在桌面端添加/);
  // cliproxy 卡片 disabled；openai 卡片不受影响（仍可点击，无 disabled）。
  // 注意：class 中的 `disabled:opacity-60` 不是禁用态，以 `disabled=""` 属性为准。
  assert.match(markup, /data-testid="model-provider-template-item-cliproxy-codex" disabled=""/);
  assert.doesNotMatch(markup, /data-testid="model-provider-template-item-openai" disabled=""/);
});

test("桌面端：cliproxy 卡片不受影响，无提示", () => {
  const markup = renderPicker(false);

  assert.doesNotMatch(markup, /请在桌面端添加/);
  assert.doesNotMatch(
    markup,
    /data-testid="model-provider-template-item-cliproxy-codex" disabled=""/,
  );
});

test("模板分组顺序：代理置顶、智谱置底", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderTemplatePicker, {
          templates: [
            { templateId: "openai", templateNameMap: { "zh-CN": "OpenAI" }, config: {} },
            {
              templateId: "opencode-go-chat",
              templateNameMap: { "zh-CN": "OpenCode" },
              config: {},
            },
            cliproxyTemplate("cliproxy-codex"),
            { templateId: "zai-api", templateNameMap: { "zh-CN": "Z.ai" }, config: {} },
          ] as never,
          creating: false,
          onBack: () => undefined,
          onCreateFromTemplate: () => Promise.resolve(),
          onCreateCustom: () => Promise.resolve(),
        }),
      ),
    ),
  );

  const order = [...markup.matchAll(/data-provider-template-group="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, ["cliproxy", "opencode", "other", "zhipu"]);
  assert.match(markup, /data-testid="model-provider-template-item-openai"/);
});

// ChatGPT Plan 新增入口自 2026-10-21 起隐藏：套餐剩余额度只在 legacy Codex 凭据
// 配合未公开端点时才能读到，SIWC 凭据无法进入该端点。已配置的 provider 不受影响。
// 见 docs/specs/openai-chatgpt-plan-provider.md「新增入口暂时隐藏」。
test("ChatGPT Plan 新增入口不再展示，桌面端与 web/远端一致", () => {
  for (const disabled of [false, true]) {
    const markup = renderPicker(disabled);

    assert.doesNotMatch(markup, /data-testid="model-provider-template-item-chatgpt-plan"/);
    assert.doesNotMatch(markup, /OpenAI \(ChatGPT Plan\)/);
    assert.doesNotMatch(markup, /data-provider-template-group="chatgpt"/);
  }
});
