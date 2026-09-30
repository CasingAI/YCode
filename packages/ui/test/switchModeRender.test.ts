// ExitPlanMode 行的渲染回归：真失败时报错文本同时落在 output.text，
// 必须先拦截再取计划内容，否则报错被回收成正文、渲染出带可点「执行计划」的假计划卡。
// 计划批准拒绝到不了这条分支：桥接层已对它豁免失败标记（status=stopped、error 为空）。
// 背景见 docs/specs/plan-card-execute.md 的「失败判据必须先于内容分支执行」一条。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SwitchModeToolCallBlock } from "../src/ToolCallBlocks/renderers/switch-mode.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const INPUT_VALIDATION_ERROR = "Tool input failed inputSchema validation";

/**
 * 复刻 `toolCallRowToLegacyNode` 对失败 ExitPlanMode 行的真实产出：
 * 入参被上游降级成 `{}`，报错同时进 `error` 与 `output`（即 v4 `output.text`）。
 * 上一轮测试只在 `error` 放报错、`output` 留空——真实投影不是这个形状，
 * 所以全绿却没拦住线上的假计划卡。
 */
function failedLegacyNode(status: "failed" | "denied", error: string) {
  return {
    toolId: "exit-plan-mode-render-test",
    toolName: "ExitPlanMode",
    kind: "ExitPlanMode",
    title: "ExitPlanMode",
    input: {},
    status,
    output: error,
    error,
    raw: {
      error: { message: error },
      rawOutput: error,
      status,
      toolCallId: "exit-plan-mode-render-test",
      toolName: "ExitPlanMode",
      v4Status: "error",
      inputPreviewComplete: true,
    },
  };
}

function makeContext({
  toolCall,
  forceOpen = false,
  onExecutePlan,
  onOpenPlanDetail,
}: {
  toolCall: ReturnType<typeof failedLegacyNode> | Record<string, unknown>;
  forceOpen?: boolean;
  onExecutePlan?: () => void;
  onOpenPlanDetail?: (request: { toolCallId: string; markdown: string }) => void;
}): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      childToolCalls: [],
      toolCall: toolCall as ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
    },
    workspacePath: "/workspace",
    // 取值与 `buildToolDisplayModel` 对带 errorText 行的 error 分支一致：
    // 失败态收敛成错误信息视图，不展示 Parameters。
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "执行失败",
    errorText: typeof toolCall.error === "string" ? toolCall.error : undefined,
    childToolList: null,
    canToggle: true,
    forceOpen,
    onExecutePlan,
    onOpenPlanDetail,
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
      createElement(SwitchModeToolCallBlock, context),
    ),
  );
}

test("入参校验失败时渲染为通用失败工具行，且没有任何动作入口", () => {
  const markup = renderContext(
    makeContext({
      toolCall: failedLegacyNode("failed", INPUT_VALIDATION_ERROR),
      // 宿主照常注入动作回调：失败行必须自己决定不渲染它们。
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
    }),
  );

  // 工具身份：工具名 + 失败徽标。
  assert.match(markup, /ExitPlanMode/);
  assert.match(markup, /执行失败/);
  // 线上事故的直接断言：报错不得伪装成计划卡，卡上不得出现可点的执行入口。
  assert.doesNotMatch(markup, /执行计划/);
  assert.doesNotMatch(markup, />查看</);
});

test("入参校验失败时展开可见失败原因", () => {
  const markup = renderContext(
    makeContext({
      toolCall: failedLegacyNode("failed", INPUT_VALIDATION_ERROR),
      forceOpen: true,
    }),
  );

  assert.match(markup, /Tool input failed inputSchema validation/);
});

test("非计划模式的权限拒绝（无 permissionDenial 豁免）仍是带工具名的失败行", () => {
  const markup = renderContext(
    makeContext({
      toolCall: failedLegacyNode(
        "denied",
        "ExitPlanMode can only be used while plan mode is active",
      ),
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
      forceOpen: true,
    }),
  );

  assert.match(markup, /ExitPlanMode/);
  assert.match(markup, /ExitPlanMode can only be used while plan mode is active/);
  assert.doesNotMatch(markup, /执行计划/);
});

test("搁置的计划（桥接豁免后的形态）渲染折叠卡：有查看与执行入口、无失败徽标", () => {
  // 复刻桥接层对计划批准拒绝的豁免产出：status=stopped、error 为空、input 完整。
  // 这是 toolCallRowToLegacyNode 的真实输出形状，断言依据见 planApprovalDenialBridge.test.ts。
  const markup = renderContext(
    makeContext({
      toolCall: {
        toolId: "exit-plan-mode-render-test",
        toolName: "ExitPlanMode",
        kind: "ExitPlanMode",
        title: "ExitPlanMode",
        input: {
          title: "缓存验收",
          overview: "收口缓存验收清单，不改代码。",
          plan: "# 缓存验收\n正文",
        },
        status: "stopped",
        raw: {
          permissionDenial: { decision: "deny", reason: "Permission denied for ExitPlanMode" },
          status: "stopped",
          toolCallId: "exit-plan-mode-render-test",
          toolName: "ExitPlanMode",
          v4Status: "cancelled",
          inputPreviewComplete: true,
        },
      },
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
    }),
  );

  assert.match(markup, /缓存验收/);
  assert.match(markup, /收口缓存验收清单/);
  assert.match(markup, /执行计划/);
  assert.match(markup, />查看</);
  assert.doesNotMatch(markup, /执行失败/);
});

test("成功态折叠卡不被失败拦截串形", () => {
  const markup = renderContext(
    makeContext({
      toolCall: {
        toolId: "exit-plan-mode-render-test",
        toolName: "ExitPlanMode",
        kind: "ExitPlanMode",
        title: "ExitPlanMode",
        input: {
          title: "行内编辑卡冻结模型名",
          overview: "把冻结模型名改成按会话列宽度分段显示。",
          plan: "# 行内编辑卡冻结模型名\n\n根因与改法。",
        },
        status: "completed",
        raw: {},
      },
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
    }),
  );

  assert.match(markup, /行内编辑卡冻结模型名/);
  assert.match(markup, /执行计划/);
  // 成功态不出现通用失败行的徽标。
  assert.doesNotMatch(markup, /执行失败/);
});

test("定稿但无 overview 的历史行仍走全文预览，不套通用工具行", () => {
  const markup = renderContext(
    makeContext({
      toolCall: {
        toolId: "exit-plan-mode-render-test",
        toolName: "ExitPlanMode",
        kind: "ExitPlanMode",
        title: "ExitPlanMode",
        input: { plan: "# 历史计划\n\n没有 overview 的旧调用。" },
        status: "completed",
        raw: {},
      },
      onExecutePlan: () => undefined,
    }),
  );

  assert.match(markup, /历史计划/);
  assert.doesNotMatch(markup, /执行失败/);
});
