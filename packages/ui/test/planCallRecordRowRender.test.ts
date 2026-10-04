import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ConversationPlanCallRecordRow } from "../src/v4/ConversationTurnGroup.js";

// 脱流后的计划调用记录走 ToolLayout 出成一条平铺摘要行。摘要行是单行盒子：标题一旦
// 折行，行底的 border-b 分隔线就被顶下去，整段工作流跟着错位。
//
// 标题长度并不受约束——拿不到显式 title 时会回退到计划正文的首个非空行，那可能是一整段
// 话。所以截断不是装饰，是这条行必须自己兜住的边界；被截掉的全文由 title 交给悬停查看。

const LONG_TITLE = "model-io 日志改为无损归档，不再销毁诊断历史";
const LONG_BODY_LINE =
  "把 model-io 的日志从环形覆盖归档改成无损落盘，超过保留窗口的批次直接压缩而不是丢弃，保留窗口从三天延长到三十天。";
const SHORT_TITLE = "修复登录跳转";

function planRow(input: Record<string, unknown>): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "call-plan-record",
    toolName: "CreatePlan",
    status: "success",
    inputText: "",
    input,
  };
}

function renderPlanRow(input: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationPlanCallRecordRow, { row: planRow(input) }),
    ),
  );
}

function findTitleElement(markup: string, text: string): string {
  const match = new RegExp(`<span class="([^"]*)">${text}</span>`).exec(markup);
  assert.ok(match, `静态渲染结果中应包含标题节点：${text}`);
  return match[1] ?? "";
}

function findRowTitleAttribute(markup: string): string | undefined {
  return /class="group\/tool-summary[^"]*" title="([^"]*)"/.exec(markup)?.[1];
}

test("计划记录行的显式长标题收成单行省略号", () => {
  const markup = renderPlanRow({ title: LONG_TITLE });
  const classNames = findTitleElement(markup, LONG_TITLE).split(/\s+/);

  assert.ok(classNames.includes("min-w-0"), "缺 min-w-0 就压不下宽度，标题照样折行");
  assert.ok(classNames.includes("truncate"), "缺 truncate 就不是单行省略，而是继续折行");
});

test("计划记录行回退到正文首个非空行时同样单行", () => {
  // 没有 title 时标题来自 markdown 首行，那一行可以很长——这正是折行的真实来源。
  const markup = renderPlanRow({ plan: `# ${LONG_BODY_LINE}\n\n正文其余部分。` });
  const classNames = findTitleElement(markup, LONG_BODY_LINE).split(/\s+/);

  assert.ok(classNames.includes("min-w-0"));
  assert.ok(classNames.includes("truncate"));
});

test("计划记录行把完整标题交给 title，截断后仍可悬停查看", () => {
  assert.equal(findRowTitleAttribute(renderPlanRow({ title: LONG_TITLE })), LONG_TITLE);
});

test("短标题走同一条截断路径，不退回裸文本", () => {
  // 截断是无条件的容器行为，不按长度分叉；短标题只是永远用不到省略号而已。
  const classNames = findTitleElement(renderPlanRow({ title: SHORT_TITLE }), SHORT_TITLE).split(
    /\s+/,
  );

  assert.ok(classNames.includes("min-w-0"));
  assert.ok(classNames.includes("truncate"));
});
