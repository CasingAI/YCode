import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ListPlansToolCallBlock } from "../src/ToolCallBlocks/renderers/list-plans.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

function makeContext({
  display,
  status = "completed" as const,
  isRunning = false,
  onOpenPlanDirectory,
}: {
  display?: { kind: "list_plans"; planCount: number };
  status?: "completed" | "failed" | "denied" | "stopped" | "in_progress";
  isRunning?: boolean;
  onOpenPlanDirectory?: () => void;
} = {}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "list-plans-render-test",
        toolName: "ListPlans",
        kind: "ListPlans",
        title: "ListPlans",
        input: {},
        output: "Found 2 plans in this session",
        raw: display ? { display } : {},
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
    isRunning,
    statusLabel: "执行失败",
    childToolList: null,
    canToggle: true,
    forceOpen: false,
    onOpenPlanDirectory,
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
      createElement(ListPlansToolCallBlock, context),
    ),
  );
}

test("ListPlans 专用卡只显示计数并把摘要变成计划目录入口", () => {
  const markup = renderContext(
    makeContext({
      display: { kind: "list_plans", planCount: 2 },
      onOpenPlanDirectory: () => undefined,
    }),
  );
  assert.match(markup, /找到 2 份计划/);
  assert.match(markup, /查看计划目录/);
  assert.match(markup, /data-testid="list-plans-directory-list-plans-render-test"/);
  assert.doesNotMatch(markup, /PARAMETERS|RESULT|Found 2 plans|Plan B|\/workspace/);
});

test("ListPlans 空结果不提供无意义的目录动作", () => {
  const markup = renderContext(
    makeContext({
      display: { kind: "list_plans", planCount: 0 },
      onOpenPlanDirectory: () => undefined,
    }),
  );
  assert.match(markup, /暂无计划/);
  assert.doesNotMatch(markup, /data-testid="list-plans-directory/);
});

test("ListPlans 运行态和失败态不读取历史 display", () => {
  const running = renderContext(
    makeContext({
      display: { kind: "list_plans", planCount: 2 },
      status: "in_progress",
      isRunning: true,
    }),
  );
  assert.match(running, /正在读取计划/);
  assert.doesNotMatch(running, /找到 2 份计划|data-testid="list-plans-directory/);

  const failed = renderContext(
    makeContext({
      display: { kind: "list_plans", planCount: 2 },
      status: "failed",
    }),
  );
  assert.match(failed, /执行失败/);
  assert.doesNotMatch(failed, /找到 2 份计划|data-testid="list-plans-directory/);
});

test("ListPlans 无结构化 display 的历史终态回退通用卡", () => {
  const markup = renderContext(makeContext());
  assert.match(markup, /ListPlans/);
  assert.doesNotMatch(markup, /找到 2 份计划|查看计划目录|data-testid="list-plans-directory/);
});

test("ListPlans 英文摘要保持计划目录语义", () => {
  const markup = renderContext(
    makeContext({
      display: { kind: "list_plans", planCount: 2 },
      onOpenPlanDirectory: () => undefined,
    }),
    "en-US",
  );
  assert.match(markup, /Found 2 plans/);
  assert.match(markup, /Open plan directory/);
});
