import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACT_NOW_TOOL_NAME,
  GET_CONTEXT_USAGE_TOOL_NAME,
  GetContextUsageOutputSchema,
  parseToolResultDisplayPayload,
} from "@zcode/contracts";
import { toolOutputSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  applyForcedAutoCompactDecision,
  buildSessionContextUsageSummary,
  shouldAutoCompact,
  type AutoCompactDecision,
} from "../src/compact/policy.js";
import { compactNowToolEntry } from "../src/tool/handlers/compact-now.js";
import { getContextUsageToolEntry } from "../src/tool/handlers/get-context-usage.js";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import { buildContextUsageBreakdownFromSnapshot } from "../src/runtime/methods/context-usage.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT_TOKENS = 32_000;

function decisionFor(tokenCount: number): AutoCompactDecision {
  return shouldAutoCompact({
    // 内容长度只负责过 hasEnoughMessagesToCompact 的最低门槛，
    // tokenCount 由 tokenOverride 直接给定，便于精确落在阈值两侧。
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ],
    config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
    tokenOverride: { source: "provider_usage", tokenCount },
  });
}

test("未到阈值时强制请求把结果翻转为压缩，且沿用压缩原因", () => {
  const below = decisionFor(1_000);
  assert.equal(below.shouldCompact, false);
  assert.equal(below.reason, "below_threshold");

  const forced = applyForcedAutoCompactDecision(below, true);
  assert.equal(forced.shouldCompact, true);
  assert.equal(forced.reason, "above_threshold");
  // 阈值与用量事实不被强制请求改写。
  assert.equal(forced.threshold, below.threshold);
  assert.equal(forced.tokenCount, below.tokenCount);
});

test("没有强制请求时决策原样返回", () => {
  const below = decisionFor(1_000);
  assert.deepEqual(applyForcedAutoCompactDecision(below, false), below);
});

