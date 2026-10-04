import assert from "node:assert/strict";
import test from "node:test";
import { buildContextUsageBreakdownSegments } from "../src/lib/contextUsageBreakdown.js";

test("来源明细：聚合同源字符量并按顶部 used 折算", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "messages", chars: 2_000 },
      { source: "system_tool_schemas", chars: 4_000 },
      { source: "messages", chars: 500 },
    ],
    41_300,
  );

  assert.deepEqual(
    segments.map((segment) => ({ source: segment.source, chars: segment.chars })),
    [
      { source: "messages", chars: 2_500 },
      { source: "system_tool_schemas", chars: 4_000 },
    ],
  );
  assert.equal(segments[0]?.percent, 2_500 / 6_500);
  // 折算值按整 token 取整：token 计数不存在小数，不取整会渲染成 `305.7` 这种虚假精度。
  assert.equal(segments[0]?.displayTokens, Math.round((41_300 * 2_500) / 6_500));
  assert.equal(segments[1]?.displayTokens, Math.round((41_300 * 4_000) / 6_500));
  assert.ok(segments.every((segment) => Number.isInteger(segment.displayTokens)));
  // 取整后合计不再严格等于 used，偏差上界为「来源数 ÷ 2」个 token。
  const allocatedTokens = segments.reduce((sum, segment) => sum + (segment.displayTokens ?? 0), 0);
  assert.ok(Math.abs(allocatedTokens - 41_300) <= segments.length / 2);
});

test("来源明细：折算值一律是整数 token，不带小数", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "system_tool_schemas", chars: 13_500 },
      { source: "messages", chars: 4_400 },
      { source: "mcp_tool_schemas", chars: 3_600 },
      { source: "system_prompt", chars: 1_300 },
      { source: "skills", chars: 306 },
      { source: "meta_user_context", chars: 50 },
    ],
    23_200,
  );

  assert.equal(segments.length, 6);
  assert.ok(segments.every((segment) => Number.isInteger(segment.displayTokens)));
  assert.ok(segments.every((segment) => (segment.displayTokens ?? 0) > 0));
});

test("来源明细：used 非法时只返回可展示百分比，不制造来源值", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "system_tool_schemas", chars: 4_000 },
      { source: "messages", chars: 2_000 },
    ],
    Number.NaN,
  );

  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => segment.displayTokens === null));
  assert.ok(segments.every((segment) => segment.percent > 0));
});

test("来源明细：没有有效字符量时不生成来源行", () => {
  assert.deepEqual(
    buildContextUsageBreakdownSegments(
      [
        { source: "messages", chars: 0 },
        { source: "system_prompt", chars: Number.NaN },
      ],
      41_300,
    ),
    [],
  );
});

test("来源明细：占比基准取加权 token 估算量，中文多的消息被放大、英文多的工具被压缩", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      // 字符数上消息占 1/3，但内容以中文为主，加权后应明显高于 1/3。
      { source: "messages", chars: 2_000, tokens: 1_180 },
      // 字符数上系统工具占 2/3，但内容以英文为主，加权后应明显低于 2/3。
      { source: "system_tool_schemas", chars: 4_000, tokens: 1_204 },
    ],
    41_300,
  );

  const bySource = new Map(segments.map((segment) => [segment.source, segment]));
  assert.equal(bySource.get("messages")?.percent, 1_180 / (1_180 + 1_204));
  assert.ok((bySource.get("messages")?.percent ?? 0) > 2_000 / 6_000);
  assert.ok((bySource.get("system_tool_schemas")?.percent ?? 1) < 4_000 / 6_000);
  // 字符量仍单独保留，供来源排序与字符量诊断使用。
  assert.equal(bySource.get("messages")?.chars, 2_000);
  assert.equal(bySource.get("system_tool_schemas")?.chars, 4_000);
});

test("来源明细：同源多条按 token 累加后才求占比", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "messages", chars: 1_000, tokens: 600 },
      { source: "messages", chars: 1_000, tokens: 600 },
      { source: "skills", chars: 1_000, tokens: 300 },
    ],
    30_000,
  );

  assert.equal(segments.length, 2);
  assert.equal(segments.find((segment) => segment.source === "messages")?.tokens, 1_200);
  assert.equal(segments.find((segment) => segment.source === "messages")?.percent, 1_200 / 1_500);
});

test("来源明细：部分条目缺 token 时整组回退按字符量，不混用两种量纲", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "messages", chars: 2_000, tokens: 1_180 },
      { source: "system_tool_schemas", chars: 4_000 },
    ],
    41_300,
  );

  // 整组回退：占比回到字符量口径，而不是拿 token 与字符混合相加。
  assert.equal(segments.find((segment) => segment.source === "messages")?.percent, 2_000 / 6_000);
  assert.equal(
    segments.find((segment) => segment.source === "system_tool_schemas")?.percent,
    4_000 / 6_000,
  );
});

test("来源明细：token 估算值非法时按缺缺失处理，整组回退字符量占比", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "messages", chars: 2_000, tokens: Number.NaN },
      { source: "system_tool_schemas", chars: 4_000, tokens: 0 },
    ],
    41_300,
  );

  assert.equal(segments.length, 2);
  assert.equal(segments.find((segment) => segment.source === "messages")?.percent, 2_000 / 6_000);
});

test("来源明细：全部条目缺 token 的历史事件走字符量回退，占比与改动前一致", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "system_tool_schemas", chars: 4_000 },
      { source: "messages", chars: 2_000 },
    ],
    41_300,
  );

  assert.equal(
    segments.find((segment) => segment.source === "system_tool_schemas")?.percent,
    4 / 6,
  );
  assert.equal(segments[0]?.displayTokens, Math.round((41_300 * 4_000) / 6_000));
});

test("来源明细：token 基准下折算值合计仍闭合到顶部 used", () => {
  const segments = buildContextUsageBreakdownSegments(
    [
      { source: "messages", chars: 2_000, tokens: 1_180 },
      { source: "system_tool_schemas", chars: 4_000, tokens: 1_204 },
      { source: "skills", chars: 500, tokens: 297 },
    ],
    41_300,
  );

  const allocatedTokens = segments.reduce((sum, segment) => sum + (segment.displayTokens ?? 0), 0);
  assert.ok(Math.abs(allocatedTokens - 41_300) <= segments.length / 2);
  assert.ok(segments.every((segment) => Number.isInteger(segment.displayTokens)));
});
