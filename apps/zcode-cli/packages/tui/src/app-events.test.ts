import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ContextUsage, Message, NetworkRequest } from "./app-model.js";
import { applySessionEventToState } from "./app-events.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import type { TodoItem } from "@zcode/contracts";

function applyModelComplete(payload: Record<string, unknown>, liveText: { value: string }): string {
  let status = "";
  const event = {
    id: "event-1",
    sessionId: "session-1",
    type: SessionEventType.ModelComplete,
    timestamp: new Date(),
    traceId: "trace-1",
    sequenceNumber: 1,
    payload,
  } as unknown as SessionEvent;
  applySessionEventToState(
    event,
    {
      setActiveTurnId: () => undefined,
      setCacheStats: () => undefined,
      setContextUsage: (action) => {
        if (typeof action === "function") liveContextUsage = action(liveContextUsage);
      },
      setLastError: () => undefined,
      setLiveModelText: (action) => {
        liveText.value = typeof action === "function" ? action(liveText.value) : action;
      },
      setMessages: (action) => {
        if (typeof action === "function") liveMessages = action(liveMessages);
      },
      setModel: () => undefined,
      setNetworkRequests: (action) => {
        if (typeof action === "function") liveNetworkRequests = action(liveNetworkRequests);
      },
      setStatus: (value) => {
        status = value;
      },
      setTodos: (action) => {
        if (typeof action === "function") liveTodos = action(liveTodos);
      },
      setUsage: () => undefined,
      assistantMessageIdsByToolCallId: new Map(),
      toolNamesById: new Map(),
    },
    DEFAULT_TUI_COPY,
  );
  return status;
}

test("ModelComplete 用 artifact 最终正文替换 TUI 流式文本", () => {
  const liveText = { value: "![图](attachment:generated-image)" };
  const status = applyModelComplete(
    {
      assistantMessageId: "assistant-1",
      content: "![图](zcode-artifact://image-1)",
      stopReason: "end_turn",
      usage: { outputTokens: 1 },
    },
    liveText,
  );
  assert.equal(liveText.value, "![图](zcode-artifact://image-1)");
  assert.notEqual(status, "");
});

test("没有 assistantMessageId 的旧 ModelComplete 不覆盖 TUI live 文本", () => {
  const liveText = { value: "当前流式消息" };
  applyModelComplete({ content: "sidecar 内容" }, liveText);
  assert.equal(liveText.value, "当前流式消息");
});

let liveContextUsage: ContextUsage = {} as ContextUsage;
let liveMessages: Message[] = [];
let liveNetworkRequests: NetworkRequest[] = [];
let liveTodos: TodoItem[] = [];
