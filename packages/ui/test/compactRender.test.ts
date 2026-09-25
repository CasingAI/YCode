import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FallbackToolCallBlock } from "../src/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

type CompactToolName = "Compact" | "CompactNow";

function renderCompact({
  toolName = "Compact",
  status = "completed",
  forceOpen = false,
  locale = "zh-CN" as "zh-CN" | "en-US",
}: {
  toolName?: CompactToolName;
  status?: "completed" | "failed" | "denied" | "stopped" | "in_progress";
  forceOpen?: boolean;
  locale?: "zh-CN" | "en-US";
} = {}): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: `compact-render-test-${toolName}-${status}`,
        toolName,
        kind: toolName,
        title: toolName,
        input: { instructions: "compact-input-sentinel" },
        output: { failed: false, outputSentinel: "compact-output-sentinel" },
        status,
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
    isRunning: status === "in_progress",
    statusLabel: status === "failed" ? "执行失败" : "已执行",
    errorText: status === "failed" ? "compact request unavailable" : undefined,
    childToolList: null,
    canToggle: true,
    forceOpen,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(FallbackToolCallBlock, context),
    ),
  );
}

test("Compact 和历史 CompactNow 成功态都显示请求语义且不可展开", () => {
  for (const toolName of ["Compact", "CompactNow"] as const) {
    const markup = renderCompact({ toolName });

    assert.match(markup, /请求压缩上下文/);
    assert.doesNotMatch(markup, />CompactNow|>Compact</);
    assert.doesNotMatch(markup, /展开工具详情/);
    assert.doesNotMatch(markup, /已执行|执行成功|已完成/);
    assert.doesNotMatch(markup, /compact-input-sentinel|compact-output-sentinel/);
  }
});

test("Compact 即使 forceOpen 也不渲染详情", () => {
  const markup = renderCompact({ forceOpen: true });

  assert.match(markup, /请求压缩上下文/);
  assert.doesNotMatch(markup, /展开工具详情|compact-input-sentinel|compact-output-sentinel/);
});

test("Compact 失败态保留失败状态", () => {
  const markup = renderCompact({ status: "failed" });

  assert.match(markup, /请求压缩上下文/);
  assert.match(markup, /执行失败/);
});

test("Compact 英文界面使用对应请求文案", () => {
  const markup = renderCompact({ locale: "en-US" });

  assert.match(markup, /Request context compression/);
  assert.doesNotMatch(markup, />CompactNow|>Compact<|Completed|Expand tool details/);
});
