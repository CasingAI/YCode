import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_CHAT_TURN_INFO_DIALOG,
  TID_CHAT_TURN_INFO_MODELS,
  TID_CHAT_TURN_INFO_REASONING_DURATION,
  TID_CHAT_TURN_INFO_STATUS,
  TID_CHAT_TURN_INFO_TOOL_CALLS,
  TID_CHAT_TURN_INFO_TRIGGER,
  TID_CHAT_TURN_INFO_TURN_ID,
  TID_CHAT_TURN_INFO_WORK_DURATION,
  testId,
} from "@zcode/shared";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ConversationTurnInfoAction } from "../src/v4/ConversationTurnInfoAction.js";
import { ConversationTurnInfoContent } from "../src/v4/ConversationTurnInfoContent.js";
import type { ConversationTurnInfoFacts } from "../src/v4/conversationTurnInfo.js";
import type { ConversationTurnWorkSegment } from "../src/v4/conversationTurnWorkSegments.js";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function render(node: ReactNode, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ZCodeIntlProvider, { initialLocale: locale }, node),
    ),
  );
}

function makeSegment(
  patch: Partial<ConversationTurnWorkSegment> = {},
): ConversationTurnWorkSegment {
  return {
    key: "segment-1",
    flowItems: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantHistoryDefaultOpen: false,
    workStatus: { state: "completed", durationMs: 1_000 },
    ...patch,
  };
}

const FULL_FACTS: ConversationTurnInfoFacts = {
  executionModels: [
    { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
    { providerId: "provider-b", modelId: "gpt-6-luna" },
  ],
  workState: "running",
  durationMs: 0,
  toolCallCount: 0,
  reasoningDurationMs: 0,
  turnId: "turn/product-9",
};

test("内容列出全部执行供应商与模型 ID，并区分明确 0", () => {
  const markup = render(createElement(ConversationTurnInfoContent, { facts: FULL_FACTS }));

  assert.ok(markup.includes("cliproxy-codex"), "必须显示实际供应商 ID");
  assert.ok(markup.includes("provider-b"), "同一模型的另一供应商也必须保留");
  assert.equal(markup.match(/gpt-6-luna/g)?.length, 2, "同一模型 ID 来自两个供应商时列两项");
  assert.ok(markup.includes("turn/product-9"), "必须显示所属 product turn ID");
  assert.ok(markup.includes("工作中"), "必须显示运行状态");
  assert.ok(markup.includes("0 秒"), "明确 0 时长不能写成未知或 1 秒");

  for (const id of [
    TID_CHAT_TURN_INFO_MODELS,
    TID_CHAT_TURN_INFO_STATUS,
    TID_CHAT_TURN_INFO_WORK_DURATION,
    TID_CHAT_TURN_INFO_TOOL_CALLS,
    TID_CHAT_TURN_INFO_REASONING_DURATION,
    TID_CHAT_TURN_INFO_TURN_ID,
  ]) {
    assert.ok(markup.includes(id), `内容缺少 ${id}`);
  }
  assert.match(markup, /class="[^"]*break-all/, "长 ID 必须换行，不能撑破窄屏");
});

test("旧快照缺少执行模型与指标时全部显示未知", () => {
  const markup = render(
    createElement(ConversationTurnInfoContent, {
      facts: {
        executionModels: [],
        turnId: "",
        workState: undefined,
        durationMs: undefined,
        toolCallCount: undefined,
        reasoningDurationMs: undefined,
      },
    }),
  );

  assert.ok(!markup.includes("cliproxy"), "不得从其他来源补模型");
  assert.ok(
    (markup.match(/未知/g)?.length ?? 0) >= 6,
    "模型、状态、时长、工具、思考、turnId 都应是未知",
  );
});

test("英文界面不混入中文状态文案", () => {
  const markup = render(
    createElement(ConversationTurnInfoContent, {
      facts: { ...FULL_FACTS, workState: "interrupted" },
    }),
    "en-US",
  );

  assert.ok(markup.includes("Stopped"));
  assert.ok(markup.includes("0s"));
  assert.ok(!markup.includes("已停止"));
});

test("失败状态显示失败，不误报已完成", () => {
  const markup = render(
    createElement(ConversationTurnInfoContent, {
      facts: { ...FULL_FACTS, workState: "failed" },
    }),
  );
  assert.ok(markup.includes("失败"));
  assert.ok(!markup.includes("已完成"));
});

test("信息按钮常驻、可访问，关闭时不渲染弹窗内容", () => {
  const markup = render(
    createElement(ConversationTurnInfoAction, {
      segment: makeSegment({
        executionModels: [{ providerId: "cliproxy-codex", modelId: "gpt-6-luna" }],
      }),
      turnId: "turn-1",
    }),
  );

  assert.ok(markup.includes(testId(TID_CHAT_TURN_INFO_TRIGGER, "segment-1")));
  assert.ok(markup.includes('aria-label="回复信息"'), "按钮必须有可访问名称");
  assert.ok(markup.includes('aria-haspopup="dialog"'), "按钮必须由 DialogTrigger 提供对话框语义");
  assert.ok(!markup.includes(testId(TID_CHAT_TURN_INFO_DIALOG, "segment-1")));
  assert.ok(!markup.includes("cliproxy-codex"), "关闭状态不渲染只读内容");
});

test("信息按钮是折叠触发器的兄弟并靠右，turnId 经工作段窄 prop 透传", () => {
  const group = read("../src/v4/ConversationTurnGroup.tsx");
  const status = group.slice(
    group.indexOf("function AssistantHistoryStatus"),
    group.indexOf("function ConversationWorkSegmentFlow"),
  );

  assert.match(status, /turnId: string;/);
  const triggerEnd = status.indexOf("</CollapsibleTrigger>");
  const infoAction = status.indexOf("<ConversationTurnInfoAction");
  assert.ok(triggerEnd >= 0 && infoAction > triggerEnd, "信息按钮必须在折叠触发器之后");
  assert.match(status, /ml-auto[^"]*shrink-0|shrink-0[^"]*ml-auto/);
  assert.match(status, /min-w-0/, "触发器必须可收缩，长统计文本不能把按钮挤出");
  assert.match(group, /turnId=\{unit\.turnId\}/, "turnId 必须从 render unit 传入工作段");
  assert.match(
    group,
    /<AssistantHistoryStatus segment=\{segment\} open=\{open\} turnId=\{turnId\} \/>/,
  );
});

test("工作段投影透传 executionModels，分享页不新增信息入口", () => {
  const segments = read("../src/v4/conversationTurnWorkSegments.ts");
  assert.match(segments, /executionModels\?: readonly ExecutionModelIdentity\[\];/);
  assert.match(segments, /segmentFact\?\.executionModels !== undefined/);
  assert.match(segments, /executionModels: segmentFact\.executionModels/);

  const share = read("../src/v4/ConversationShareReadonlyTimeline.tsx");
  assert.ok(!share.includes("ConversationTurnInfoAction"));
  assert.ok(!share.includes("chat.turnInfo"));
});

test("UI 信息模块不读取 admission、marker、当前选择或快照配置", () => {
  for (const path of [
    "../src/v4/conversationTurnInfo.ts",
    "../src/v4/ConversationTurnInfoAction.tsx",
    "../src/v4/ConversationTurnInfoContent.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /admissionModelSelection/);
    assert.doesNotMatch(source, /modelChange/);
    assert.doesNotMatch(source, /modelSelectionView/);
    assert.doesNotMatch(source, /snapshot\.config/);
  }
});
