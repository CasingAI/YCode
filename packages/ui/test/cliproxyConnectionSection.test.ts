import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ProviderConnectionSection } from "../src/settings/model-provider-section/ProviderCardSections.js";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

// CLI Proxy 连接区整体不渲染：Base URL 由运行时决定、协议强制 Responses
//（解析层覆盖），都不给控件。普通分支（可编辑 / 纯只读）不受影响。

function provider(templateId: string): ProviderSettingsFormProvider {
  return {
    providerId: "personal-1",
    templateId,
    providerName: "Test",
    enabled: true,
    executable: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "k" },
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8317/v1" },
    },
    personalConfig: {},
    models: [],
  } as unknown as ProviderSettingsFormProvider;
}

const noop = () => undefined;

function render(section: Parameters<typeof ProviderConnectionSection>[0]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ProviderConnectionSection, section),
    ),
  );
}

test("cliproxy 分支：连接区整体不渲染（无 Base URL、无协议选择器）", () => {
  const markup = render({
    provider: provider("cliproxy-codex"),
    readOnly: true,
    protocolSelectable: true,
    apiFormat: "openai-chat-completions",
    baseUrlValue: "http://127.0.0.1:8317/v1",
    onApiFormatChange: noop,
    onBaseUrlChange: noop,
    onBaseUrlBlur: noop,
  });
  assert.doesNotMatch(markup, /model-provider-base-url-input/);
  // 协议强制 Responses：选择器也不再渲染。
  assert.doesNotMatch(markup, /model-provider-api-format-trigger/);
  // Base URL 区块整体移除：地址、锁图标、只读说明都不再渲染。
  assert.doesNotMatch(markup, /127\.0\.0\.1:8317/);
  assert.doesNotMatch(markup, /只读展示/);
  assert.doesNotMatch(markup, /API 格式/);
});

test("普通只读分支：无协议选择器（不受 cliproxy 影响）", () => {
  const markup = render({
    provider: provider("openai"),
    readOnly: true,
    apiFormat: "openai-chat-completions",
    baseUrlValue: "https://api.example.com/v1",
    onApiFormatChange: noop,
    onBaseUrlChange: noop,
    onBaseUrlBlur: noop,
  });
  assert.doesNotMatch(markup, /model-provider-base-url-input/);
  assert.doesNotMatch(markup, /model-provider-api-format-trigger/);
});

test("普通可编辑分支：有 baseURL 输入框与协议选择器", () => {
  const markup = render({
    provider: provider("openai"),
    apiFormat: "openai-chat-completions",
    baseUrlValue: "https://api.example.com/v1",
    onApiFormatChange: noop,
    onBaseUrlChange: noop,
    onBaseUrlBlur: noop,
  });
  assert.match(markup, /model-provider-base-url-input/);
  assert.match(markup, /model-provider-api-format-trigger/);
});
