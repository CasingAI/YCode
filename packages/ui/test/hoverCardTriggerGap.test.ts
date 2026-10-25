import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveContextPanelSideOffset } from "../src/components/ai-elements/context.js";

// 上下文用量浮层（composer 工具栏 + 子代理底栏）与触发器之间不能留命中空档：
// Radix HoverCard 在触发器 pointerleave 时直接关闭浮层，也没有 Popover 那样的安全多边形。
// 指针慢速移向面板时必经空档，浮层会在指针到达面板之前被关掉。
// 规则见 docs/specs/hover-card-trigger-gap.md。

const composerPanelSource = readFileSync(
  new URL("../src/chat-input-toolbar/contextUsage.tsx", import.meta.url),
  "utf8",
);
const subagentFooterSource = readFileSync(
  new URL("../src/v4/SubagentStatusFooter.tsx", import.meta.url),
  "utf8",
);

test("面板偏移：下沿压到触发图标上沿", () => {
  // 工具栏触发器 28px（Button size-7）、图标 14px → 偏移 -7。
  assert.equal(resolveContextPanelSideOffset(28), -7);
  // 底栏触发器 32px（h-8 w-8）、图标 14px → 偏移 -9。
  assert.equal(resolveContextPanelSideOffset(32), -9);
});

test("面板偏移不能为正：正偏移会留下命中空档", () => {
  // 偏移为正时面板下沿在触发器盒子上沿之外，中间那段空档两边都不属于触发器和面板。
  for (const triggerHeightPx of [28, 32]) {
    assert.ok(resolveContextPanelSideOffset(triggerHeightPx) <= 0);
  }
});

test("两处上下文浮层都用共享偏移计算", () => {
  assert.match(
    composerPanelSource,
    /sideOffset=\{resolveContextPanelSideOffset\(CONTEXT_TRIGGER_HEIGHT_PX\)\}/,
  );
  assert.match(
    subagentFooterSource,
    /sideOffset=\{resolveContextPanelSideOffset\(CONTEXT_TRIGGER_HEIGHT_PX\)\}/,
  );
  assert.doesNotMatch(composerPanelSource, /sideOffset=\{[1-9]/);
  assert.doesNotMatch(subagentFooterSource, /sideOffset=\{[1-9]/);
});

test("触发器高度常量与实际按钮尺寸一致", () => {
  // 高度常量决定图标上沿距按钮上沿的距离，改了按钮尺寸就要同步改它。
  assert.match(composerPanelSource, /const CONTEXT_TRIGGER_HEIGHT_PX = 28;/);
  assert.match(subagentFooterSource, /const CONTEXT_TRIGGER_HEIGHT_PX = 32;/);
});
