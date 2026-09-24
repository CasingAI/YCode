import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GetContextUsageToolCallBlock } from "../src/ToolCallBlocks/renderers/get-context-usage.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const USAGE = {
  contextWindowTokens: 200_000,
  effectiveContextWindowTokens: 179_000,
  autocompactThresholdTokens: 166_000,
  usedTokens: 12_345,
  remainingTokens: 166_655,
  usedPercent: 6.9,
  remainingPercent: 93.1,
  tokenSource: "estimate" as const,
};

function makeContext({
  output,
  raw = {},
  status = "completed" as const,
  isRunning = false,
  forceOpen = true,
  error,
}: {
  output?: unknown;
  raw?: Record<string, unknown>;
  status?: "completed" | "failed" | "denied" | "stopped" | "in_progress";
  isRunning?: boolean;
  forceOpen?: boolean;
  error?: string;
} = {}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "context-usage-render-test",
        toolName: "GetContextUsage",
        kind: "GetContextUsage",
        title: "GetContextUsage",
        input: {},
        output,
        raw,
        status,
        error,
      },
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: true,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning,
    statusLabel: "",
    childToolList: null,
    canToggle: true,
    forceOpen,
    errorText: error,
  };
}

function renderContext(
  context: ToolCallBlockRenderContext,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(GetContextUsageToolCallBlock, context),
    ),
  );
}

test("GetContextUsage 专用 renderer 不展示通用 JSON 结构", () => {
  const context = makeContext({ raw: { display: { kind: "get_context_usage", ...USAGE } } });
  const markup = renderContext(context);
  assert.match(markup, /上下文用量/);
  assert.match(markup, /12\.3K\s*\/\s*179K/);
  assert.match(markup, /166K/);
  assert.match(markup, /200K/);
  assert.match(markup, /本地估算/);
  assert.doesNotMatch(markup, /Parameters|Result|contextWindowTokens|usedTokens/);
});

test("GetContextUsage 正常完成态在窄容器使用极简单行布局", () => {
  const markup = renderContext(
    makeContext({ raw: { display: { kind: "get_context_usage", ...USAGE } } }),
  );
  assert.match(
    markup,
    /<span class="min-w-0 flex-1 truncate font-mono tabular-nums">12\.3K\s*\/\s*179K/,
  );
  assert.match(markup, /<span class="shrink-0 whitespace-nowrap">剩余 166\.7K<\/span>/);
  assert.match(markup, /@max-\[480px\]\/conversation:hidden[^>]*>上下文用量/);
  assert.match(markup, /@max-\[480px\]\/conversation:hidden[^>]*>已读取上下文/);
  assert.match(
    markup,
    /class="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 @min-\[769px\]\/conversation:grid-cols-2"/,
  );
});

test("GetContextUsage 状态异常和无数据时保留状态文案", () => {
  const failed = renderContext(
    makeContext({
      raw: { display: { kind: "get_context_usage", ...USAGE } },
      status: "failed",
      error: "context port unavailable",
    }),
  );
  assert.match(failed, /执行失败/);
  assert.doesNotMatch(failed, /@max-\[480px\]\/conversation:hidden[^>]*>执行失败/);

  const unavailable = renderContext(makeContext({ output: "not-json" }));
  assert.match(unavailable, /上下文用量/);
  assert.doesNotMatch(unavailable, /@max-\[480px\]\/conversation:hidden[^>]*>上下文用量/);
});

test("GetContextUsage 英文容量保持 K/M/B 口径", () => {
  const markup = renderContext(
    makeContext({ raw: { display: { kind: "get_context_usage", ...USAGE } } }),
    "en-US",
  );
  assert.match(markup, /Context usage/);
  assert.match(markup, /12\.3K\s*\/\s*179K/);
  assert.match(markup, /200K/);
  assert.match(markup, /Local estimate/);
});

test("GetContextUsage 兼容历史 output JSON", () => {
  const markup = renderContext(makeContext({ output: JSON.stringify(USAGE) }));
  assert.match(markup, /上下文用量/);
  assert.match(markup, /12\.3K\s*\/\s*179K/);
  assert.doesNotMatch(markup, /Parameters|Result|contextWindowTokens/);
});

test("GetContextUsage 运行态不读取旧值，失败态不回退 raw JSON", () => {
  const running = renderContext(
    makeContext({
      output: JSON.stringify(USAGE),
      status: "in_progress",
      isRunning: true,
      forceOpen: false,
    }),
  );
  assert.match(running, /正在读取上下文用量/);
  // 一次是摘要类别，一次是触发器 title；不能再在摘要正文重复渲染。
  assert.equal(running.match(/正在读取上下文用量/g)?.length, 2);
  assert.doesNotMatch(running, /12\.3K|Parameters|Result/);

  const failed = renderContext(
    makeContext({
      output: JSON.stringify(USAGE),
      status: "failed",
      forceOpen: false,
      error: "context port unavailable",
    }),
  );
  assert.match(failed, /执行失败/);
  assert.doesNotMatch(failed, /12\.3K|Parameters|Result/);
});

test("GetContextUsage 无效终态显示稳定不可用状态", () => {
  const markup = renderContext(makeContext({ output: "not-json" }));
  assert.match(markup, /数据不可用/);
  assert.match(markup, /没有可用的结构化上下文用量数据/);
  assert.doesNotMatch(markup, /not-json|Parameters|Result/);
});

test("GetContextUsage 0% 和 100% 边界不产生 NaN", () => {
  for (const percent of [0, 100]) {
    const markup = renderContext(
      makeContext({
        raw: {
          display: {
            kind: "get_context_usage",
            ...USAGE,
            usedPercent: percent,
            remainingPercent: 100 - percent,
            remainingTokens: percent === 100 ? 0 : USAGE.remainingTokens,
          },
        },
      }),
    );
    assert.doesNotMatch(markup, /NaN|Infinity/);
  }
});
