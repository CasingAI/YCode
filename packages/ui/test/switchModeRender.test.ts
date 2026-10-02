// 计划工具行的渲染回归：真失败时报错文本同时落在 output.text，
// 必须先拦截再取计划内容，否则报错被回收成正文、渲染出带可点「执行计划」的假计划卡。
// 计划批准拒绝到不了这条分支：桥接层已对它豁免失败标记（status=stopped、error 为空）。
// 背景见 docs/specs/plan-card-execute.md 的「失败判据必须先于内容分支执行」一条。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SwitchModeToolCallBlock } from "../src/ToolCallBlocks/renderers/switch-mode.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";

const INPUT_VALIDATION_ERROR = "Tool input failed inputSchema validation";

/**
 * 复刻 `toolCallRowToLegacyNode` 对失败计划工具行的真实产出：
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

test("通用拒绝失败行仍是带工具名的失败行（无豁免）", () => {
  const markup = renderContext(
    makeContext({
      toolCall: failedLegacyNode("denied", "Permission denied by project rule"),
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
      forceOpen: true,
    }),
  );

  assert.match(markup, /ExitPlanMode/);
  assert.match(markup, /Permission denied by project rule/);
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

test("端到端：plan_text 现场形状经桥接触发失败行，不渲染计划卡", () => {
  // 把桥接层产出与渲染层消费接上：v4 row 经 toolCallRowToLegacyNode 再渲染。
  // 现场形状 input 非空（title/overview 齐备、plan 缺失），桥接层必须保留失败标记，
  // 否则渲染层两道拦截（planToolCall 入口短路、switch-mode 失败优先）都到不了。
  const row = {
    rowId: 1,
    kind: "toolCall",
    createdAt: 1_700_000_000_000,
    turnId: "turn-1",
    toolCallId: "exit-plan-mode-render-test",
    toolName: "ExitPlanMode",
    status: "error",
    inputText: "",
    input: {
      title: "缓存验收",
      overview: "收口缓存验收清单，不改代码。",
      plan_text: "# 缓存验收\n正文",
    },
    error: {
      code: "tool_execution_failed",
      message: "Tool input failed inputSchema validation",
    },
  } as ToolCallRow;
  const node = toolCallRowToLegacyNode(row);
  const markup = renderContext(
    makeContext({
      toolCall: node.toolCall,
      onExecutePlan: () => undefined,
      onOpenPlanDetail: () => undefined,
    }),
  );

  assert.match(markup, /ExitPlanMode/);
  assert.match(markup, /执行失败/);
  assert.doesNotMatch(markup, /执行计划/);
  assert.doesNotMatch(markup, />查看</);
});

test("分发回归：现役 CreatePlan 与历史 ExitPlanMode 都拿到 switch-mode family", () => {
  // 场景：CreatePlan 曾在 shared 已知工具表、UI legacy token 两处都不认，family 落到
  // unknown → resolveRenderer 的 default 分支 → 通用 fallback 行（扳手 + PARAMETERS/RESULT）。
  // 断的是分发不是卡片本体：`switch-mode` family 分发到 SwitchModeToolCallBlock 是既有 case，
  // 这里锁住「新旧工具名都必须先拿到这个 family」，即卡片能被分发到的前提。
  // （resolveRenderer 本体不在这里直接断言：它 import 整张 renderer 表，会连带 .svg 资源，
  //   node:test 加载不了。）
  for (const toolName of ["CreatePlan", "ExitPlanMode"]) {
    assert.equal(resolveToolCallIdentity({ toolName }).family, "switch-mode");
    // 只读分享时间线等消费方用 kind 复用 toolName，判定同样要成立。
    assert.equal(resolveToolCallIdentity({ toolName, kind: toolName }).family, "switch-mode");
  }
});

test("分发回归：老投影的 plan kind/title 拼写仍被认领，非计划工具不受影响", () => {
  // 老会话把工具塞进 kind/title（工具名缺失或认不出），legacy 拼写是它们唯一的入口。
  for (const kind of ["switch_mode", "Exited Plan Mode", "exit_plan_mode"]) {
    assert.equal(resolveToolCallIdentity({ kind }).family, "switch-mode");
  }
  assert.equal(resolveToolCallIdentity({ toolName: "Bash" }).family, "shell");
  assert.equal(
    resolveToolCallIdentity({ toolName: "AskUserQuestion" }).family,
    "ask-user-question",
  );
});
