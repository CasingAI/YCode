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

function renderExecuteStatus(
  status: "denied" | "stopped" | "failed" | "completed",
  errorText?: string,
  output?: string,
): string {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "bash-status-render-test",
        toolName: "Bash",
        kind: "bash",
        title: COMMAND,
        input: { command: COMMAND },
        ...(output === undefined ? {} : { output }),
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
    isRunning: false,
    statusLabel:
      status === "denied"
        ? "已拒绝"
        : status === "stopped"
          ? "已停止"
          : status === "failed"
            ? "执行失败"
            : "已完成",
    ...(errorText === undefined ? {} : { errorText }),
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

test("Execute 权限拒绝显示拒绝原因，不显示没有输出或执行失败", () => {
  const markup = renderExecuteStatus("denied", "Ask mode only allows read-only tools");
  assert.match(markup, /已拒绝/);
  assert.match(markup, /Ask mode only allows read-only tools/);
  assert.equal(markup.includes("没有输出"), false);
  assert.equal(markup.includes("执行失败"), false);
});

test("Execute 成功但没有输出仍显示没有输出", () => {
  const markup = renderExecuteStatus("completed");
  assert.match(markup, /没有输出/);
  assert.equal(markup.includes("执行失败"), false);
});
