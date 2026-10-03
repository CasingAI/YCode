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
