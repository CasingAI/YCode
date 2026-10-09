import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX,
  aiHistorySearchHandlers,
  assertNotAiHistorySearchSession,
  V4AiHistorySearchSessionRestrictedCommandError,
} from "../src/zcode-protocol-v4/commands/handlers/ai-history-search.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";

// 命令中心一次性 AI 历史搜索（docs/specs/command-center-ai-history-search.md）：
// 宿主能力缺席时 start 明确失败（UI 显示「运行时不可用」，不冒充关键词结果）；
// cancel 无能力时幂等成功（无隐藏会话可回收）；隐藏会话拒绝改写类命令。

function startEnvelope(query = "上次改鉴权的结论") {
  return {
    commandId: "cmd-ai-search-1",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query },
    issuedAt: Date.now(),
  } as never;
}

function cancelEnvelope(searchSessionId = "sess_ai_search_abc") {
  return {
    commandId: "cmd-ai-search-cancel-1",
    // 工作区级命令：信封 sessionId 为 null，路由键在 payload.searchSessionId。
    sessionId: null,
    type: "cancelAiHistorySearch",
    payload: { searchSessionId },
    issuedAt: Date.now(),
  } as never;
}

test("startAiHistorySearch：宿主无能力时抛 unsupported 失败码", async () => {
  const host = { getRecord: () => undefined };
  await assert.rejects(
    () => aiHistorySearchHandlers.startAiHistorySearch(host as never, startEnvelope()),
    (error: unknown) =>
      error instanceof Error &&
      (error as { reasonCode?: string }).reasonCode ===
        `${AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX}unsupported`,
  );
});

test("startAiHistorySearch：宿主有能力时回隐藏会话 id", async () => {
  let seen: unknown;
  const host = {
    getRecord: () => undefined,
    startAiHistorySearch: async (input: unknown) => {
      seen = input;
      return { searchSessionId: "sess_ai_search_abc" };
    },
  };
  const result = await aiHistorySearchHandlers.startAiHistorySearch(host as never, startEnvelope());
  assert.deepEqual(result, { type: "startAiHistorySearch", sessionId: "sess_ai_search_abc" });
  assert.deepEqual(seen, {
    workspaceId: "/tmp/proj",
    query: "上次改鉴权的结论",
    sourceCommandId: "cmd-ai-search-1",
  });
});

test("cancelAiHistorySearch：宿主无能力时幂等成功", async () => {
  const host = { getRecord: () => undefined };
  const result = await aiHistorySearchHandlers.cancelAiHistorySearch(host as never, cancelEnvelope());
  assert.equal(result, undefined);
});

test("cancelAiHistorySearch：宿主有能力时透传隐藏会话 id", async () => {
  let seen: string | undefined;
  const host = {
    getRecord: () => undefined,
    cancelAiHistorySearch: async (searchSessionId: string) => {
      seen = searchSessionId;
    },
  };
  const result = await aiHistorySearchHandlers.cancelAiHistorySearch(host as never, cancelEnvelope());
  assert.equal(result, undefined);
  assert.equal(seen, "sess_ai_search_abc");
});

test("ai_history_search 会话拒绝改写类命令，普通会话放行", () => {
  const hiddenHost = {
    getRecord: (sessionId: string) =>
      sessionId === "sess_ai_search_abc" ? { taskType: "ai_history_search" } : undefined,
  } as never;
  assert.throws(
    () => assertNotAiHistorySearchSession(hiddenHost, "sess_ai_search_abc", "sendText"),
    V4AiHistorySearchSessionRestrictedCommandError,
  );

  const normalHost = {
    getRecord: () => ({ taskType: "interactive" }),
  } as never;
  assert.doesNotThrow(() => assertNotAiHistorySearchSession(normalHost, "sess_main", "sendText"));
  assert.doesNotThrow(() => assertNotAiHistorySearchSession(hiddenHost, null, "sendText"));
});

test("inbox：工作区级 AI 搜索命令（sessionId null）进入 admission，不判 sessionNotFound", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  // UI 实际发送的 start 信封：sessionId null + workspaceId/query payload。
  const started = await inbox.handle({
    commandId: "cmd-ai-search-inbox-1",
    clientId: "client-test",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query: "侧边栏改版" },
    issuedAt: Date.now(),
  });
  assert.equal(started.kind, "execute");
  if (started.kind === "execute") started.settle({ status: "accepted" });

  const cancelled = await inbox.handle({
    commandId: "cmd-ai-search-inbox-2",
    clientId: "client-test",
    sessionId: null,
    type: "cancelAiHistorySearch",
    payload: { searchSessionId: "sess_ai_search_abc" },
    issuedAt: Date.now(),
  });
  assert.equal(cancelled.kind, "execute");
  if (cancelled.kind === "execute") cancelled.settle({ status: "accepted" });
});

test("inbox：非工作区级命令仍拒绝空会话（sendText + sessionId null → sessionNotFound）", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  const outcome = await inbox.handle({
    commandId: "cmd-ai-search-inbox-3",
    clientId: "client-test",
    sessionId: null,
    type: "sendText",
    payload: { text: "hello" },
    issuedAt: Date.now(),
  });
  assert.equal(outcome.kind, "ack");
  if (outcome.kind === "ack") {
    assert.equal(outcome.ack.status, "rejected");
    assert.equal(outcome.ack.reasonCode, "proto.sessionNotFound");
  }
});

test("网关全链路：截图场景复现——start 空会话信封不再 sessionNotFound，正常 accepted", async () => {
  // 真实执行器 + 真实 ai-history-search handler，只把宿主能力换成测试替身。
  // 这条链路 = UI 发出的信封 → gateway.handleCommand → inbox → executor → handler。
  const executor = new V4CommandExecutor({
    getRecord: () => undefined,
    startAiHistorySearch: async () => ({ searchSessionId: "sess_ai_search_e2e" }),
  } as never);
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: () => false,
      emitWireFrame: () => {},
      executeCommand: (envelope, admission) => executor.execute(envelope, admission),
    } as never,
    { now: () => Date.now(), createLogEpoch: () => "ai-search-epoch" },
  );

  const ack = await gateway.handleCommand({
    commandId: "cmd-ai-search-gateway-1",
    clientId: "client-test",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query: "侧边栏改版" },
    issuedAt: Date.now(),
  });

  assert.notEqual(ack.reasonCode, "proto.sessionNotFound");
  assert.equal(ack.status, "accepted");
  assert.deepEqual(ack.result, {
    type: "startAiHistorySearch",
    sessionId: "sess_ai_search_e2e",
  });
});
