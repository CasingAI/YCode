import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { CliProxyUpstreamProxySelect } from "../src/settings/model-provider-section/CliProxyUpstreamProxySelect.js";

// 上游代理选择控件（docs/specs/plugin-cli-proxy-binary.md「上游代理」）渲染面。

function render(mode: "default" | "proxy" | "direct"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(CliProxyUpstreamProxySelect, {
        mode,
        onModeChange: () => undefined,
      }),
    ),
  );
}

test("渲染触发器与文案（radix 静态渲染不展开选项列表）", () => {
  const markup = render("proxy");
  assert.match(markup, /data-testid="model-provider-cliproxy-upstream-proxy-trigger"/);
  assert.match(markup, /上游代理/);
  assert.match(markup, /Codex 出网是否走「网络」里配置的代理地址/);
});
