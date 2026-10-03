// 续跑成功后的持久性（docs/specs/session-error-banner-continue.md §4.3「恢复必须持久」）。
//
// 失败的 assistant 消息是持久 carrier，同 turn 续跑不会删它，续跑产出排在其后。
// 若冷恢复见到失败消息就把整轮钉死成 failed，就会出现
// 「点继续 → 跑成功 → 重启 → 横幅又回来 → 再点继续」的死循环 —— 用户观感正是
// 「每次点的都是坏的」。这两条用例把两种终态都钉住：
//   A 末位仍是失败 → failed，横照常出现（这是我们要的初始状态）。
//   B 失败之后有成功产出 → completedSuccess，横幅不再回来。
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, MessageWithParts, SessionId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";

const SID = "sess-recovery-durability" as SessionId;
const USER_ID = "msg_user_1" as MessageId;

function userMessage(): MessageWithParts {
  return {
    info: { id: USER_ID, sessionID: SID, role: "user", time: { created: 1000 } },
    parts: [
      { id: "prt_u" as never, messageID: USER_ID, sessionID: SID, type: "text", text: "原始请求" },
    ],
  } as unknown as MessageWithParts;
}

function assistantMessage(
  id: string,
  options: { failed?: boolean; created: number },
): MessageWithParts {
  const messageId = id as MessageId;
  const info = {
    id: messageId,
    sessionID: SID,
    role: "assistant",
    parentID: USER_ID,
    modelId: "test-model",
    providerId: "test-provider",
    anchor: { turnId: "turn_runtime_1" },
    time: { created: options.created, completed: options.created + 100 },
    ...(options.failed
      ? {
          error: {
            name: "ModelError",
            data: { code: "model_rate_limited", message: "网络中断" },
          },
          finish: "error",
        }
      : { finish: "stop" }),
  };
  return {
    info,
    parts: [
      {
        id: `prt_${id}` as never,
        messageID: messageId,
        sessionID: SID,
        type: "text",
        text: `产出 ${id}`,
      },
    ],
  } as unknown as MessageWithParts;
}

function hydrate(messages: MessageWithParts[]): {
  lastHeader: TurnHeaderRow | undefined;
  lastError: unknown;
  turnErrorCount: number;
} {
  const events = synthesizeEventsFromMessages(messages, {
    sessionId: SID,
    contextWindow: 200_000,
  });
  const projection = new ProductProjection(SID, "epoch-durability");
  for (const event of events) projection.applyEvent(event);
  const rows = projection.snapshot.rows.window;
  const headers = rows.filter((row) => row?.kind === "turnHeader") as TurnHeaderRow[];
  return {
    lastHeader: headers.at(-1),
    lastError: (projection.snapshot.control as { lastError?: unknown }).lastError,
    turnErrorCount: events.filter((event) => event.type === SessionEventType.TurnError).length,
  };
}

test("末位仍是失败消息：判 failed，横幅照常出现（续跑前的初始状态）", () => {
  const result = hydrate([
    userMessage(),
    assistantMessage("msg_failed", { failed: true, created: 2000 }),
  ]);

  assert.equal(result.lastHeader?.state, "failed", "只有失败产出的轮次必须是 failed");
  assert.ok(result.lastError, "failed 必须带 lastError，否则横幅不出现");
  assert.equal(result.turnErrorCount, 1);
});

test("续跑成功后重启：失败 carrier 不盖住终态，判 completedSuccess 且横幅不再回来", () => {
  const result = hydrate([
    userMessage(),
    // 失败 carrier 仍在（续跑不删它）……
    assistantMessage("msg_failed", { failed: true, created: 2000 }),
    // ……但同 turn 后面已经跑出了成功产出。
    assistantMessage("msg_after_resume_1", { created: 3000 }),
    assistantMessage("msg_after_resume_2", { created: 4000 }),
  ]);

  assert.equal(
    result.lastHeader?.state,
    "completedSuccess",
    "失败消息之后的成功产出决定终态，否则重启后横幅会反复回来",
  );
  assert.equal(result.lastError, null, "续跑成功后 lastError 必须为空");
  assert.equal(result.turnErrorCount, 0, "不得为已恢复的轮次合成 TurnError");
});