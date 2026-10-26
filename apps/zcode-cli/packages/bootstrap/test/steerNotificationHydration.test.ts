import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, MessageWithParts, SessionEvent, SessionId } from "@zcode/contracts";
import type { AssistantTextRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// spec（docs/specs/model-only-steer-hydration.md）冷恢复轮归属守卫：
// live 里合流进活动轮的后台通知 / 子智能体回复（inputPresentation=*_steer），
// 冷恢复不得切成独立唤醒轮——重启前后时间线形态一致。
// 空闲唤醒（task_notification / subagent_reply）与缺 inputPresentation 的 legacy
// 数据维持现状：仍按 model-only 唤醒边界开轮。

const T0 = 1_700_000_000_000;
const SID = "sess-steer-notice-hydrate" as SessionId;
const USER_ID = "msg_user_1" as MessageId;

function userMessage(): MessageWithParts {
  return {
    info: { id: USER_ID, sessionID: SID, role: "user", time: { created: T0 + 500 } },
    parts: [
      {
        id: "prt_u" as never,
        messageID: USER_ID,
        sessionID: SID,
        type: "text",
        text: "继续排查 HDR 水面渲染",
      },
    ],
  } as unknown as MessageWithParts;
}

function assistantMessage(id: string, text: string, created: number): MessageWithParts {
  const messageId = id as MessageId;
  return {
    info: {
      id: messageId,
      sessionID: SID,
      role: "assistant",
      parentID: USER_ID,
      modelId: "test-model",
      providerId: "test-provider",
      anchor: { turnId: "turn_runtime_1" },
      time: { created, completed: created + 100 },
      finish: "stop",
    },
    parts: [
      {
        id: `prt_${id}` as never,
        messageID: messageId,
        sessionID: SID,
        type: "text",
        text,
      },
    ],
  } as unknown as MessageWithParts;
}

/**
 * 与 `persistSyntheticUserNoticeForSession` 落库形状同构的 model-only runtime 注入。
 * presentation 传 undefined 时模拟 legacy 数据（无 inputPresentation 字段）。
 */
function runtimeInjectionMessage(input: {
  id: string;
  source: "background_task" | "subagent_message";
  presentation:
    | "task_notification_steer"
    | "subagent_reply_steer"
    | "task_notification"
    | undefined;
  text: string;
  created: number;
  originMeta?: Record<string, unknown>;
}): MessageWithParts {
  const messageId = input.id as MessageId;
  const metadata: Record<string, unknown> = {
    ...(input.presentation ? { inputPresentation: input.presentation } : {}),
    ...(input.originMeta ? { originMeta: input.originMeta } : {}),
    source: input.source,
    visibility: "model-only",
  };
  return {
    info: {
      id: messageId,
      sessionID: SID,
      role: "user",
      time: { created: input.created },
      source: input.source,
      synthetic: true,
      visibility: "model-only",
      metadata,
      semantics: {
        origin: "agent_runtime",
        kind:
          input.source === "background_task" ? "background_notification" : "subagent_notification",
        source: input.source,
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    parts: [
      {
        id: `prt_${input.id}` as never,
        messageID: messageId,
        sessionID: SID,
        type: "text",
        text: input.text,
        metadata: { ...metadata },
      },
    ],
  } as unknown as MessageWithParts;
}

function hydrate(messages: MessageWithParts[]): ProductProjection {
  const projection = new ProductProjection(SID, "epoch-1");
  for (const event of synthesizeEventsFromMessages(messages, {
    sessionId: SID,
    baseTimestampMs: T0,
  }) as SessionEvent[]) {
    projection.applyEvent(event);
  }
  return projection;
}

function turnHeaders(projection: ProductProjection): TurnHeaderRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is TurnHeaderRow => row.kind === "turnHeader");
}

function assistantTexts(projection: ProductProjection): AssistantTextRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is AssistantTextRow => row.kind === "assistantText");
}

const MID_TURN_STEER_INPUT = [
  userMessage(),
  assistantMessage("a1", "先排查探针断言", T0 + 1_000),
  runtimeInjectionMessage({
    id: "notice-steer-1",
    source: "background_task",
    presentation: "task_notification_steer",
    text: "<task-notification>后台任务 work-1 已完成</task-notification>",
    created: T0 + 2_000,
    originMeta: {
      backgroundSource: "subagent",
      title: "定位地形探针断言和实际水面着色器路径",
      workId: "work-1",
    },
  }),
  assistantMessage("a2", "结合通知结论收尾", T0 + 3_000),
];

