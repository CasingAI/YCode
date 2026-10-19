import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { InlineEditableProviderCard } from "../src/settings/model-provider-section/InlineEditableProviderCard.js";
import {
  ChatGPTPlanAccountCard,
  ChatGPTPlanAccountsSection,
  describeChatGPTPlanError,
} from "../src/settings/model-provider-section/ChatGPTPlanAccountsSection.js";
import { ChatGPTPlanModelRefreshButton } from "../src/settings/model-provider-section/ChatGPTPlanModelRefreshButton.js";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

// ChatGPT Plan 详情接入统一供应商卡片（docs/specs/openai-chatgpt-plan-provider.md
// 「详情接入统一供应商卡片」）：账户管理在 statusSection，模型列表走统一
// ProviderModelsSection，连接区只读，上游代理选择器保留。

const noop = () => undefined;
const noopAsync = () => Promise.resolve();

function chatGPTPlanServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    onDidChange: () => ({ dispose: noop }),
    getState: () => Promise.reject(new Error("unreachable")),
    refreshModels: () => Promise.resolve(),
    ...overrides,
  };
}

function render(ui: React.ReactElement, services: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(ServiceProvider, { services: services as never }, ui),
      ),
    ),
  );
}

function renderSection(enabled: boolean, service: unknown, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        TooltipProvider,
        null,
        createElement(
          ServiceProvider,
          { services: { chatGPTPlanService: service } as never },
          createElement(
            PlatformProvider,
            { platform: { openExternal: noop } as never },
            createElement(ChatGPTPlanAccountsSection, { enabled }),
          ),
        ),
      ),
    ),
  );
}

test("ChatGPT Plan 账户区块提供登录和官方用量入口", () => {
  const markup = renderSection(true, chatGPTPlanServiceStub());
  assert.match(markup, /ChatGPT 账户/);
  assert.match(markup, /使用 ChatGPT 继续/);
  assert.match(markup, /管理用量/);
  assert.doesNotMatch(markup, /apiKey|accessToken|refreshToken|type="password"/);
  assert.match(renderSection(true, chatGPTPlanServiceStub(), "en-US"), /Continue with ChatGPT/);
});

test("Web 或 remote 不暴露登录控制，即使意外继承本地 service 对象", () => {
  for (const markup of [
    renderSection(false, chatGPTPlanServiceStub()),
    renderSection(true, undefined),
  ]) {
    assert.match(markup, /请在本地桌面应用中/);
    assert.doesNotMatch(markup, /使用 ChatGPT 继续|取消登录|管理用量/);
  }
});

test("账户子卡片：活动账户显示已选择徽章，无选择按钮", () => {
  const markup = render(
    createElement(ChatGPTPlanAccountCard, {
      account: { id: "acc-1", label: "user@example.com", connected: true, sharing: true },
      activeAccountId: "acc-1",
      busy: false,
      describeError: (code) => code ?? "",
      onLogin: noop,
      onRun: noopAsync,
    }),
  );
  assert.match(markup, /已选择/);
  // 活动账户由徽章表达状态，不再重复状态文案，也不需要「选择账户」。
  assert.doesNotMatch(markup, /选择账户|重新登录|需要登录/);
  assert.match(markup, /退出登录/);
  assert.match(markup, /移除账户/);
});

test("账户子卡片：未连接账户需要重新登录，且可被选择前先连接", () => {
  const markup = render(
    createElement(ChatGPTPlanAccountCard, {
      account: { id: "acc-2", label: "other@example.com", connected: false },
      activeAccountId: "acc-1",
      busy: false,
      describeError: (code) => code ?? "",
      onLogin: noop,
      onRun: noopAsync,
    }),
  );
  assert.match(markup, /需要登录/);
  assert.match(markup, /重新登录/);
  assert.doesNotMatch(markup, /退出登录/);
});

test("账户级错误使用稳定错误码映射，不透出原始错误对象", () => {
  const describe = describeChatGPTPlanError(({ id }) =>
    id === "settings.chatGPTPlan.error.reauthentication" ? "登录授权已失效" : id,
  );
  assert.equal(describe("reauthentication_required"), "登录授权已失效");
  assert.equal(describe("oauth_endpoint_http_429"), "settings.chatGPTPlan.error.oauthEndpoint");
  assert.equal(describe(undefined), "settings.chatGPTPlan.failed");
});

test("模型刷新按钮渲染在统一模型列表标题行", () => {
  const markup = render(createElement(ChatGPTPlanModelRefreshButton), chatGPTPlanServiceStub());
  assert.match(markup, /刷新模型/);
});

function chatGPTPlanProvider(): ProviderSettingsFormProvider {
  const config = {
    group: "standard-personal",
    access: { type: "chatgpt-plan", accountId: "acc-1" },
    api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  };
  return {
    providerId: "openai-chatgpt-plan",
    providerName: "OpenAI (ChatGPT Plan)",
    enabled: true,
    executable: true,
    config,
    personalConfig: config,
    models: [
      {
        modelId: "gpt-6.1-sol",
        config: { properties: {} },
        personalConfig: {},
        hasPersonalConfig: true,
      },
    ],
  } as unknown as ProviderSettingsFormProvider;
}

test("统一卡片分支：连接区只读、保留上游代理，模型走统一列表", () => {
  const markup = render(
    createElement(InlineEditableProviderCard, {
      provider: chatGPTPlanProvider(),
      onSave: noopAsync,
      readOnlyEndpoints: true,
      settingsRevision: 1,
    }),
    {
      providerSettingsService: {
        resolveModelConfig: () => Promise.reject(new Error("unreachable")),
      },
    },
  );
  // 上游代理选择器保留（testid 沿用既有 E2E 锚点）。
  assert.match(markup, /data-testid="model-provider-chatgpt-plan-upstream-proxy-trigger"/);
  // 连接区只读：官方 origin 仅展示，不可编辑；不出现 Base URL 输入框。
  assert.match(markup, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(markup, /data-testid="model-provider-base-url-input"/);
  // chatgpt-plan access 不是 API Key，不渲染密钥输入。
  assert.doesNotMatch(markup, /type="password"/);
  // 模型目录由 Host 发布，走统一模型列表行渲染。
  assert.match(markup, /gpt-6\.1-sol/);
});
