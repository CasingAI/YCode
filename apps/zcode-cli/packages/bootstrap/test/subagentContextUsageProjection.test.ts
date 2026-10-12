import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 子会话用量水位回归（docs/specs/subagent-status-footer.md 生产侧要求）：
// 子会话 runtime 每轮结束发出 ModelComplete(querySource="subagent")，投影必须把
// usedTokens 写进事件所属子会话自己的快照 usage.contextWindow，否则子代理只读面板
// 底部的 SubagentStatusFooter 永远只能显示"上下文 --"占位。
// 隔离依据：每个会话有独立投影实例（gateway 按 sessionId 路由，子事件经 detached
// 通道进入子投影），父镜像只转发 ToolCall/Permission 类事件、不含 ModelComplete，
// 因此放开 subagent 分支不会污染父会话水位。

const T0 = 1_700_000_000_000;
const CHILD_SESSION_ID = "sess-subagent-usage-child";
const PARENT_SESSION_ID = "sess-subagent-usage-parent";

let seq = 0;
function makeEvent(
  sessionId: string,
  type: SessionEventType,
  payload: unknown,
  turnId: string,
): SessionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId,
    turnId,
    type,
    timestamp: new Date(T0 + seq),
    traceId: "trace-subagent-usage",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function modelSelected(sessionId: string, contextWindow?: number): SessionEvent {
  return makeEvent(
    sessionId,
    SessionEventType.ModelSelected,
    {
      modelSelection: { providerId: "glm", modelId: "glm-4.7" },
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    },
    "turn-1",
  );
}

function modelComplete(
  sessionId: string,
  querySource: string | undefined,
  usage: Record<string, number>,
  contextWindow?: number,
): SessionEvent {
  return makeEvent(
    sessionId,
    SessionEventType.ModelComplete,
    {
      content: "done",
      stopReason: "end_turn",
      toolCallCount: 0,
      usage,
      ...(querySource !== undefined ? { querySource } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    },
    "turn-1",
  );
}

test("子会话 ModelComplete(querySource=subagent) 把水位写进子会话自己的快照", () => {
  const child = new ProductProjection(CHILD_SESSION_ID, "epoch-1");
  child.applyEvent(modelSelected(CHILD_SESSION_ID, 200_000));
  child.applyEvent(
    modelComplete(CHILD_SESSION_ID, "subagent", { inputTokens: 8_000, outputTokens: 2_000 }),
  );

  const contextWindow = child.getSnapshot().usage.contextWindow;
  assert.ok(contextWindow, "子会话快照应有用量水位");
  assert.equal(contextWindow.usedTokens, 10_000);
  assert.equal(contextWindow.maxTokens, 200_000);
});

test("子会话事件不污染父会话水位：两实例相互隔离", () => {
  // 隔离由路由层保证：子事件按自身 sessionId 进入子投影（server-operations.ts
  // 按事件 sessionId 路由，父镜像只转发 ToolCall/Permission 类事件、不含
  // ModelComplete）。这里断言投影实例之间无共享状态：子实例写入不影响父实例。
  const parent = new ProductProjection(PARENT_SESSION_ID, "epoch-1");
  parent.applyEvent(modelSelected(PARENT_SESSION_ID, 200_000));
  parent.applyEvent(
    modelComplete(PARENT_SESSION_ID, "main_turn", { inputTokens: 4_000, outputTokens: 1_000 }),
  );

  const child = new ProductProjection(CHILD_SESSION_ID, "epoch-1");
  child.applyEvent(modelSelected(CHILD_SESSION_ID, 200_000));
  child.applyEvent(
    modelComplete(CHILD_SESSION_ID, "subagent", { inputTokens: 80_000, outputTokens: 20_000 }),
  );

  assert.equal(child.getSnapshot().usage.contextWindow?.usedTokens, 100_000);
  assert.equal(
    parent.getSnapshot().usage.contextWindow?.usedTokens,
    5_000,
    "父水位仍只由 main_turn 写入",
  );
});

test("主会话 main_turn 写入语义不变", () => {
  const parent = new ProductProjection(PARENT_SESSION_ID, "epoch-1");
  parent.applyEvent(modelSelected(PARENT_SESSION_ID, 200_000));
  parent.applyEvent(
    modelComplete(PARENT_SESSION_ID, "main_turn", { inputTokens: 4_000, outputTokens: 1_000 }),
  );

  const contextWindow = parent.getSnapshot().usage.contextWindow;
  assert.equal(contextWindow?.usedTokens, 5_000);
  assert.equal(contextWindow?.maxTokens, 200_000);
});

test("分母未知时保持未知：不伪造默认窗口", () => {
  const child = new ProductProjection(CHILD_SESSION_ID, "epoch-1");
  child.applyEvent(modelSelected(CHILD_SESSION_ID));
  child.applyEvent(
    modelComplete(CHILD_SESSION_ID, "subagent", { inputTokens: 8_000, outputTokens: 2_000 }),
  );

  assert.equal(
    child.getSnapshot().usage.contextWindow,
    null,
    "未知容量不得合成默认分母，footer 继续显示占位",
  );
});

test("tool_internal 等内部轮次仍不写入水位", () => {
  const child = new ProductProjection(CHILD_SESSION_ID, "epoch-1");
  child.applyEvent(modelSelected(CHILD_SESSION_ID, 200_000));
  child.applyEvent(
    modelComplete(CHILD_SESSION_ID, "tool_internal", {
      inputTokens: 8_000,
      outputTokens: 2_000,
    }),
  );

  // ModelSelected 已按模型能力写入分母（usedTokens 保持 0），tool_internal
  // 轮次不得推进水位：footer 门控 used<=0 时继续显示占位。
  // 精确断言分母与分子，区分「窗口为 null」与「窗口为 0」两种空态。
  const contextWindow = child.getSnapshot().usage.contextWindow;
  assert.ok(contextWindow, "ModelSelected 应已写入分母");
  assert.equal(contextWindow.maxTokens, 200_000);
  assert.equal(contextWindow.usedTokens, 0);
});
