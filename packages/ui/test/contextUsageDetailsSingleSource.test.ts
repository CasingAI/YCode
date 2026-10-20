import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ChatContextUsage } from "../src/chat-input-toolbar/contextUsage.js";

// 上下文详情只有一份渲染实现：输入框浮层与子代理只读面板都渲染
// ContextUsageDetails。两边各写一份时，来源明细的顺序、分段颜色和文案会各自漂移，
// 用户看到的"同一个东西"就长得不一样（见 docs/specs/subagent-status-footer.md）。

const composerPanelSource = readFileSync(
  new URL("../src/chat-input-toolbar/contextUsage.tsx", import.meta.url),
  "utf8",
);
const subagentFooterSource = readFileSync(
  new URL("../src/v4/SubagentStatusFooter.tsx", import.meta.url),
  "utf8",
);

test("输入框浮层复用共享的 ContextUsageDetails", () => {
  assert.match(
    composerPanelSource,
    /import \{ ContextUsageDetails \} from "@\/chat-input-toolbar\/ContextUsageDisplay\.js";/,
  );
  assert.match(composerPanelSource, /<ContextUsageDetails\b/);
});

test("输入框浮层不再自带第二份来源明细与缓存命中率渲染", () => {
  // 明细来源标签与缓存命中率文案只属于共享组件；浮层里再写一份就是第二套实现。
  assert.doesNotMatch(composerPanelSource, /chat\.contextUsage\.breakdown/);
  assert.doesNotMatch(composerPanelSource, /chat\.contextUsage\.cacheHitRate/);
  assert.doesNotMatch(composerPanelSource, /chat\.contextUsage\.title/);
  assert.doesNotMatch(composerPanelSource, /BREAKDOWN_SOURCE_LABEL_ID/);
});

test("子代理底栏同样复用共享的 ContextUsageDetails", () => {
  assert.match(
    subagentFooterSource,
    /import \{ ContextUsageDetails \} from "@\/chat-input-toolbar\/ContextUsageDisplay\.js";/,
  );
  assert.match(subagentFooterSource, /<ContextUsageDetails\b/);
});

test("输入框浮层挂上共享详情后仍能渲染并带用量口径", () => {
  // 浮层正文在 Portal 里，SSR 拿不到；这里守住"接入共享组件后没有把入口渲染坏"。
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ChatContextUsage, {
        taskUsage: {
          used: 160_700,
          size: 200_000,
          cache: { hitRate: 0.42 },
          breakdown: [{ source: "messages", chars: 4_000, tokens: 1_000 }],
        },
        selectedProvider: { id: "glm" } as never,
        intl: { formatMessage: ({ id }: { id: string }) => `#${id}` } as never,
        locale: "zh-CN",
      }),
    ),
  );
  assert.ok(markup.length > 0);
  assert.ok(markup.includes("hover-card-trigger"), "上下文入口应正常渲染");
});
