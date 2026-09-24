import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ExecuteToolCallBlock } from "../src/ToolCallBlocks/renderers/execute.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const DESCRIPTION = "Inspect repository status across every package";
const COMMAND = "git status --short";

function renderExecuteSummary(): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "bash-summary-render-test",
        toolName: "Bash",
        kind: "bash",
        title: COMMAND,
        input: {
          command: COMMAND,
          description: DESCRIPTION,
        },
        output: "clean",
        status: "completed",
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
    isRunning: false,
    statusLabel: "已完成",
    childToolList: null,
    canToggle: true,
    forceOpen: true,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ExecuteToolCallBlock, context),
    ),
  );
}

function findElementByText(markup: string, text: string): { className: string; markup: string } {
  const match = new RegExp(`<([a-z0-9-]+) class="([^"]*)">${text}</\\1>`).exec(markup);
  assert.ok(match, `静态渲染结果中应包含文本：${text}`);
  return {
    className: match[2] ?? "",
    markup: match[0],
  };
}

function findSummaryContainer(markup: string): string {
  const match = /<div class="tool-summary-content[^"]*">([\s\S]*?)<\/div>/.exec(markup);
  assert.ok(match, "静态渲染结果中应包含工具摘要容器");
  return match[1] ?? "";
}

test("Execute 工具 description 独占摘要行时保持单行并在超宽时省略", () => {
  const markup = renderExecuteSummary();
  const descriptionElement = findElementByText(markup, DESCRIPTION);
  const classNames = descriptionElement.className.split(/\s+/);

  assert.ok(classNames.includes("min-w-0"));
  assert.ok(classNames.includes("flex-1"));
  assert.ok(classNames.includes("truncate"));
  assert.equal(findSummaryContainer(markup).includes(COMMAND), false);
  assert.match(markup, new RegExp(`<pre[^>]*>${COMMAND}</pre>`));
});