test("安全闸不被强制请求越过：disabled / not_enough_messages / circuit_breaker", () => {
  const disabled = applyForcedAutoCompactDecision(
    {
      ...decisionFor(CONTEXT_WINDOW),
      shouldCompact: false,
      reason: "disabled",
    },
    true,
  );
  assert.equal(disabled.shouldCompact, false);

  const tooFewMessages = applyForcedAutoCompactDecision(
    shouldAutoCompact({
      messages: [{ role: "user", content: "only one" }],
      config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
    true,
  );
  assert.equal(tooFewMessages.reason, "not_enough_messages");
  assert.equal(tooFewMessages.shouldCompact, false);

  const tripped = applyForcedAutoCompactDecision(
    {
      ...decisionFor(CONTEXT_WINDOW),
      shouldCompact: false,
      reason: "circuit_breaker",
    },
    true,
  );
  assert.equal(tripped.shouldCompact, false);
});

test("已到阈值的决策在强制请求下保持同一结果", () => {
  const above = decisionFor(CONTEXT_WINDOW * 2);
  assert.equal(above.shouldCompact, true);
  assert.deepEqual(applyForcedAutoCompactDecision(above, true), above);
});

test("用量快照：剩余量基于 effective window，百分比互补且被夹在 [0,100]", () => {
  const summary = buildSessionContextUsageSummary({
    config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
    tokenCount: 60_000,
  });
  assert.equal(summary.contextWindowTokens, CONTEXT_WINDOW);
  assert.equal(summary.effectiveContextWindowTokens, CONTEXT_WINDOW - 21_000);
  assert.equal(summary.autocompactThresholdTokens, summary.effectiveContextWindowTokens - 13_000);
  assert.equal(summary.usedTokens, 60_000);
  assert.equal(summary.remainingTokens, summary.effectiveContextWindowTokens - summary.usedTokens);
  assert.equal(Math.round((summary.usedPercent + summary.remainingPercent) * 10) / 10, 100);
});

test("用量快照：超窗时剩余归零、已用百分比不超过 100", () => {
  const summary = buildSessionContextUsageSummary({
    config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
    tokenCount: CONTEXT_WINDOW * 3,
  });
  assert.equal(summary.usedTokens, CONTEXT_WINDOW);
  assert.equal(summary.remainingTokens, 0);
  assert.ok(summary.usedPercent <= 100);
  assert.ok(summary.remainingPercent >= 0);
});

test("上下文明细：snapshot 只投影来源字符量，不把 runtime token 估算值混入 UI 契约", () => {
  assert.deepEqual(
    buildContextUsageBreakdownFromSnapshot({
      categories: [
        { source: "system_tool_schemas", chars: 4_000, tokens: 1_024 },
        { source: "messages", chars: 2_000, tokens: 512 },
        { source: "skills", chars: 500 },
      ],
    }),
    [
      { source: "system_tool_schemas", chars: 4_000 },
      { source: "messages", chars: 2_000 },
      { source: "skills", chars: 500 },
    ],
  );
});

test("上下文明细：无效字符量不阻断其它来源投影", () => {
  assert.deepEqual(
    buildContextUsageBreakdownFromSnapshot({
      categories: [
        { source: "messages", chars: Number.NaN },
        { source: "system_prompt", chars: 2_000 },
      ],
    }),
    [{ source: "system_prompt", chars: 2_000 }],
  );
});

function fakeContext(port: ToolExecutionContext["sessionContextPort"]): ToolExecutionContext {
  return { sessionContextPort: port, toolCallId: "call_1" } as unknown as ToolExecutionContext;
}

test("CompactNow：handler 登记强制压缩并给出稳定回执", async () => {
  let requested = 0;
  const output = await compactNowToolEntry.handler(
    {},
    fakeContext({
      requestCompactNow: () => {
        requested += 1;
      },
      getContextUsage: () => {
        throw new Error("should not be called by CompactNow");
      },
    }),
  );
  assert.equal(requested, 1);
  assert.equal((output as { accepted: boolean }).accepted, true);
});

test("CompactNow / GetContextUsage：端口缺席时报 ConfigurationError，不返回假数据", async () => {
  await assert.rejects(
    () => compactNowToolEntry.handler({}, fakeContext(undefined)),
    /SessionContextPort is not configured/u,
  );
  await assert.rejects(
    () => getContextUsageToolEntry.handler({}, fakeContext(undefined)),
    /SessionContextPort is not configured/u,
  );
});

test("GetContextUsage：输出满足 schema，且 percent 字段来自同一份快照", async () => {
  const snapshot = {
    ...buildSessionContextUsageSummary({
      config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
      tokenCount: 12_345,
    }),
    tokenSource: "provider_usage" as const,
  };
  const output = await getContextUsageToolEntry.handler(
    {},
    fakeContext({
      requestCompactNow: () => {},
      getContextUsage: () => snapshot,
    }),
  );
  const parsed = GetContextUsageOutputSchema.parse(output);
  assert.equal(parsed.usedTokens, 12_345);
  assert.equal(parsed.remainingTokens, snapshot.remainingTokens);
  assert.equal(parsed.tokenSource, "provider_usage");
});

test("GetContextUsage：合法输出生成可持久化且协议可解析的专用 display", async () => {
  const snapshot = {
    ...buildSessionContextUsageSummary({
      config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
      tokenCount: 12_345,
    }),
    tokenSource: "estimate" as const,
  };
  const output = await getContextUsageToolEntry.handler(
    {},
    fakeContext({
      requestCompactNow: () => {},
      getContextUsage: () => snapshot,
    }),
  );
  const display = createToolResultDisplay(GET_CONTEXT_USAGE_TOOL_NAME, output);
  assert.deepEqual(display, { kind: "get_context_usage", ...snapshot });

  const persisted = parseToolResultDisplayPayload(JSON.parse(JSON.stringify(display)));
  assert.deepEqual(persisted, display);
  assert.equal(
    parseToolResultDisplayPayload({ ...display, unexpected: true }),
    undefined,
    "contracts strict display 必须拒绝未知字段",
  );

  const protocolOutput = toolOutputSchema.parse({
    text: JSON.stringify(output),
    display,
  });
  assert.deepEqual(protocolOutput.display, display);
});

test("GetContextUsage：无效输出或错误工具名不生成专用 display", () => {
  const snapshot = {
    ...buildSessionContextUsageSummary({
      config: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS },
      tokenCount: 12_345,
    }),
    tokenSource: "provider_usage" as const,
  };
  assert.equal(
    createToolResultDisplay(GET_CONTEXT_USAGE_TOOL_NAME, { ...snapshot, usedTokens: -1 }),
    undefined,
  );
  assert.equal(createToolResultDisplay("ReadSessionContext", snapshot), undefined);
});

test("两个工具的注册名与常量一致", () => {
  assert.equal(compactNowToolEntry.metadata.name, COMPACT_NOW_TOOL_NAME);
  assert.equal(getContextUsageToolEntry.metadata.name, GET_CONTEXT_USAGE_TOOL_NAME);
  assert.equal(getContextUsageToolEntry.metadata.readOnly, true);
  // CompactNow 重写会话历史，不能声明 readOnly；但也不需要审批（等价 /compact）。
  assert.equal(compactNowToolEntry.metadata.readOnly, false);
  assert.equal(compactNowToolEntry.metadata.needsApproval, false);
});
