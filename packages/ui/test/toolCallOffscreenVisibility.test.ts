import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ToolCallBlock } from "../src/ToolCallBlocks.js";
import { NodeReplToolCallBlock } from "../src/ToolCallBlocks/renderers/node-repl.js";
import { McpToolCallBlock } from "../src/ToolCallBlocks/renderers/mcp.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import type { TaskChatToolCallTreeNode } from "../src/lib/toolCallTree.js";

const TOOL_ID = "offscreen-visibility-tool";

function buildToolCallNode(): TaskChatToolCallTreeNode {
  return {
    childToolCalls: [],
    toolCall: {
      toolId: TOOL_ID,
      toolName: "Read",
      kind: "read",
      title: "src/main.ts",
      input: { filePath: "src/main.ts" },
      output: "ok",
      status: "completed",
    },
  };
}

function renderToolCallBlock(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolCallBlock, {
        toolCallNode: buildToolCallNode(),
        workspacePath: "/workspace",
        theme: "light",
      }),
    ),
  );
}

test("工具卡根节点启用离屏渲染优化", () => {
  const markup = renderToolCallBlock();

  // content-visibility 让浏览器跳过可视区之外的布局、样式计算与绘制。
  assert.match(markup, /content-visibility:auto/);
  // contain-intrinsic-size 的 auto 表示优先用浏览器记住的上次真实尺寸，
  // 40px 是首次渲染前对应折叠态摘要行高度的兜底值。
  assert.match(markup, /contain-intrinsic-size:auto 40px/);
});

test("离屏优化不改变工具卡的 DOM 标识", () => {
  const markup = renderToolCallBlock();

  assert.match(markup, new RegExp(`data-tool-call-id="${TOOL_ID}"`));
  assert.match(markup, /data-tool-name="Read"/);
  assert.match(markup, /data-status="completed"/);
  assert.match(markup, /data-testid="chat-tool-call-block/);
});

test("离屏优化只落在工具卡根节点，不重复施加到内部摘要行", () => {
  const markup = renderToolCallBlock();

  // 根节点带样式；摘要行（tool-summary）是根节点的后代，不应各自再带一份，
  // 否则同一棵子树里会叠加多层跳过判定，滚动时更容易出现占位高度跳变。
  const offscreenOccurrences = markup.match(/content-visibility:auto/g) ?? [];
  assert.equal(offscreenOccurrences.length, 1);
});

/**
 * node-repl 与 mcp 的代码块刻意关掉离屏优化：它们在 max-h-72 overflow-auto 的
 * 嵌套滚动容器里，Radix 折叠动画会按 200px 占位测高，导致先展开过头再回落。
 * 工具卡根节点启用离屏优化不应顺带改掉这两处的豁免。
 */
function renderRendererWithCodeBlock(
  Renderer: (context: ToolCallBlockRenderContext) => React.ReactElement,
  kind: "node_repl" | "mcp_tool",
): string {
  const toolCallNode: TaskChatToolCallTreeNode = {
    childToolCalls: [],
    toolCall: {
      toolId: `${kind}-offscreen-tool`,
      toolName: kind,
      kind,
      title: "result",
      input: {},
      output: "line one\nline two\nline three",
      status: "completed",
      // mcp 靠 raw.display 里的 presentation 走通用 MCP 分支；node-repl 同样带该
      // presentation，但渲染器按可信 tool identity 先于通用 MCP 分支命中。
      raw: {
        display: {
          kind: "mcp_tool",
          serverName: "test-server",
          toolName: "test-tool",
        },
      },
    },
  } as unknown as TaskChatToolCallTreeNode;
  const context = {
    toolCallNode,
    workspacePath: "/workspace",
    theme: "light",
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
    isRunning: false,
    statusLabel: "已完成",
    childToolList: null,
    canToggle: true,
    forceOpen: true,
  } as unknown as ToolCallBlockRenderContext;

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, null, createElement(Renderer, context)),
    ),
  );
}

test("node-repl 的代码块保持关闭离屏优化", () => {
  const markup = renderRendererWithCodeBlock(NodeReplToolCallBlock, "node_repl");

  assert.match(markup, /content-visibility:visible/);
  assert.match(markup, /contain-intrinsic-size:none/);
});

test("mcp 的代码块保持关闭离屏优化", () => {
  const markup = renderRendererWithCodeBlock(McpToolCallBlock, "mcp_tool");

  assert.match(markup, /content-visibility:visible/);
  assert.match(markup, /contain-intrinsic-size:none/);
});
