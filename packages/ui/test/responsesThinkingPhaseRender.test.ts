import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@zcode/shared";
import { Reasoning, ReasoningTrigger } from "../src/components/ai-elements/reasoning.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderEmptyPhase(options: {
  durationMs?: number;
  interrupted?: boolean;
  locale?: Locale;
}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "zh-CN" },
      createElement(
        Reasoning,
        {
          canExpand: false,
          isStreaming: false,
          startedAt: 1000,
          durationMs: options.durationMs,
          interrupted: options.interrupted,
        },
        createElement(ReasoningTrigger),
      ),
    ),
  );
}

test("完成的空思考阶段显示固定耗时并保持不可展开", () => {
  const markup = renderEmptyPhase({ durationMs: 5000 });

  assert.match(markup, /思考/);
  assert.match(markup, /耗时 5 秒/);
  assert.doesNotMatch(markup, /<button|aria-expanded/);
});

test("中断的空思考阶段同时保留固定耗时和中断标识", () => {
  const markup = renderEmptyPhase({ durationMs: 85000, interrupted: true });

  assert.match(markup, /耗时 1 分 25 秒/);
  assert.match(markup, /已中断/);
});

test("空思考阶段的英文完成标题使用现有耗时单位", () => {
  const markup = renderEmptyPhase({ durationMs: 5000, locale: "en-US" });

  assert.match(markup, /Thought/);
  assert.match(markup, /5s/);
});

test("缺少固定耗时的旧空阶段不从开始时间推算终态耗时", () => {
  const markup = renderEmptyPhase({});

  assert.match(markup, /思考/);
  assert.doesNotMatch(markup, /耗时|持续|秒/);
});
