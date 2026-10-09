import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX,
  commandPayloadSchemas,
  commandResultSchema,
} from "../src/zcode-protocol-v4/command.js";

// 命令中心一次性 AI 历史搜索的协议面（docs/specs/command-center-ai-history-search.md）：
// 工作区级 start/cancel 命令与 start ACK 的 schema 收口。CLI 隐藏运行宿主落地前，
// UI 与 CLI 共用这份契约，避免两侧漂移。

test("startAiHistorySearch payload：workspaceId + 非空 query，language 可选", () => {
  const ok = commandPayloadSchemas.startAiHistorySearch.safeParse({
    workspaceId: "/tmp/proj",
    query: "上次改鉴权的结论",
  });
  assert.equal(ok.success, true);

  const withLanguage = commandPayloadSchemas.startAiHistorySearch.safeParse({
    workspaceId: "remote:ssh:host:/proj",
    query: "结论",
    language: "zh-CN",
  });
  assert.equal(withLanguage.success, true);

  assert.equal(
    commandPayloadSchemas.startAiHistorySearch.safeParse({ workspaceId: "/tmp", query: "   " })
      .success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.startAiHistorySearch.safeParse({ workspaceId: "", query: "结论" })
      .success,
    false,
  );
});

test("cancelAiHistorySearch payload：隐藏会话 id 必填", () => {
  assert.equal(
    commandPayloadSchemas.cancelAiHistorySearch.safeParse({ searchSessionId: "sess_ai_search_abc" })
      .success,
    true,
  );
  assert.equal(
    commandPayloadSchemas.cancelAiHistorySearch.safeParse({ searchSessionId: "" }).success,
    false,
  );
});

test("startAiHistorySearch ACK result：隐藏会话 id 供浮层订阅投影", () => {
  const ack = commandResultSchema.safeParse({
    type: "startAiHistorySearch",
    sessionId: "sess_ai_search_abc",
  });
  assert.equal(ack.success, true);
});

test("unsupported 失败码前缀常量非空且以 fault 命名空间开头", () => {
  assert.ok(AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX.startsWith("fault.command."));
});
