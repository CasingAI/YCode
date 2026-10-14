import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ProviderModelsSection } from "../src/settings/model-provider-section/ProviderCardSections.js";
import { CliProxyModelSyncButton } from "../src/settings/model-provider-section/CliProxyModelSyncButton.js";

// 「同步模型」按钮已从额度区独立一行移到「模型列表」标题行右侧
//（与「+ 添加模型」同排、位于其左侧）。此处覆盖：标题行内同时出现
//同步按钮与添加按钮、且同步按钮在前；按钮本体无独立行容器。

const services = {
  providerSettingsService: {
    resolveModelConfig: () => Promise.reject(new Error("unreachable")),
  },
  cliProxyService: {
    fetchModels: () => Promise.reject(new Error("unreachable")),
  },
} as never;

const noop = () => undefined;
const noopAsync = () => Promise.resolve();

function renderModelsSection(headerAction?: React.ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(
          ServiceProvider,
          { services },
          createElement(ProviderModelsSection, {
            providerId: "personal-codex",
            models: [],
            onModelCommit: noop,
            onDeleteModel: noop,
            onAddModel: noopAsync,
            headerAction,
          }),
        ),
      ),
    ),
  );
}

test("模型列表标题行：同步按钮位于添加模型按钮左侧", () => {
  const markup = renderModelsSection(
    createElement(CliProxyModelSyncButton, {
      providerId: "personal-codex",
      onAddModel: noopAsync,
    }),
  );
  assert.match(markup, /模型列表/);
  const syncIndex = markup.indexOf("同步模型");
  const addIndex = markup.indexOf("添加模型");
  assert.ok(syncIndex >= 0, "应渲染同步模型按钮");
  assert.ok(addIndex >= 0, "应渲染添加模型按钮");
  assert.ok(syncIndex < addIndex, "同步按钮应在添加按钮左侧");
});

test("无 headerAction 时标题行只有添加模型按钮", () => {
  const markup = renderModelsSection(undefined);
  assert.match(markup, /添加模型/);
  assert.doesNotMatch(markup, /同步模型/);
});
