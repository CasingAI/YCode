import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ChatContextUsage } from "../src/chat-input-toolbar/contextUsage.js";
import { SubagentStatusFooter } from "../src/v4/SubagentStatusFooter.js";
import {
  CONTEXT_PANEL_TRIGGER_GAP_PX,
  CONTEXT_TRIGGER_HIT_BRIDGE_PX,
  Context,
  ContextTrigger,
} from "../src/components/ai-elements/context.js";

// 上下文用量浮层（composer 工具栏 + 子代理底栏）保留 2px 视觉留白，同时不能因为
// Radix HoverCard 没有安全多边形而在慢速上移时关闭。规则见
// docs/specs/hover-card-trigger-gap.md。
//
// 这里只锁 SSR 接线与生产常量；真实指针穿越、border box 几何和裁剪父层由
// hoverCardTriggerGapBrowser.test.ts 在隔离 Chromium 中验证，避免用自造半平面模型代替浏览器行为。

test("几何常量：视觉留白 2px，命中桥向面板方向多重叠 1px", () => {
  assert.equal(CONTEXT_PANEL_TRIGGER_GAP_PX, 2);
  assert.equal(CONTEXT_TRIGGER_HIT_BRIDGE_PX, CONTEXT_PANEL_TRIGGER_GAP_PX + 1);
  // 重叠是为了避免亚像素定位在面板与命中桥之间留下一道新缝。
  assert.ok(CONTEXT_TRIGGER_HIT_BRIDGE_PX > CONTEXT_PANEL_TRIGGER_GAP_PX);
});

function renderContextTrigger(hitBridge?: boolean) {
  return renderToStaticMarkup(
    createElement(
      Context,
      { usedTokens: 1, maxTokens: 2 },
      createElement(ContextTrigger, {
        "aria-label": "context",
        ...(hitBridge === undefined ? {} : { hitBridge }),
      }),
    ),
  );
}

test("渲染契约：默认 ContextTrigger 不生成命中桥，其它使用点行为不变", () => {
  const markup = renderContextTrigger();
  assert.doesNotMatch(markup, /data-context-trigger-hit-bridge/);
  assert.doesNotMatch(markup, /before:-inset-x-px/);
  assert.doesNotMatch(markup, /after:-inset-x-px/);
});

test("渲染契约：hitBridge 生成上下两条精细指针命中桥，并对齐按钮 border box", () => {
  const markup = renderContextTrigger(true);
  assert.match(markup, /data-context-trigger-hit-bridge="true"/);
  // 上下各一条，覆盖 top / bottom 两种碰撞方向。
  // 按钮有 1px border，绝对定位包含块是 padding box；必须外扩 1px 才能覆盖 border box。
  assert.match(markup, /pointer-fine:before:-inset-x-px/);
  assert.match(markup, /pointer-fine:after:-inset-x-px/);
  assert.match(markup, /pointer-fine:before:bottom-\[calc\(100%\+1px\)\]/);
  assert.match(markup, /pointer-fine:after:top-\[calc\(100%\+1px\)\]/);
  // 只在精细指针下生成，触摸端命中区不变。
  assert.match(markup, /pointer-fine:before:absolute/);
  assert.match(markup, /pointer-fine:after:absolute/);
  // 命中桥高度必须与生产常量一致，避免 CSS 与几何常量漂移。
  assert.match(
    markup,
    new RegExp(`pointer-fine:before:h-\\[${CONTEXT_TRIGGER_HIT_BRIDGE_PX}px\\]`),
  );
  assert.match(markup, new RegExp(`pointer-fine:after:h-\\[${CONTEXT_TRIGGER_HIT_BRIDGE_PX}px\\]`));
});

test("composer 工具栏接线：上下文触发器启用命中桥", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ChatContextUsage, {
        taskUsage: { used: 10, size: 100 },
        selectedProvider: "openai" as never,
        intl: {
          formatMessage: ({ id }: { id: string }) => `#${id}`,
        } as never,
        locale: "zh-CN",
      }),
    ),
  );
  assert.match(markup, /data-testid="chat-context-usage-trigger"/);
  assert.match(markup, /data-context-trigger-hit-bridge="true"/);
});

test("子代理底栏接线：上下文触发器启用命中桥", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SubagentStatusFooter, {
        sessionId: "session-1",
        snapshot: {
          sessionId: "session-1",
          usage: { contextWindow: { usedTokens: 10, maxTokens: 100 } },
        } as never,
      }),
    ),
  );
  assert.match(markup, /data-testid="subagent-status-footer-usage-trigger"/);
  assert.match(markup, /data-context-trigger-hit-bridge="true"/);
});
