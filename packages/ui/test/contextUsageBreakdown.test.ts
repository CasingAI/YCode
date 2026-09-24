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
  assert.equal(segments[0]?.displayTokens, (41_300 * 2_500) / 6_500);
  assert.equal(segments[1]?.displayTokens, (41_300 * 4_000) / 6_500);
  const allocatedTokens = segments.reduce((sum, segment) => sum + (segment.displayTokens ?? 0), 0);
  assert.ok(Math.abs(allocatedTokens - 41_300) < 1e-9);
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
