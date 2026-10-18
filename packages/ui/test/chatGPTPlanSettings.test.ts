import { createElement } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ChatGPTPlanSection } from "../src/settings/model-provider-section/ChatGPTPlanSection.js";

function render(enabled: boolean, localService: boolean, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: { chatGPTPlanService: localService ? {} : undefined } as never },
      createElement(
        PlatformProvider,
        { platform: { openExternal() {} } as never },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(ChatGPTPlanSection, { enabled }),
        ),
      ),
    ),
  );
}

test("Desktop 独立订阅卡片提供登录和官方用量入口", () => {
  const markup = render(true, true);
  assert.match(markup, /OpenAI \(ChatGPT Plan\)/);
  assert.match(markup, /使用 ChatGPT 继续/);
  assert.match(markup, /管理用量/);
  assert.doesNotMatch(markup, /apiKey|accessToken|refreshToken|type="password"/);
  assert.match(render(true, true, "en-US"), /Continue with ChatGPT/);
});

test("Web 或 remote 不暴露登录控制，即使意外继承本地 service 对象", () => {
  for (const markup of [render(false, true), render(true, false)]) {
    assert.match(markup, /请在本地桌面应用中/);
    assert.doesNotMatch(markup, /使用 ChatGPT 继续|取消登录|刷新模型/);
  }
});