test("轮中间的 task_notification_steer：不切轮、无唤醒轮标题，前后产出同轮", () => {
  const projection = hydrate(MID_TURN_STEER_INPUT);

  const headers = turnHeaders(projection);
  assert.equal(headers.length, 1, "steer 注入不产生独立唤醒轮");
  assert.equal(headers[0]?.origin, "userInput", "唯一的轮仍是用户输入轮");
  assert.equal(headers[0]?.originMeta, undefined, "steer 注入的 originMeta 不上轮头");

  const texts = assistantTexts(projection);
  assert.equal(texts.length, 2, "通知前后的 assistant 正文都在");
  assert.equal(texts[0]?.text, "先排查探针断言");
  assert.equal(texts[1]?.text, "结合通知结论收尾");
  assert.equal(
    texts[0]?.turnId,
    texts[1]?.turnId,
    "两段产出归属同一轮（live 连续形态在冷恢复后保持）",
  );
});

test("空闲唤醒的 task_notification：仍切独立 backgroundResult 轮并回放 originMeta", () => {
  const projection = hydrate([
    userMessage(),
    assistantMessage("a1", "第一轮产出", T0 + 1_000),
    runtimeInjectionMessage({
      id: "notice-wake-1",
      source: "background_task",
      presentation: "task_notification",
      text: "<task-notification>后台任务 work-2 已完成</task-notification>",
      created: T0 + 3_000,
      originMeta: {
        backgroundSource: "subagent",
        title: "运行信息视图生成回归测试",
        workId: "work-2",
      },
    }),
    assistantMessage("a2", "唤醒轮产出", T0 + 4_000),
  ]);

  const headers = turnHeaders(projection);
  assert.equal(headers.length, 2, "空闲唤醒仍开独立轮");
  const wakeHeader = headers.find((header) => header.origin === "backgroundResult");
  assert.ok(wakeHeader, "唤醒轮 origin=backgroundResult");
  assert.equal(wakeHeader.originMeta?.title, "运行信息视图生成回归测试");
  assert.equal(wakeHeader.originMeta?.backgroundSource, "subagent");
  assert.equal(wakeHeader.originMeta?.workId, "work-2");
  assert.equal(
    assistantTexts(projection).find((row) => row.text === "唤醒轮产出")?.turnId,
    wakeHeader.turnId,
    "唤醒轮之后的产出归属唤醒轮",
  );
});

test("legacy 无 inputPresentation 的通知消息：回退现状，仍按边界切轮", () => {
  const projection = hydrate([
    userMessage(),
    assistantMessage("a1", "第一轮产出", T0 + 1_000),
    runtimeInjectionMessage({
      id: "notice-legacy-1",
      source: "background_task",
      presentation: undefined,
      text: "<task-notification>后台任务 work-3 已完成</task-notification>",
      created: T0 + 3_000,
      originMeta: {
        backgroundSource: "subagent",
        title: "旧数据任务",
        workId: "work-3",
      },
    }),
    assistantMessage("a2", "旧唤醒轮产出", T0 + 4_000),
  ]);

  const headers = turnHeaders(projection);
  assert.equal(headers.length, 2, "legacy 数据维持旧行为：通知仍是轮边界");
  assert.ok(
    headers.some((header) => header.origin === "backgroundResult"),
    "legacy 通知仍恢复为唤醒轮",
  );
});

test("subagent_reply_steer：与后台通知同款，轮中间不切轮", () => {
  const projection = hydrate([
    userMessage(),
    assistantMessage("a1", "先等子智能体回复", T0 + 1_000),
    runtimeInjectionMessage({
      id: "notice-subagent-steer-1",
      source: "subagent_message",
      presentation: "subagent_reply_steer",
      text: "<subagent-message>子智能体回复正文</subagent-message>",
      created: T0 + 2_000,
    }),
    assistantMessage("a2", "结合子智能体回复继续", T0 + 3_000),
  ]);

  const headers = turnHeaders(projection);
  assert.equal(headers.length, 1, "subagent_reply_steer 不切轮");
  assert.equal(headers[0]?.origin, "userInput");
  const texts = assistantTexts(projection);
  assert.equal(texts.length, 2);
  assert.equal(texts[0]?.turnId, texts[1]?.turnId, "两段产出归属同一轮");
});
