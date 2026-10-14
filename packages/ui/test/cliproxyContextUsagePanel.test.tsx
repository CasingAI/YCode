import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  ChatCliProxyQuotaPanel,
  hasChatCliProxyQuota,
} from "../src/chat-input-toolbar/CliProxyContextUsage.js";

// Composer 额度环面板（docs/specs/plugin-cli-proxy-binary.md「上游代理」同章的额度接入）：
// cliproxy-* 提供商选中时 ChatContextUsage 才渲染 CLI Proxy 额度段。

test("hasChatCliProxyQuota：有 providerId 才算有", () => {
  assert.equal(hasChatCliProxyQuota(undefined), false);
  assert.equal(hasChatCliProxyQuota({ providerId: "", onManage: () => undefined }), false);
  assert.equal(hasChatCliProxyQuota({ providerId: "cliproxy-codex", onManage: () => undefined }), true);
});

test("面板渲染：窗口 label id 覆盖三档（weekly/5h/other）", () => {
  // 通过 renderToStaticMarkup 渲染挂载即拉额度的面板：无服务（useOptionalServices 为空）
  // 时 windows 为空且不抛错，错误态渲染降级文案。
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ChatCliProxyQuotaPanel, {
        config: { providerId: "cliproxy-codex", onManage: () => undefined },
        intl: {
          formatMessage: ({ id }: { id: string }) => `#${id}`,
        } as never,
        locale: "zh-CN",
      }),
    ),
  );
  assert.match(markup, /#chat\.cliproxyQuota\.title/);
});
